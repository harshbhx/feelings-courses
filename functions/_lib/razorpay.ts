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

/** GET /v1/payments/:id */
export async function fetchRazorpayPayment(keys: RazorpayKeys, paymentId: string): Promise<RazorpayPayment> {
  const data = await call(keys, `/payments/${encodeURIComponent(paymentId)}`, { method: "GET" });
  if (typeof data?.id !== "string" || typeof data?.amount !== "number") {
    throw new RazorpayError("Razorpay returned a payment without an id", 502);
  }
  return data as RazorpayPayment;
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
