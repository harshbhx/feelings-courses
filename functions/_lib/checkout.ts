/**
 * Checkout: POST /api/order and POST /api/verify (functions/api/*.ts are thin wrappers around
 * handleOrder and handleVerify). Kept here so scripts/test-checkout.mjs can import it in Node.
 *
 * Trust rules:
 * - The browser only sends optional buyer details (name, phone, email) and, after paying, the ids
 *   Razorpay gave it. Amount, currency and course always come from src/data/course.ts.
 * - The enrollment cookie is issued only after Razorpay's signature checks out with the key secret
 *   and Razorpay's API confirms the payment, or, while the course is a demo, for a demo order or a
 *   Razorpay test payment id (mode "razorpay-test", see below: that one is NOT verified).
 * - Nothing about the buyer is stored: details go back to the browser for Razorpay's prefill, never
 *   into a database, a log or the order's notes.
 *
 * Modes, from env (the browser never picks one):
 * - RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET both set → "razorpay": a server-side order, then
 *   Razorpay's signature and its record of the payment. Test keys (rzp_test_…) only while
 *   course.demo; live keys (rzp_live_…) only once !course.demo, and then with ENROLL_SECRET.
 * - no Key Secret, course.demo, and a test Key ID (env RAZORPAY_KEY_ID = rzp_test_…, else the public
 *   RAZORPAY_TEST_KEY_ID committed in src/data/payments.ts) → "razorpay-test": Razorpay's real
 *   Checkout in Test Mode, without an order. Instagram's and Facebook's in-app browsers get the
 *   demo sheet instead (see handleOrder).
 * - no keys, course.demo, and no test Key ID → "demo": the built-in demo payment sheet.
 * - anything else (live keys in a demo, test keys or no keys on the live course, half-set keys)
 *   → payments are off with a 503 and a clear message. "razorpay-test" and "demo" never exist
 *   once course.demo is false.
 */

import { course } from "../../src/data/course.ts";
import { IN_APP_BROWSER, RAZORPAY_TEST_KEY_ID, USE_COMMITTED_TEST_KEY } from "../../src/data/payments.ts";
import { site } from "../../src/data/site.ts";
import { normalizePhone } from "../../src/shared/constants.ts";
import { randomHex } from "./crypto.ts";
import { error, json, methodNotAllowed, readForm, readJson, redirect, sameOrigin } from "./http.ts";
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

/**
 * Tests pass `demo` to try both states of the course, and `testKeyId` to try the modes with and
 * without a committed test Key ID ("" = none). The live handlers use course.demo and
 * RAZORPAY_TEST_KEY_ID.
 */
export interface CheckoutOptions {
  demo?: boolean;
  testKeyId?: string;
}

export type PaymentMode =
  | { kind: "razorpay"; keys: RazorpayKeys }
  | { kind: "razorpay-test"; keyId: string }
  | { kind: "demo" }
  | { kind: "off"; status: number; code: string; message: string };

const MAX_BODY_BYTES = 4096;
const DEMO_ORDER = /^demo_[0-9a-f]{24}$/;
const RZP_ORDER = /^order_[A-Za-z0-9]{1,40}$/;
const RZP_PAYMENT = /^pay_[A-Za-z0-9]{1,40}$/;
// The id Razorpay Checkout hands its handler: "pay_" and 14 letters or digits.
const RZP_TEST_PAYMENT = /^pay_[A-Za-z0-9]{14}$/;
const RZP_KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]+$/;
const RZP_TEST_KEY_ID = /^rzp_test_[A-Za-z0-9]+$/;
const SIGNATURE = /^[0-9a-f]{64}$/i;

// ---------- mode ----------

