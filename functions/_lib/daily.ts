/**
 * The lazy daily job (plan 1.17, W7): backup to R2 and cleanup of expired sessions, tokens, rate
 * limits and abandoned multipart uploads. Pages has no cron, so W5's admin middleware and W2's
 * webhook call maybeRunDaily(), which runs the job at most once per 24 h (in ctx.waitUntil).
 * STUB: signature frozen by W0, body by W7.
 */
import type { Env } from "./env.ts";
import { notImplemented, type WaitUntil } from "./stub.ts";

export async function maybeRunDaily(env: Env, ctx: WaitUntil): Promise<void> {
  return notImplemented("maybeRunDaily", "W7");
}
