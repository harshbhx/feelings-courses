// GET /api/admin/publish/status. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { publishStatusRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = publishStatusRoute;
