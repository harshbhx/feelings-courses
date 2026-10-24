// GET /api/admin/orders. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { ordersRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = ordersRoute;
