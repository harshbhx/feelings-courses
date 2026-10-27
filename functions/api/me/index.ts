// GET and PUT /api/me. functions/_lib/student-api.ts.
import type { Env } from "../../_lib/env.ts";
import { handleMe } from "../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleMe(request, env);
