// POST /api/verify: checks a finished payment and only then issues the enrollment cookie.
// Razorpay: signature (HMAC-SHA256 of order_id|payment_id with the key secret) plus Razorpay's own
// record of the payment. Demo course without a Key Secret: a demo order, or a Razorpay test payment
// id ("razorpay-test"), which can't be verified without the secret; see checkout.ts for why that is
// acceptable only for the demo.
// The logic lives in functions/_lib/checkout.ts, where scripts/test-checkout.mjs tests it.
import { handleVerify } from "../_lib/checkout.ts";
import type { CheckoutEnv } from "../_lib/checkout.ts";

export const onRequest: PagesFunction<CheckoutEnv> = ({ request, env }) => handleVerify(request, env);
