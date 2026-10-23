// POST /api/auth/email-link { email, next? }: emails a one-time sign-in link. functions/_lib/student-api.ts.
import type { Env } from "../../_lib/env.ts";
import { handleEmailLink } from "../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env> = (ctx) => handleEmailLink(ctx.request, ctx.env, undefined, { waitUntil: (p) => ctx.waitUntil(p) });
