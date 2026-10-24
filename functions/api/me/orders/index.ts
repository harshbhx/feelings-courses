// GET /api/me/orders. functions/_lib/student-api.ts.
import type { Env } from "../../../_lib/env.ts";
import { handleMyOrders } from "../../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleMyOrders(request, env);
