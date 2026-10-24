// POST /api/admin/courses/:id/domain/check. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { domainCheckRoute } from "../../../../../_lib/admin/routes.ts";

export const onRequest = domainCheckRoute;
