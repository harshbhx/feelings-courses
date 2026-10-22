/**
 * Order fulfilment, refunds and webhook processing (plan 1.9). STUB: signatures frozen by W0,
 * bodies by W2.
 *
 * fulfilOrder is ONE D1 batch: the guarded UPDATE of the order, then the enrollment upsert, coupon
 * redemption, batch seat, invoice number, audit and daily stats, each guarded so only the batch
 * that paid the order applies them (db/tx.ts). Verify and webhook may race safely.
 */
import type { AdminOrder, RazorpayPayment, Refund } from "../../src/shared/types.ts";
import type { Env } from "./env.ts";
import { notImplemented } from "./stub.ts";

export type FulfilResult =
  | { ok: true; alreadyPaid: boolean; studentId: number; courseId: number; enrollmentId: number }
  | { ok: false; reason: "order_not_found" | "amount_mismatch" | "order_mismatch" | "not_captured" | "refunded" };

export async function fulfilOrder(env: Env, input: { orderId: number; payment: RazorpayPayment }): Promise<FulfilResult> {
  return notImplemented("fulfilOrder", "W2");
}

/** Calls Razorpay's refund API and records a pending `refunds` row; the webhook finalises it. */
export async function refundOrder(
  env: Env,
  orderId: number,
  input: { amountPaise?: number; reason: string; revoke: boolean },
): Promise<Refund> {
  return notImplemented("refundOrder", "W2");
}

/** Re-fetches the order's payment and refunds from Razorpay and reconciles D1. */
export async function syncOrder(env: Env, orderId: number): Promise<AdminOrder> {
  return notImplemented("syncOrder", "W2");
}

/** Processes a stored webhook_events row (also the admin's replay). Errors go to webhook_events.error. */
export async function processWebhookEvent(env: Env, eventId: string): Promise<void> {
  return notImplemented("processWebhookEvent", "W2");
}
