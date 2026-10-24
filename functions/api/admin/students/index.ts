// GET, POST /api/admin/students. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { studentsRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = studentsRoute;
