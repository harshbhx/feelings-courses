// GET /api/admin/me. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { meRoute } from "../../_lib/admin/routes.ts";

export const onRequest = meRoute;
