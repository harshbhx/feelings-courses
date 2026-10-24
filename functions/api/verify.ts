// POST /api/verify: checks a finished payment. When D1 knows the Razorpay order, the live flow in
// functions/_lib/payments.ts: Razorpay's signature (HMAC-SHA256 of order_id|payment_id with the key
// secret), then Razorpay's record of the payment, then fulfilOrder (idempotent with the webhook).
// Otherwise the demo checkout in functions/_lib/checkout.ts answers as before.
import { routeVerify } from "../_lib/payments.ts";
import type { Env } from "../_lib/env.ts";

export const onRequest: PagesFunction<Env> = (ctx) => routeVerify(ctx.request, ctx.env, { waitUntil: (p) => ctx.waitUntil(p) });
