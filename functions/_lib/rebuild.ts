/**
 * Publish → rebuild (plan 1.1): calls the Pages deploy hook, debounced to once per 120 s
 * (config.ts REBUILD_DEBOUNCE), recording settings.last_rebuild_at and published_version.
 * STUB: signature frozen by W0, body by W5.
 */
import type { Unix } from "../../src/shared/types.ts";
import type { Env } from "./env.ts";
import { notImplemented, type WaitUntil } from "./stub.ts";

export async function requestRebuild(env: Env, ctx: WaitUntil): Promise<{ queued: boolean; nextAllowedAt: Unix }> {
  return notImplemented("requestRebuild", "W5");
}
