// GET, PUT, DELETE /api/admin/courses/:id. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { courseRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = courseRoute;
