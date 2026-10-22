// GET /api/me/orders/:id: one of the signed-in student's receipts. functions/_lib/student-api.ts.
import type { Env } from "../../../_lib/env.ts";
import { handleMyReceipt } from "../../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env, "id"> = ({ request, env, params }) => handleMyReceipt(String(params.id))(request, env);
