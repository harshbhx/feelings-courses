// GET /api/admin/orders.csv. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { ordersCsvRoute } from "../../_lib/admin/routes.ts";

export const onRequest = ordersCsvRoute;
