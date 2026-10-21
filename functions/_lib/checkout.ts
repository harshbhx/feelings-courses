/**
 * Checkout: POST /api/order and POST /api/verify (functions/api/*.ts are thin wrappers around
 * handleOrder and handleVerify). Kept here so scripts/test-checkout.mjs can import it in Node.
 *
 * Trust rules:
 * - The browser only sends optional buyer details (name, phone, email) and, after paying, the ids
 *   Razorpay gave it. Amount, currency and course always come from src/data/course.ts.
 * - The enrollment cookie is issued only after Razorpay's signature checks out with the key secret
 *   and Razorpay's API confirms the payment, or, in demo mode, for a demo order.
 * - Nothing about the buyer is stored: details go back to the browser for Razorpay's prefill, never
 *   into a database, a log or the order's notes.
 *
 * Modes, from env:
 * - no Razorpay keys and course.demo → "demo": the built-in demo payment sheet, no money involved.
 * - test keys (rzp_test_…) and course.demo → "razorpay" in test mode.
 * - live keys (rzp_live_…) and !course.demo, with ENROLL_SECRET → "razorpay" live.
 * - anything else (live keys in a demo, test keys or no keys on the live course, half-set keys)
 *   → payments are off with a 503 and a clear message.
 */

import { course } from "../../src/data/course.ts";
import { site } from "../../src/data/site.ts";
import { randomHex } from "./crypto.ts";
import { issueEnrollment, newEnrollment } from "./enrollment.ts";
import type { EnrollEnv } from "./enrollment.ts";
import {
  RazorpayError,
  createRazorpayOrder,
  fetchRazorpayPayment,
  verifyRazorpaySignature,
} from "./razorpay.ts";
import type { RazorpayKeys } from "./razorpay.ts";

export interface CheckoutEnv extends EnrollEnv {
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
}

/** Tests pass `demo` to try both states of the course; the live handlers use course.demo. */
export interface CheckoutOptions {
  demo?: boolean;
}

export type PaymentMode =
  | { kind: "razorpay"; keys: RazorpayKeys }
  | { kind: "demo" }
  | { kind: "off"; status: number; code: string; message: string };

const MAX_BODY_BYTES = 4096;
const DEMO_ORDER = /^demo_[0-9a-f]{24}$/;
const RZP_ORDER = /^order_[A-Za-z0-9]{1,40}$/;
const RZP_PAYMENT = /^pay_[A-Za-z0-9]{1,40}$/;
const SIGNATURE = /^[0-9a-f]{64}$/i;

// ---------- mode ----------

export function paymentMode(env: CheckoutEnv, demo: boolean = course.demo): PaymentMode {
  const keyId = env.RAZORPAY_KEY_ID?.trim() ?? "";
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim() ?? "";
  const off = (code: string, message: string): PaymentMode => ({ kind: "off", status: 503, code, message });

  if (!keyId && !keySecret) {
    if (demo) return { kind: "demo" };
    return off("payments_not_configured", "Payments are not set up yet. Please message us on WhatsApp to enroll.");
  }
  if (!keyId || !keySecret) {
    return off("payments_misconfigured", "Payments are paused: the Razorpay key id and key secret must both be set.");
  }
  if (!/^rzp_(test|live)_[A-Za-z0-9]+$/.test(keyId)) {
    return off("payments_misconfigured", "Payments are paused: the Razorpay key id doesn't look like a Razorpay key.");
  }
  const live = keyId.startsWith("rzp_live_");
  if (live && demo) {
    return off(
      "live_keys_in_demo",
      "Live Razorpay keys are set while this course is still a demo, so payments are off. Use Test Mode keys until the course goes live.",
    );
  }
  if (!live && !demo) {
    return off(
      "test_keys_on_live",
      "Test Mode Razorpay keys are set on the live course, so payments are off: test payments would unlock the course for free.",
    );
  }
  if (!demo && !env.ENROLL_SECRET?.trim()) {
    return off("enroll_secret_missing", "Payments are paused: ENROLL_SECRET must be set before the course takes real payments.");
  }
  return { kind: "razorpay", keys: { keyId, keySecret } };
}

// ---------- buyer details ----------

export interface Buyer {
  name?: string;
  phone?: string;
  email?: string;
}

export type BuyerResult = { ok: true; buyer: Buyer } | { ok: false; errors: Partial<Record<keyof Buyer, string>> };

