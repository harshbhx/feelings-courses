/**
 * Restore access on a new device (plan 1.4): the student types the phone number or email they
 * paid with and the Razorpay payment ID from their receipt ("pay_…"). When both belong to one
 * paid order, they get a new session (the device limit then applies).
 *
 * Security:
 * - Rate limits counted before anything is looked up: per IP (RATE_LIMITS.restore_ip), per contact
 *   and per payment ID (restore_contact, both hashed so no contact detail sits in rate_limits).
 * - No enumeration: an unknown payment, an unknown contact, a contact that doesn't match, a
 *   refunded order and an erased student all give the same answer, "no_match".
 * - Constant-time compares: the typed contact is hashed and compared with timingSafeEqual against
 *   every contact on file for the order (the student's phone and email, and what the buyer typed
 *   into Razorpay), always the same number of compares.
 * - The payment is checked against the stored order (orders.razorpay_payment_id, written only
 *   after Razorpay's signature or webhook was verified). Fallback for a payment D1 hasn't
 *   recorded (the browser closed before verify and the webhook is late): Razorpay's own record of
 *   the payment is fetched with the server's keys, must be captured, for the order's exact amount,
 *   and is then fulfilled through W2's fulfilOrder (idempotent with verify and the webhook).
 */
import type { RazorpayPayment } from "../../src/shared/types.ts";
import { config, ConfigError, razorpayMode, requireSecret, type RateLimitName } from "./config.ts";
import { sha256Hex, timingSafeEqual } from "./crypto.ts";
import { unixNow, type Db } from "./db/d1.ts";
import { ValidationError } from "./db/errors.ts";
import * as v from "./db/validate.ts";
import type { Env } from "./env.ts";
import { clientIp } from "./http.ts";
import { fulfilOrder } from "./orders.ts";
import { hit } from "./ratelimit.ts";
import { fetchRazorpayPayment, RazorpayError } from "./razorpay.ts";
import { NotImplementedError } from "./stub.ts";

/** A Razorpay payment id as printed on the receipt: "pay_" and 8 to 40 letters or digits. */
export const PAYMENT_ID_RE = /^pay_[A-Za-z0-9]{8,40}$/;

export type RestoreResult =
  | { ok: true; studentId: number; orderId: number; via: "order" | "razorpay" }
  | { ok: false; reason: "rate_limited"; retryAfter: number }
  | { ok: false; reason: "no_match" };

export interface RestoreInput {
  contact: string;
  paymentId: string;
}

/** The typed contact as stored: an email (lowercased) or a phone number (E.164). */
export function normalizeContact(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError("contact", "Enter the phone number or email you paid with.");
  }
  if (value.includes("@")) return v.email(value, "contact");
  try {
    return v.phone(value, "contact");
  } catch {
    throw new ValidationError("contact", "Enter a 10-digit mobile number, or the email you paid with.");
  }
}

/** The payment ID, trimmed. Throws ValidationError when it can't be a Razorpay payment id. */
export function normalizePaymentId(value: unknown): string {
  const tidy = typeof value === "string" ? value.trim() : "";
  if (!PAYMENT_ID_RE.test(tidy)) {
    throw new ValidationError("paymentId", 'Enter the payment ID from your receipt. It starts with "pay_".');
  }
  return tidy;
}

/** A stored contact in the same form as normalizeContact, or null when it can't be read. */
function storedContact(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return normalizeContact(value);
  } catch {
    return null;
  }
}

/** Number of contact slots compared for every attempt (dummies fill empty ones). */
const SLOTS = 4;

/** True when `typed` equals one of `candidates`. Hash-then-compare, constant time, always SLOTS compares. */
export async function contactMatches(typed: string, candidates: readonly (string | null | undefined)[]): Promise<boolean> {
  const want = await sha256Hex(`contact:${typed}`);
  let match = false;
  for (let i = 0; i < SLOTS; i++) {
    const candidate = storedContact(candidates[i]);
    // An empty slot compares against a value that can't match, so the work is the same.
    const have = await sha256Hex(candidate === null ? `empty:${i}:${want}` : `contact:${candidate}`);
    match = timingSafeEqual(want, have) || match;
  }
  return match;
}

async function limited(db: Db, rules: [RateLimitName, string][], now: number): Promise<number | null> {
  let retryAfter = 0;
  for (const [rule, subject] of rules) {
    const result = await hit(db, rule, subject, { now });
    if (!result.allowed) retryAfter = Math.max(retryAfter, result.retryAfter);
  }
  return retryAfter > 0 ? retryAfter : null;
}

