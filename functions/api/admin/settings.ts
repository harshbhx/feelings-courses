// GET, PUT /api/admin/settings. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { settingsRoute } from "../../_lib/admin/routes.ts";

export const onRequest = settingsRoute;
