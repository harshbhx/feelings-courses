/**
 * Razorpay: the signature check and the two server-side API calls checkout needs.
 * Docs: https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
 * The key secret only ever lives in env on the server; nothing here returns it.
 */

import { hmacSha256Hex, timingSafeEqual } from "./crypto.ts";

const API = "https://api.razorpay.com/v1";

export interface RazorpayKeys {
  keyId: string;
  keySecret: string;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

export interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  status: string;
  method?: string | null;
  email?: string | null;
  contact?: string | null;
  error_description?: string | null;
}

export interface RazorpayRefundEntity {
  id: string;
  payment_id: string;
  amount: number;
  currency?: string;
  status: string;
  notes?: Record<string, string> | unknown[];
}

/** Thrown when Razorpay can't be reached or answers with an error. `status` is Razorpay's HTTP status, 0 for network errors. */
export class RazorpayError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RazorpayError";
    this.status = status;
  }
}

/**
 * Checks Razorpay's payment signature: HMAC-SHA256 of `order_id|payment_id`, keyed with the key
 * secret, compared in constant time. True only for a payment Razorpay made against this order.
 */
export async function verifyRazorpaySignature(
  orderId: string,
  paymentId: string,
  signature: string,
  keySecret: string,
): Promise<boolean> {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = await hmacSha256Hex(keySecret, `${orderId}|${paymentId}`);
  return timingSafeEqual(signature.toLowerCase(), expected);
}

/** POST /v1/orders. Amount in paise. */
export async function createRazorpayOrder(
  keys: RazorpayKeys,
  order: { amount: number; currency: string; receipt: string; notes: Record<string, string> },
): Promise<RazorpayOrder> {
  const data = await call(keys, "/orders", { method: "POST", body: JSON.stringify(order) });
  if (typeof data?.id !== "string" || typeof data?.amount !== "number") {
    throw new RazorpayError("Razorpay returned an order without an id", 502);
  }
  return data as RazorpayOrder;
}

/**
 * Checks a webhook delivery: X-Razorpay-Signature is the hex HMAC-SHA256 of the raw request body,
 * keyed with the webhook secret (not the key secret). Compared in constant time.
 */
export async function verifyWebhookSignature(rawBody: string, signature: string, webhookSecret: string): Promise<boolean> {
  if (!signature || !webhookSecret) return false;
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = await hmacSha256Hex(webhookSecret, rawBody);
  return timingSafeEqual(signature.toLowerCase(), expected);
}

/** GET /v1/payments/:id */
export async function fetchRazorpayPayment(keys: RazorpayKeys, paymentId: string): Promise<RazorpayPayment> {
  const data = await call(keys, `/payments/${encodeURIComponent(paymentId)}`, { method: "GET" });
  if (typeof data?.id !== "string" || typeof data?.amount !== "number") {
    throw new RazorpayError("Razorpay returned a payment without an id", 502);
  }
  return data as RazorpayPayment;
}

/**
 * POST /v1/payments/:id/capture. Only needed when the account doesn't auto-capture: an authorized
 * payment that is never captured is refunded by Razorpay after a few days.
 */
export async function captureRazorpayPayment(
  keys: RazorpayKeys,
  paymentId: string,
  amount: number,
  currency: string,
): Promise<RazorpayPayment> {
  const data = await call(keys, `/payments/${encodeURIComponent(paymentId)}/capture`, {
    method: "POST",
    body: JSON.stringify({ amount, currency }),
  });
  if (typeof data?.id !== "string" || typeof data?.amount !== "number") {
    throw new RazorpayError("Razorpay returned a payment without an id", 502);
  }
  return data as RazorpayPayment;
}

/**
 * Captures an authorized payment. When Razorpay refuses because it is already captured (auto-capture
 * on the account, or another request got there first), returns Razorpay's current record instead.
 */
export async function captureOrFetchPayment(
  keys: RazorpayKeys,
  paymentId: string,
  amount: number,
  currency: string,
): Promise<RazorpayPayment> {
  try {
    return await captureRazorpayPayment(keys, paymentId, amount, currency);
  } catch (err) {
    if (err instanceof RazorpayError && err.status >= 400 && err.status < 500) return fetchRazorpayPayment(keys, paymentId);
    throw err;
  }
}

/** GET /v1/orders/:id/payments: every payment attempt on an order. */
export async function fetchRazorpayOrderPayments(keys: RazorpayKeys, orderId: string): Promise<RazorpayPayment[]> {
  const data = await call(keys, `/orders/${encodeURIComponent(orderId)}/payments`, { method: "GET" });
  return Array.isArray(data?.items) ? (data.items as RazorpayPayment[]).filter((p) => typeof p?.id === "string") : [];
}

/**
 * POST /v1/payments/:id/refund. Amount in paise. `notes.refund_id` carries our refunds.id, so a
 * refund whose answer was lost (timeout) can still be matched later by syncOrder().
 */
export async function createRazorpayRefund(
  keys: RazorpayKeys,
  paymentId: string,
  refund: { amount: number; receipt: string; notes: Record<string, string> },
): Promise<RazorpayRefundEntity> {
  const data = await call(keys, `/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: "POST",
    body: JSON.stringify({ amount: refund.amount, speed: "normal", receipt: refund.receipt, notes: refund.notes }),
  });
  if (typeof data?.id !== "string" || typeof data?.amount !== "number") {
    throw new RazorpayError("Razorpay returned a refund without an id", 502);
  }
  return data as RazorpayRefundEntity;
}

/** GET /v1/payments/:id/refunds */
export async function fetchRazorpayRefunds(keys: RazorpayKeys, paymentId: string): Promise<RazorpayRefundEntity[]> {
  const data = await call(keys, `/payments/${encodeURIComponent(paymentId)}/refunds`, { method: "GET" });
  return Array.isArray(data?.items) ? (data.items as RazorpayRefundEntity[]).filter((r) => typeof r?.id === "string") : [];
}

async function call(keys: RazorpayKeys, path: string, init: { method: string; body?: string }) {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: init.method,
      body: init.body,
      headers: {
        Authorization: `Basic ${btoa(`${keys.keyId}:${keys.keySecret}`)}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RazorpayError("Could not reach Razorpay", 0);
  }
  const data = (await response.json().catch(() => null)) as Record<string, any> | null;
  if (!response.ok) {
    // Razorpay's error description is safe to log; it never contains the secret.
    const description = typeof data?.error?.description === "string" ? data.error.description : `HTTP ${response.status}`;
    throw new RazorpayError(`Razorpay: ${description}`, response.status);
  }
  return data;
}
