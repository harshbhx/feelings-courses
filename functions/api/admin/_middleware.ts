// Runs before every /api/admin/* route: session check, Origin and JSON rules, security headers.
// functions/_lib/admin/middleware.ts.
import { adminMiddlewareHandler } from "../../_lib/admin/middleware.ts";

export const onRequest = adminMiddlewareHandler;
