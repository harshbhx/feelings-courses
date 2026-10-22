// GET /api/admin/orders/:id. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { orderRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = orderRoute;
