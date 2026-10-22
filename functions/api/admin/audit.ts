// GET /api/admin/audit. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { auditRoute } from "../../_lib/admin/routes.ts";

export const onRequest = auditRoute;
