// POST /api/admin/students/:id/enrollments. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { grantRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = grantRoute;
