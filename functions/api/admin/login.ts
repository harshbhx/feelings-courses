// POST /api/admin/login. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { loginRoute } from "../../_lib/admin/routes.ts";

export const onRequest = loginRoute;
