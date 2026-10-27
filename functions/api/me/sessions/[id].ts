// DELETE /api/me/sessions/:id. functions/_lib/student-api.ts.
import type { Env } from "../../../_lib/env.ts";
import { handleMySession } from "../../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env, "id"> = ({ request, env, params }) => handleMySession(String(params.id ?? ""))(request, env);
