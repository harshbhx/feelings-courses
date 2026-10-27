/**
 * Publish → rebuild (plan 1.1, W5). Course pages are static: after a publish (or an edit of a
 * published course) the admin calls the Pages deploy hook, and the build fetches the new snapshot
 * from D1 (~2 minutes). Price, enrollments, progress and video always come live from D1, so only
 * page content waits for the build.
 *
 * - Debounced to once per REBUILD_DEBOUNCE (120 s), claimed atomically in settings.last_rebuild_at,
 *   so double clicks and two tabs can't queue a build each.
 * - settings.published_version records the content_version the last requested build will show.
 * - No DEPLOY_HOOK_URL (preview, or before the owner pastes it into setup): nothing is called and
 *   the result says why. The change is still saved in D1.
 * - A failed hook call releases the claim, so the admin can retry at once.
 *
 * The hook URL is a secret the owner sets; it must be Cloudflare's deploy-hook endpoint
 * (https://api.cloudflare.com/…), so a mistyped value can't make the site POST elsewhere.
 */
import type { PublishStatus, Unix } from "../../src/shared/types.ts";
import { ConfigError, REBUILD_DEBOUNCE } from "./config.ts";
import { auditStatement } from "./db/audit.ts";
import { unixNow } from "./db/d1.ts";
import { getSettings, setSettingStatement } from "./db/settings.ts";
import { batch } from "./db/tx.ts";
import type { Env } from "./env.ts";
import type { WaitUntil } from "./stub.ts";

export type RebuildSkipReason = "debounced" | "no_hook" | "hook_failed";

export interface RebuildResult {
  queued: boolean;
  nextAllowedAt: Unix;
  /** Why no build was queued (absent when queued). */
  reason?: RebuildSkipReason;
}

/** How long a deploy-hook call may take before it counts as failed. */
export const HOOK_TIMEOUT_MS = 10_000;

/** The deploy hook URL, checked, or null when it isn't set. */
export function deployHookUrl(env: Partial<Env>): string | null {
  const raw = env.DEPLOY_HOOK_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("DEPLOY_HOOK_URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "api.cloudflare.com" || url.username || url.password) {
    throw new ConfigError("DEPLOY_HOOK_URL");
  }
  return url.href;
}

export async function requestRebuild(env: Env, ctx: WaitUntil): Promise<{ queued: boolean; nextAllowedAt: Unix }> {
  void ctx; // the hook is awaited, so the admin sees whether the build was really queued
  return requestRebuildAt(env, unixNow());
}

/** requestRebuild with an explicit clock and fetch (tests). */
export async function requestRebuildAt(
  env: Pick<Env, "DB" | "DEPLOY_HOOK_URL">,
  now: number,
  fetcher: typeof fetch = fetch,
): Promise<RebuildResult> {
  const db = env.DB;
  const hook = deployHookUrl(env);
  if (!hook) return { queued: false, nextAllowedAt: now, reason: "no_hook" };

  const before = await getSettings(db, ["last_rebuild_at", "content_version"]);
  const previous = typeof before.last_rebuild_at === "number" ? before.last_rebuild_at : null;

  // The claim: only one caller per 120 s gets a row back.
  const claimed = await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('last_rebuild_at', ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at " +
        "WHERE CAST(settings.value AS INTEGER) <= ? RETURNING value",
    )
    .bind(String(now), now, now - REBUILD_DEBOUNCE)
    .first<{ value: string }>();
  if (!claimed) {
    return { queued: false, nextAllowedAt: (previous ?? now) + REBUILD_DEBOUNCE, reason: "debounced" };
  }

  const version = typeof before.content_version === "number" ? before.content_version : 1;
  let ok = false;
  try {
    const response = await fetcher(hook, { method: "POST", signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) });
    ok = response.ok;
    if (!ok) console.error(`rebuild: deploy hook answered ${response.status}`);
  } catch (err) {
    console.error(`rebuild: deploy hook failed (${err instanceof Error ? err.name : "error"})`);
  }

  if (!ok) {
    // Release the claim so the admin can retry straight away.
    await (previous === null
      ? db.prepare("DELETE FROM settings WHERE key = 'last_rebuild_at' AND value = ?").bind(String(now))
      : setSettingStatement(db, "last_rebuild_at", previous, now)
    ).run();
    return { queued: false, nextAllowedAt: now, reason: "hook_failed" };
  }

  await batch(db, [
    setSettingStatement(db, "published_version", version, now),
    auditStatement(db, { actor: "admin", action: "site.rebuild", entity: "site", data: { contentVersion: version }, now }),
  ]);
  return { queued: true, nextAllowedAt: now + REBUILD_DEBOUNCE };
}

/** How long after a hook call the live site may still be building (Pages builds take ~2 minutes). */
export const BUILD_GRACE = 15 * 60;

/**
 * Where publishing stands. `liveVersion` is read from the deployment's own dist/build.json (W1)
 * through ASSETS, which is the build currently serving the site.
 *
 * state:
 * - up_to_date: the live build shows the latest content_version;
 * - building:   a build for the latest content was requested in the last 15 minutes;
 * - queued:     there are saved changes the live site doesn't show yet (publish again to send them);
 * - unknown:    build.json can't be read (local dev, or before W1's build.json exists).
 */
export async function publishStatus(
  env: Pick<Env, "DB"> & Partial<Pick<Env, "ASSETS">>,
  siteUrl: string,
  now = unixNow(),
): Promise<PublishStatus> {
  const settings = await getSettings(env.DB, ["content_version", "published_version", "last_rebuild_at"]);
  const contentVersion = typeof settings.content_version === "number" ? settings.content_version : 1;
  const publishedVersion = typeof settings.published_version === "number" ? settings.published_version : 0;
  const lastRebuildAt = typeof settings.last_rebuild_at === "number" ? settings.last_rebuild_at : null;
  const liveVersion = await readLiveVersion(env, siteUrl);
  const nextAllowedAt = lastRebuildAt !== null && lastRebuildAt + REBUILD_DEBOUNCE > now ? lastRebuildAt + REBUILD_DEBOUNCE : null;

  let state: PublishStatus["state"];
  if (liveVersion !== null && liveVersion >= contentVersion) state = "up_to_date";
  else if (publishedVersion >= contentVersion && lastRebuildAt !== null && now - lastRebuildAt < BUILD_GRACE) state = "building";
  else if (liveVersion === null) state = "unknown";
  else state = "queued";
  return { contentVersion, publishedVersion, liveVersion, lastRebuildAt, nextAllowedAt, state };
}

async function readLiveVersion(env: Partial<Pick<Env, "ASSETS">>, siteUrl: string): Promise<number | null> {
  if (!env.ASSETS) return null;
  try {
    const response = await env.ASSETS.fetch(new URL("/build.json", siteUrl).href);
    if (!response.ok) return null;
    const info = (await response.json()) as { contentVersion?: unknown };
    return typeof info.contentVersion === "number" && Number.isSafeInteger(info.contentVersion) ? info.contentVersion : null;
  } catch {
    return null;
  }
}
