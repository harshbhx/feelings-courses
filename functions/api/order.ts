// POST /api/order: starts a payment for the course. Amount and currency come from src/data/course.ts
// only. With both Razorpay keys it creates a Razorpay order. On the demo course without a Key Secret
// it returns what Razorpay's test Checkout needs, without an order ("razorpay-test"), or a demo order
// for the built-in demo sheet.
// The logic lives in functions/_lib/checkout.ts, where scripts/test-checkout.mjs tests it.
import { handleOrder } from "../_lib/checkout.ts";
import type { CheckoutEnv } from "../_lib/checkout.ts";

export const onRequest: PagesFunction<CheckoutEnv> = ({ request, env }) => handleOrder(request, env);
