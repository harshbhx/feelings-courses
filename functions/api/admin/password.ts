// POST /api/admin/password. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { passwordRoute } from "../../_lib/admin/routes.ts";

export const onRequest = passwordRoute;
