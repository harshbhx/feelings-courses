// POST /api/coupon/quote: what a coupon does to a course's price, computed on the server from D1.
// The logic lives in functions/_lib/payments.ts (handleCouponQuote) and pricing.ts (quote).
import { handleCouponQuote } from "../../_lib/payments.ts";
import type { Env } from "../../_lib/env.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleCouponQuote(request, env);
