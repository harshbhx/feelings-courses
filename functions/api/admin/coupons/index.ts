// GET, POST /api/admin/coupons. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { couponsRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = couponsRoute;
