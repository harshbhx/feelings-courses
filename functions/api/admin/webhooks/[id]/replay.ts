// POST /api/admin/webhooks/:id/replay. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { replayRoute } from "../../../../_lib/admin/routes.ts";

export const onRequest = replayRoute;
