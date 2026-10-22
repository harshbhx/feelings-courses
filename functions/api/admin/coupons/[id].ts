// GET, PUT, DELETE /api/admin/coupons/:id. The handler lives in functions/_lib/admin/routes.ts; docs/admin-api.md documents it.
import { couponRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = couponRoute;
