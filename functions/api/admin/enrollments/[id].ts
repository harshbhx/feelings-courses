// DELETE /api/admin/enrollments/:id. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { enrollmentRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = enrollmentRoute;
