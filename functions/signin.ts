// /signin: the student types their email and gets a one-time sign-in link. functions/_lib/pages/auth.ts.
import type { Env } from "./_lib/env.ts";
import { handleSignin } from "./_lib/pages/auth.ts";

export const onRequest: PagesFunction<Env> = (ctx) => handleSignin(ctx.request, ctx.env, undefined, { waitUntil: (p) => ctx.waitUntil(p) });