interface StoredOrder {
  id: number;
  student_id: number;
  status: string;
  phone: string | null;
  email: string | null;
  payer_contact: string | null;
  payer_email: string | null;
}

/**
 * Checks a restore attempt. Throws ValidationError for input that can't be a phone, email or
 * payment ID (a format error says nothing about anyone's account).
 */
export async function restoreAccess(
  env: Env,
  request: Request,
  body: Record<string, unknown>,
  now = unixNow(),
): Promise<RestoreResult> {
  const db = env.DB;
  // The IP counts every attempt, even malformed ones.
  const ipWait = await limited(db, [["restore_ip", clientIp(request)]], now);
  if (ipWait !== null) return { ok: false, reason: "rate_limited", retryAfter: ipWait };

  const contact = normalizeContact(body.contact);
  const paymentId = normalizePaymentId(body.paymentId);
  const wait = await limited(
    db,
    [
      ["restore_contact", await sha256Hex(`restore:${contact}`)],
      ["restore_contact", await sha256Hex(`restore:${paymentId}`)],
    ],
    now,
  );
  if (wait !== null) return { ok: false, reason: "rate_limited", retryAfter: wait };

  const order = await db
    .prepare(
      "SELECT o.id, o.student_id, o.status, s.phone, s.email, o.payer_contact, o.payer_email " +
        "FROM orders o JOIN students s ON s.id = o.student_id WHERE o.razorpay_payment_id = ? AND s.erased_at IS NULL",
    )
    .bind(paymentId)
    .first<StoredOrder>();

  if (order) {
    const matches = await contactMatches(contact, [order.phone, order.email, order.payer_contact, order.payer_email]);
    const paid = order.status === "paid" || order.status === "partially_refunded";
    return matches && paid ? { ok: true, studentId: order.student_id, orderId: order.id, via: "order" } : { ok: false, reason: "no_match" };
  }

  // Burn the same compares as above, then try Razorpay's own record.
  await contactMatches(contact, []);
  return restoreFromRazorpay(env, contact, paymentId);
}

/** The fallback for a captured payment D1 hasn't recorded yet. Any doubt is "no_match". */
async function restoreFromRazorpay(env: Env, contact: string, paymentId: string): Promise<RestoreResult> {
  const noMatch: RestoreResult = { ok: false, reason: "no_match" };
  let keyId: string;
  let keySecret: string;
  try {
    keyId = requireSecret(env, "RAZORPAY_KEY_ID", 8);
    keySecret = requireSecret(env, "RAZORPAY_KEY_SECRET", 8);
  } catch (err) {
    if (err instanceof ConfigError) return noMatch;
    throw err;
  }
  const mode = razorpayMode(keyId);
  if (!mode || mode !== config(env).paymentMode) return noMatch;

  let payment: RazorpayPayment;
  try {
    payment = (await fetchRazorpayPayment({ keyId, keySecret }, paymentId)) as unknown as RazorpayPayment;
  } catch (err) {
    if (!(err instanceof RazorpayError && (err.status === 400 || err.status === 404))) {
      console.error(`restore: ${err instanceof Error ? err.message : "unknown error"}`);
    }
    return noMatch;
  }
  if (payment.id !== paymentId || payment.status !== "captured" || payment.currency !== "INR" || typeof payment.order_id !== "string") {
    return noMatch;
  }

  const order = await env.DB.prepare(
    "SELECT o.id, o.student_id, o.status, s.phone, s.email, o.amount_paise, o.mode " +
      "FROM orders o JOIN students s ON s.id = o.student_id " +
      "WHERE o.razorpay_order_id = ? AND o.status IN ('created', 'failed') AND s.erased_at IS NULL",
  )
    .bind(payment.order_id)
    .first<{ id: number; student_id: number; status: string; phone: string | null; email: string | null; amount_paise: number; mode: string }>();
  if (!order || order.amount_paise !== payment.amount || order.mode !== mode) return noMatch;
  if (!(await contactMatches(contact, [order.phone, order.email, payment.contact, payment.email]))) return noMatch;

  try {
    const result = await fulfilOrder(env, {
      orderId: order.id,
      payment: {
        id: payment.id,
        entity: "payment",
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        order_id: payment.order_id,
        method: payment.method ?? null,
        email: payment.email ?? null,
        contact: payment.contact ?? null,
        created_at: payment.created_at,
      },
    });
    if (!result.ok || result.studentId !== order.student_id) return noMatch;
    return { ok: true, studentId: order.student_id, orderId: order.id, via: "razorpay" };
  } catch (err) {
    if (!(err instanceof NotImplementedError)) console.error(`restore: fulfil failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return noMatch;
  }
}
