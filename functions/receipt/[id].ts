// GET /receipt/<orderId>?k=<key>: the on-screen payment receipt (no email service: the buyer keeps,
// prints or shares this page). The key is an HMAC of the order id with APP_SECRET, so a link can't
// be guessed for another order. The logic lives in functions/_lib/receipts.ts.
import { handleReceipt } from "../_lib/receipts-route.ts";
import type { Env } from "../_lib/env.ts";

export const onRequest: PagesFunction<Env, "id"> = ({ request, env, params }) =>
  handleReceipt(request, env, String(params.id ?? ""));
