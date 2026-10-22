// POST /api/admin/students/:id/signout-all. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { signoutAllRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = signoutAllRoute;
