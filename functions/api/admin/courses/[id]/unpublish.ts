// POST /api/admin/courses/:id/unpublish. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { unpublishCourseRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = unpublishCourseRoute;
