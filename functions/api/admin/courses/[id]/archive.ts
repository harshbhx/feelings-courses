// POST /api/admin/courses/:id/archive. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { archiveCourseRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = archiveCourseRoute;