export function paymentMode(
  env: CheckoutEnv,
  demo: boolean = course.demo,
  testKeyId: string = USE_COMMITTED_TEST_KEY ? RAZORPAY_TEST_KEY_ID : "",
): PaymentMode {
  const keyId = env.RAZORPAY_KEY_ID?.trim() ?? "";
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim() ?? "";
  const off = (code: string, message: string): PaymentMode => ({ kind: "off", status: 503, code, message });
  const liveInDemo = () =>
    off(
      "live_keys_in_demo",
      "Live Razorpay keys are set while this course is still a demo, so payments are off. Use Test Mode keys until the course goes live.",
    );
  const halfSet = () =>
    off("payments_misconfigured", "Payments are paused: the Razorpay key id and key secret must both be set.");
  const notAKey = () =>
    off("payments_misconfigured", "Payments are paused: the Razorpay key id doesn't look like a Razorpay key.");

  // Both keys: the full flow (server-side order, then signature), exactly as before.
  if (keyId && keySecret) {
    if (!RZP_KEY_ID.test(keyId)) return notAKey();
    const live = keyId.startsWith("rzp_live_");
    if (live && demo) return liveInDemo();
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

  // A Key Secret without its Key Id is a half-set pair, demo or not.
  if (keySecret) return halfSet();

  // The live course needs both keys. Nothing below (test checkout, demo sheet) exists without a demo.
  if (!demo) {
    if (keyId) return halfSet();
    return off("payments_not_configured", "Payments are not set up yet. Please message us on WhatsApp to enroll.");
  }

  // Demo course, no Key Secret: Razorpay's test Checkout without an order, if a test Key ID exists.
  // A Key ID set in env wins over the committed one; a live one is refused, never swapped out.
  if (keyId) {
    if (!RZP_KEY_ID.test(keyId)) return notAKey();
    if (!RZP_TEST_KEY_ID.test(keyId)) return liveInDemo();
    return { kind: "razorpay-test", keyId };
  }
  const committed = testKeyId.trim();
  if (RZP_TEST_KEY_ID.test(committed)) return { kind: "razorpay-test", keyId: committed };
  return { kind: "demo" };
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

/** Razorpay Checkout's `prefill`, from the checked buyer details. */
function prefillFor({ name, phone, email }: Buyer): Record<string, string> {
  return { ...(name && { name }), ...(phone && { contact: phone }), ...(email && { email }) };
}

/** Indian mobiles become +91XXXXXXXXXX; other numbers must already start with + and a country code. */
export const normalisePhone: (value: string) => string | null = normalizePhone; // one definition: src/shared/constants.ts

// ---------- POST /api/order ----------

export async function handleOrder(request: Request, env: CheckoutEnv, options: CheckoutOptions = {}): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!sameOrigin(request)) return error(403, "cross_origin", "This request must come from the course site.");

  const mode = paymentMode(env, options.demo ?? course.demo, options.testKeyId);
  if (mode.kind === "off") {
    console.error(`order: ${mode.code}`);
    return error(mode.status, mode.code, mode.message);
  }

  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = parseBuyer(body.value);
  if (!parsed.ok) return json({ error: "invalid_details", message: "Please check your details.", fields: parsed.errors }, 400);

  // The only amount there is: course.ts. Whatever the browser sent (amount, price, currency…) is ignored.
  const { amount, currency } = course.price;
  const demoOrder = (extra: Record<string, string> = {}) =>
    json({ mode: "demo", orderId: `demo_${randomHex(12)}`, amount, currency, ...extra });

  if (mode.kind === "demo") return demoOrder();

  if (mode.kind === "razorpay-test") {
    // Instagram's and Facebook's in-app browsers can't show Checkout in a frame, and the way round
    // that (callback_url with redirect: true, as the "razorpay" mode does) isn't documented without
    // an order: Razorpay's Checkout options list order_id as mandatory. So there the buyer gets the
    // built-in demo sheet, with a note to open the page in Chrome for Razorpay's test checkout.
    if (IN_APP_BROWSER.test(request.headers.get("User-Agent") ?? "")) return demoOrder({ fallback: "in_app_browser" });
    // No order id: without a Key Secret the server can't create a Razorpay order. Checkout gets the
    // amount straight from here, and it is still only ever course.ts's.
    return json({
      mode: "razorpay-test",
      keyId: mode.keyId,
      amount,
      currency,
      name: site.name,
      description: course.title,
      prefill: prefillFor(parsed.buyer),
    });
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
    return json({
      mode: "razorpay",
      keyId: mode.keys.keyId,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      name: site.name,
      description: course.title,
      prefill: prefillFor(parsed.buyer),
    });
  } catch (err) {
    console.error(`order: ${err instanceof Error ? err.message : "unknown error"}`);
    return error(502, "razorpay_unavailable", "We couldn't reach the payment service. Please try again in a minute.");
  }
}

// ---------- POST /api/verify ----------

export async function handleVerify(request: Request, env: CheckoutEnv, options: CheckoutOptions = {}): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  const demo = options.demo ?? course.demo;
  const mode = paymentMode(env, demo, options.testKeyId);
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();

  // Razorpay's callback_url flow: in Instagram's and Facebook's in-app browsers Checkout can't run in
  // a frame, so Razorpay posts the result here as a form and the buyer follows our redirect.
  // "razorpay" mode only: "razorpay-test" sends in-app browsers to the demo sheet instead.
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    if (mode.kind !== "razorpay") return redirect(request, "/payment-failed");
    const form = await readForm(request, MAX_BODY_BYTES);
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
  const body = await readJson(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const input = body.value;

  // Demo payment: only while the course is a demo and no Key Secret is set ("demo" mode, or the
  // in-app browser fallback of "razorpay-test").
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

  // Razorpay's test Checkout without an order ("razorpay-test" mode).
  //
  // NOT VERIFIED: without a Key Secret the server can neither check a signature (there is none
  // without an order) nor ask Razorpay's API about the payment, so any well-formed payment id is
  // taken at its word. Someone could type one in and get the demo course for free. That is
  // acceptable only for the demo: the demo sheet unlocks it for free anyway, and Test Mode moves no
  // money. It is never possible once course.demo is false or a Key Secret is set (then the
  // "razorpay" mode checks the signature and Razorpay's record).
  if (input.mode === "razorpay-test") {
    if (mode.kind === "off") return error(mode.status, mode.code, mode.message);
    if (mode.kind !== "razorpay-test" || !demo || env.RAZORPAY_KEY_SECRET?.trim()) {
      return error(403, "test_checkout_disabled", "Test payments without a Razorpay order are switched off here.");
    }
    const paymentId = input.razorpay_payment_id;
    if (typeof paymentId !== "string" || !RZP_TEST_PAYMENT.test(paymentId)) {
      return error(400, "invalid_payment", "The payment details are incomplete.");
    }
    try {
      const cookie = await issueEnrollment(env, newEnrollment(paymentId));
      return json({ ok: true, redirect: "/thank-you" }, 200, { "Set-Cookie": cookie });
    } catch (err) {
      console.error(`verify: ${err instanceof Error ? err.message : "unknown error"}`);
      return error(503, "enroll_unavailable", "We couldn't open your course yet. Please message us on WhatsApp.");
    }
  }

  if (mode.kind === "off") return error(mode.status, mode.code, mode.message);
  if (mode.kind === "demo" || mode.kind === "razorpay-test") {
    return error(400, "razorpay_not_configured", "Razorpay's key secret isn't set here, so this payment can't be checked.");
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
