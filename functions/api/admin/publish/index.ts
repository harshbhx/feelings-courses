// POST /api/admin/publish. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { publishSiteRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = publishSiteRoute;
