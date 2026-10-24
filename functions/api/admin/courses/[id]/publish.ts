// POST /api/admin/courses/:id/publish. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { publishCourseRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = publishCourseRoute;