/** Validates and tidies the optional buyer details. Every other field in `input` is ignored. */
export function parseBuyer(input: unknown): BuyerResult {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const buyer: Buyer = {};
  const errors: Partial<Record<keyof Buyer, string>> = {};

  const text = (key: keyof Buyer): string | undefined => {
    const value = source[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") {
      errors[key] = "Must be text.";
      return undefined;
    }
    const tidy = value.normalize("NFC").replace(/\s+/g, " ").trim();
    return tidy === "" ? undefined : tidy;
  };

  const name = text("name");
  if (name !== undefined) {
    if (name.length < 2 || name.length > 80 || !/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u.test(name)) {
      errors.name = "Enter your name using letters only.";
    } else buyer.name = name;
  }

  const phone = text("phone");
  if (phone !== undefined) {
    const normalised = normalisePhone(phone);
    if (normalised) buyer.phone = normalised;
    else errors.phone = "Enter a 10-digit mobile number.";
  }

  const email = text("email");
  if (email !== undefined) {
    if (email.length > 254 || !/^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}$/.test(email)) {
      errors.email = "Enter an email like name@example.com, or leave it empty.";
    } else buyer.email = email;
  }

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, buyer };
}

/** Indian mobiles become +91XXXXXXXXXX; other numbers must already start with + and a country code. */
export function normalisePhone(value: string): string | null {
  const compact = value.replace(/[\s().-]/g, "");
  const indian = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(compact);
  if (indian) return `+91${indian[1]}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact) && !compact.startsWith("+91")) return compact;
  return null;
}

// ---------- POST /api/order ----------

export async function handleOrder(request: Request, env: CheckoutEnv, options: CheckoutOptions = {}): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!sameOrigin(request)) return error(403, "cross_origin", "This request must come from the course site.");

  const mode = paymentMode(env, options.demo ?? course.demo);
  if (mode.kind === "off") {
    console.error(`order: ${mode.code}`);
    return error(mode.status, mode.code, mode.message);
  }

  const body = await readJson(request);
  if (!body.ok) return body.response;
  const parsed = parseBuyer(body.value);
  if (!parsed.ok) return json({ error: "invalid_details", message: "Please check your details.", fields: parsed.errors }, 400);

  // The only amount there is: course.ts. Whatever the browser sent (amount, price, currency…) is ignored.
  const { amount, currency } = course.price;

  if (mode.kind === "demo") {
    return json({ mode: "demo", orderId: `demo_${randomHex(12)}`, amount, currency });
  }

  try {
    const order = await createRazorpayOrder(mode.keys, {
      amount,
      currency,
      receipt: `fbc_${Date.now().toString(36)}_${randomHex(4)}`,
      notes: { course: course.slug },
    });
    if (order.amount !== amount || order.currency !== currency) {
      console.error("order: Razorpay created an order for a different amount", order.id);
      return error(502, "order_mismatch", "We couldn't start the payment. Please try again.");
    }
    const { name, phone, email } = parsed.buyer;
    return json({
      mode: "razorpay",
      keyId: mode.keys.keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      name: site.name,
      description: course.title,
      prefill: { ...(name && { name }), ...(phone && { contact: phone }), ...(email && { email }) },
    });
  } catch (err) {
    console.error(`order: ${err instanceof Error ? err.message : "unknown error"}`);
    return error(502, "razorpay_unavailable", "We couldn't reach the payment service. Please try again in a minute.");
  }
}

// ---------- POST /api/verify ----------

export async function handleVerify(request: Request, env: CheckoutEnv, options: CheckoutOptions = {}): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const mode = paymentMode(env, options.demo ?? course.demo);
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();

  // Razorpay's callback_url flow: in Instagram's and Facebook's in-app browsers Checkout can't run in
  // a frame, so Razorpay posts the result here as a form and the buyer follows our redirect.
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    if (mode.kind !== "razorpay") return redirect(request, "/payment-failed");
    const form = await readForm(request);
    if (!form) return redirect(request, "/payment-failed");
    const result = await confirmRazorpay(env, mode.keys, {
      orderId: form.get("razorpay_order_id") ?? "",
      paymentId: form.get("razorpay_payment_id") ?? "",
      signature: form.get("razorpay_signature") ?? "",
    });
    if (!result.ok) return redirect(request, "/payment-failed");
    return redirect(request, "/thank-you", result.cookie);
  }

  if (!sameOrigin(request)) return error(403, "cross_origin", "This request must come from the course site.");
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const input = body.value;

  // Demo payment: only while no Razorpay keys exist and the course is a demo.
  if (input.demo_order_id !== undefined) {
    if (mode.kind === "razorpay") {
      return error(403, "demo_disabled", "Demo payments are switched off because Razorpay keys are set.");
    }
    if (mode.kind === "off") return error(mode.status, mode.code, mode.message);
    const orderId = input.demo_order_id;
    if (typeof orderId !== "string" || !DEMO_ORDER.test(orderId)) {
      return error(400, "invalid_order", "That demo order isn't valid. Please start again.");
    }
    const cookie = await issueEnrollment(env, newEnrollment(orderId));
    return json({ ok: true, redirect: "/thank-you" }, 200, { "Set-Cookie": cookie });
  }

  if (mode.kind === "off") return error(mode.status, mode.code, mode.message);
  if (mode.kind === "demo") {
    return error(400, "razorpay_not_configured", "Razorpay isn't set up here, so this payment can't be checked.");
  }

  const result = await confirmRazorpay(env, mode.keys, {
    orderId: input.razorpay_order_id,
    paymentId: input.razorpay_payment_id,
    signature: input.razorpay_signature,
  });
  if (!result.ok) return error(result.status, result.code, result.message);
  return json({ ok: true, redirect: "/thank-you" }, 200, { "Set-Cookie": result.cookie });
}

type Confirmed = { ok: true; cookie: string } | { ok: false; status: number; code: string; message: string };

/** Signature first (offline, cheap), then Razorpay's own record of the payment, then the cookie. */
async function confirmRazorpay(
  env: CheckoutEnv,
  keys: RazorpayKeys,
  ids: { orderId: unknown; paymentId: unknown; signature: unknown },
): Promise<Confirmed> {
  const { orderId, paymentId, signature } = ids;
  if (
    typeof orderId !== "string" || !RZP_ORDER.test(orderId) ||
    typeof paymentId !== "string" || !RZP_PAYMENT.test(paymentId) ||
    typeof signature !== "string" || !SIGNATURE.test(signature)
  ) {
    return { ok: false, status: 400, code: "invalid_payment", message: "The payment details are incomplete." };
  }

  if (!(await verifyRazorpaySignature(orderId, paymentId, signature, keys.keySecret))) {
    console.error(`verify: bad signature for ${orderId} / ${paymentId}`);
    return { ok: false, status: 400, code: "signature_invalid", message: "We couldn't verify this payment." };
  }

  let payment;
  try {
    payment = await fetchRazorpayPayment(keys, paymentId);
  } catch (err) {
    console.error(`verify: ${err instanceof Error ? err.message : "unknown error"}`);
    const status = err instanceof RazorpayError && err.status === 0 ? 504 : 502;
    return {
      ok: false,
      status,
      code: "razorpay_unavailable",
      message: "Your payment went through, but we couldn't confirm it yet. Please try again in a moment.",
    };
  }

  const confirmed =
    payment.id === paymentId &&
    payment.order_id === orderId &&
    (payment.status === "captured" || payment.status === "authorized") &&
    payment.amount === course.price.amount &&
    payment.currency === course.price.currency;
  if (!confirmed) {
    console.error(`verify: payment ${paymentId} not confirmed (status ${payment.status}, amount ${payment.amount})`);
    return { ok: false, status: 400, code: "payment_not_confirmed", message: "This payment isn't complete for this course." };
  }

  try {
    return { ok: true, cookie: await issueEnrollment(env, newEnrollment(paymentId)) };
  } catch (err) {
    console.error(`verify: ${err instanceof Error ? err.message : "unknown error"}`);
    return { ok: false, status: 503, code: "enroll_unavailable", message: "We couldn't open your course yet. Please message us on WhatsApp." };
  }
}

// ---------- HTTP helpers ----------

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function error(status: number, code: string, message: string): Response {
  return json({ error: code, message }, status);
}

function methodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed", message: "Use POST." }), {
    status: 405,
    headers: { Allow: "POST", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function redirect(request: Request, path: string, cookie?: string): Response {
  const headers = new Headers({ Location: new URL(path, request.url).href, "Cache-Control": "no-store" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/** A browser always sends Origin on a cross-site POST; when it's there it must be this site. */
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > MAX_BODY_BYTES ? null : text;
}

type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

async function readJson(request: Request): Promise<JsonBody> {
  const text = await readBody(request);
  if (text === null) return { ok: false, response: error(413, "too_large", "That request is too large.") };
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value };
  } catch {
    /* falls through */
  }
  return { ok: false, response: error(400, "invalid_json", "The request body must be a JSON object.") };
}

async function readForm(request: Request): Promise<URLSearchParams | null> {
  const text = await readBody(request);
  return text === null ? null : new URLSearchParams(text);
}
