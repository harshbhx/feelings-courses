// /auth/continue?t=…: one-time sign-in links (payment handoff, emailed link, admin link). functions/_lib/pages/auth.ts.
import type { Env } from "../_lib/env.ts";
import { handleContinue } from "../_lib/pages/auth.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleContinue(request, env);
