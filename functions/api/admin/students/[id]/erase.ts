// POST /api/admin/students/:id/erase. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { eraseRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = eraseRoute;
