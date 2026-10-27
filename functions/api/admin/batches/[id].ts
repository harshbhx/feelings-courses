// PUT, DELETE /api/admin/batches/:id. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { batchRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = batchRoute;
