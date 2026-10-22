// POST /api/admin/orders/:id/refund. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { refundRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = refundRoute;
