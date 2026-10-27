// GET /api/me/sessions. functions/_lib/student-api.ts.
import type { Env } from "../../../_lib/env.ts";
import { handleMySessions } from "../../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleMySessions(request, env);
