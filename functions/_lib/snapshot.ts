/**
 * The D1 → Snapshot query behind GET /api/public/snapshot (plan 1.1). STUB: signature frozen by
 * W0, body by W1. Published, non-deleted courses only; lessons without video refs; open batches.
 *
 * Contract with scripts/snapshot.mjs: while the DB isn't bound (setup not run), the endpoint must
 * answer 404, never 5xx, or every production build fails.
 */
import type { Snapshot } from "../../src/shared/types.ts";
import type { Env } from "./env.ts";
import { notImplemented } from "./stub.ts";

export async function buildSnapshot(env: Env): Promise<Snapshot> {
  return notImplemented("buildSnapshot", "W1");
}
