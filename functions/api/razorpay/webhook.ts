// POST /api/razorpay/webhook: Razorpay's events (payment.captured, order.paid, payment.failed,
// refund.*). Signature-checked with RAZORPAY_WEBHOOK_SECRET, stored once per event id, processed
// idempotently. The logic lives in functions/_lib/payments.ts (handleWebhook) and orders.ts.
import { handleWebhook } from "../../_lib/payments.ts";
import type { Env } from "../../_lib/env.ts";

export const onRequest: PagesFunction<Env> = (context) => handleWebhook(context.request, context.env, context);
