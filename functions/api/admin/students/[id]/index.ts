// GET /api/admin/students/:id. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { studentRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = studentRoute;
