// GET /api/admin/webhooks. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { webhooksRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = webhooksRoute;
