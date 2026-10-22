// POST /api/admin/logout. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { logoutRoute } from "../../_lib/admin/routes.ts";

export const onRequest = logoutRoute;
