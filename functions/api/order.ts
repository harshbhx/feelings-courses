// POST /api/order: starts a payment for the course. Amount and currency come from src/data/course.ts
// only. With Razorpay keys it creates a Razorpay order; without them (demo) it returns a demo order.
// The logic lives in functions/_lib/checkout.ts, where scripts/test-checkout.mjs tests it.
import { handleOrder } from "../_lib/checkout.ts";
import type { CheckoutEnv } from "../_lib/checkout.ts";

export const onRequest: PagesFunction<CheckoutEnv> = ({ request, env }) => handleOrder(request, env);
