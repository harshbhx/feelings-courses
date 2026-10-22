// POST /api/admin/students/:id/certificate. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { certificateRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = certificateRoute;
