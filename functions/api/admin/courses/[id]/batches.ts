// GET, POST /api/admin/courses/:id/batches. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { courseBatchesRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = courseBatchesRoute;
