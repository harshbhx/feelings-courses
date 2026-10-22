// GET, POST /api/admin/courses. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { coursesRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = coursesRoute;
