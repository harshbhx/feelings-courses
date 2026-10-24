// POST /api/admin/students/:id/access-link. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { accessLinkRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = accessLinkRoute;
