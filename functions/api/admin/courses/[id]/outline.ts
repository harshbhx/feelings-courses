// PUT /api/admin/courses/:id/outline. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { outlineRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = outlineRoute;
