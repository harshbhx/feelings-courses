// POST /api/auth/restore. functions/_lib/student-api.ts.
import type { Env } from "../../_lib/env.ts";
import { handleRestore } from "../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleRestore(request, env);
