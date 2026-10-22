// POST /api/auth/signout. functions/_lib/student-api.ts.
import type { Env } from "../../_lib/env.ts";
import { handleSignout } from "../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleSignout(request, env);
