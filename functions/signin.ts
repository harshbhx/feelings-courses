// /signin: restore access on a new device (phone or email + payment ID). functions/_lib/pages/auth.ts.
import type { Env } from "./_lib/env.ts";
import { handleSignin } from "./_lib/pages/auth.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleSignin(request, env);
