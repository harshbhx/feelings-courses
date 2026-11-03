// POST /api/order: starts a payment. With D1 bound and an OrderRequest (it names a `course`), the
// live flow in functions/_lib/payments.ts: the price comes from D1 (pricing.ts quote()), never from
// the browser, and a Razorpay order is created on the server. Otherwise the demo checkout in
// functions/_lib/checkout.ts answers as before (amount from src/data/course.ts).
import { routeOrder } from "../_lib/payments.ts";
import type { Env } from "../_lib/env.ts";

export const onRequest: PagesFunction<Env> = (ctx) => routeOrder(ctx.request, ctx.env, { waitUntil: (p) => ctx.waitUntil(p) });
