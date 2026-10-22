// GET /api/admin/stats. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { statsRoute } from "../../_lib/admin/routes.ts";

export const onRequest = statsRoute;
