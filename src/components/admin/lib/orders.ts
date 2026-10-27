/**
 * Payments: status wording, the 24-hour refund window (owner decision), what can still be refunded,
 * and the refund form. The server (W2) enforces every rule again; this only decides what to offer.
 */
import type { AdminOrder, OrderStatus, Paise, Unix } from "../../../shared/types.ts";
import { formatPaise, parseRupees } from "./money.ts";
import { timeLeft } from "./time.ts";

export const ORDER_STATUSES: readonly OrderStatus[] = ["paid", "created", "failed", "partially_refunded", "refunded"];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  created: "Not paid",
  paid: "Paid",
  failed: "Failed",
  partially_refunded: "Part refunded",
  refunded: "Refunded",
};

/** Refunds that count against the amount: processed and still pending (failed ones don't). */
export function committedRefunds(order: Pick<AdminOrder, "refunds" | "refundedPaise">): Paise {
  const sum = order.refunds.filter((r) => r.status !== "failed").reduce((n, r) => n + r.amountPaise, 0);
  return Math.max(sum, order.refundedPaise);
}

/** What is left to refund. */
export function refundableAmount(order: Pick<AdminOrder, "amountPaise" | "refunds" | "refundedPaise">): Paise {
  return Math.max(0, order.amountPaise - committedRefunds(order));
}

export type RefundState =
  | { can: true; remaining: Paise; until: Unix; left: string }
  | { can: false; reason: string };

/** Whether a refund can be offered now, and until when. */
export function refundState(
  order: Pick<AdminOrder, "status" | "amountPaise" | "refunds" | "refundedPaise" | "refundableUntil" | "paidAt">,
  now: Unix,
): RefundState {
  if (order.status !== "paid" && order.status !== "partially_refunded") {
    return { can: false, reason: order.status === "refunded" ? "Already refunded in full." : "Only paid orders can be refunded." };
  }
  if (order.amountPaise <= 0) return { can: false, reason: "Nothing was charged (a free enrollment)." };
  const remaining = refundableAmount(order);
  if (remaining <= 0) return { can: false, reason: "The whole amount is refunded or on its way." };
  if (order.refundableUntil === null || now >= order.refundableUntil) {
    return { can: false, reason: "The 24-hour refund window has closed." };
  }
  return { can: true, remaining, until: order.refundableUntil, left: timeLeft(order.refundableUntil - now) };
}

export type RefundForm = { ok: true; amountPaise: Paise | undefined; reason: string } | { ok: false; errors: Record<string, string> };

/**
 * Reads the refund form. An empty amount, or the full remaining amount, sends no `amountPaise`
 * (the API then refunds the rest, which is exact even if a pending refund settles meanwhile).
 */
export function readRefundForm(amount: string, reason: string, remaining: Paise): RefundForm {
  const errors: Record<string, string> = {};
  const r = parseRupees(amount);
  let amountPaise: Paise | undefined;
  if (!r.ok) errors.amountPaise = r.error;
  else if (r.paise !== null) {
    if (r.paise < 100) errors.amountPaise = "Refund at least ₹1.";
    else if (r.paise > remaining) errors.amountPaise = `At most ${formatPaise(remaining)} is left to refund.`;
    else if (r.paise < remaining) amountPaise = r.paise;
  }
  const why = reason.trim();
  if (!why) errors.reason = "Write a short reason (it stays in the audit log).";
  else if (why.length > 300) errors.reason = "Keep the reason under 300 characters.";
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, amountPaise, reason: why };
}

/** Razorpay's dashboard page for a payment id. */
export function razorpayPaymentUrl(paymentId: string): string {
  return `https://dashboard.razorpay.com/app/payments/${encodeURIComponent(paymentId)}`;
}

/** "UPI", "Card", "Netbanking"… from Razorpay's method name. */
export function methodLabel(method: string | null): string {
  if (!method) return "—";
  const known: Record<string, string> = { upi: "UPI", card: "Card", netbanking: "Netbanking", wallet: "Wallet", emi: "EMI", cardless_emi: "Cardless EMI", paylater: "Pay later", free: "Free (coupon)", manual: "Manual" };
  return known[method] ?? method.charAt(0).toUpperCase() + method.slice(1);
}
