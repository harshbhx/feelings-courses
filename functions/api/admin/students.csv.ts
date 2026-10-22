// GET /api/admin/students.csv. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { studentsCsvRoute } from "../../_lib/admin/routes.ts";

export const onRequest = studentsCsvRoute;
