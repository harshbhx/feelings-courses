// POST /api/admin/orders/:id/sync. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { syncRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = syncRoute;
