/**
 * The lazy daily job (plan 1.17, W7): cleanup of expired rows and abandoned uploads, then a backup
 * to R2. Pages has no cron, so W5's admin middleware and W2's webhook call maybeRunDaily(), which
 * runs the job at most once per DAILY_INTERVAL, in ctx.waitUntil (after the response is sent).
 *
 * Exactly once, even with concurrent requests: the run is claimed with one conditional upsert on
 * settings.last_cleanup_at; only the request whose upsert changed the row runs the job. A failed
 * step is logged (console + audit_log) and the next step still runs; the claim is not released, so
 * a broken step can't turn every request into a retry.
 */
import { runBackup } from "./backup.ts";
import { auditStatement } from "./db/audit.ts";
import type { Db } from "./db/d1.ts";
import { DAY_SECONDS, unixNow } from "./db/d1.ts";
import { getSetting } from "./db/settings.ts";
import { hasDb, type Env } from "./env.ts";
import { cleanupRateLimits } from "./ratelimit.ts";
import type { WaitUntil } from "./stub.ts";

/** Seconds between runs. */
export const DAILY_INTERVAL = DAY_SECONDS - 600;
/** Expired or revoked sessions are kept this long for the "devices" history, then deleted. */
export const SESSION_GRACE = 30 * DAY_SECONDS;
/** Used or expired login tokens are kept this long (support questions), then deleted. */
export const TOKEN_GRACE = 7 * DAY_SECONDS;
/** An upload still "uploading" after this long is abandoned. */
export const UPLOAD_ABANDON_AFTER = DAY_SECONDS;

/**
 * Claims today's run. True for exactly one caller per interval: the upsert only changes the row
 * when the stored time is older than now - DAILY_INTERVAL.
 */
export async function claimDailyRun(db: Db, now: number): Promise<boolean> {
  const result = await db
    .prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('last_cleanup_at', ?, ?) " +
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at " +
        "WHERE CAST(settings.value AS INTEGER) <= ?",
    )
    .bind(String(now), now, now - DAILY_INTERVAL)
    .run();
  return result.meta.changes === 1;
}

export interface CleanupCounts {
  rateLimits: number;
  sessions: number;
  loginTokens: number;
  adminSessions: number;
  uploads: number;
}

/** Deletes rows nobody needs any more. Returns how many went from each table. */
export async function cleanup(env: Pick<Env, "DB"> & Partial<Pick<Env, "MEDIA">>, now: number): Promise<CleanupCounts> {
  const db = env.DB;
  const rateLimits = await cleanupRateLimits(db, now);
  const [sessions, tokens, admins] = await db.batch([
    db
      .prepare("DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)")
      .bind(now - SESSION_GRACE, now - SESSION_GRACE),
    db.prepare("DELETE FROM login_tokens WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)").bind(now - TOKEN_GRACE, now - TOKEN_GRACE),
    db
      .prepare("DELETE FROM admin_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)")
      .bind(now - SESSION_GRACE, now - SESSION_GRACE),
  ]);
  const uploads = env.MEDIA ? await abortAbandonedUploads(env as Pick<Env, "DB" | "MEDIA">, now) : 0;
  return {
    rateLimits,
    sessions: sessions!.meta.changes,
    loginTokens: tokens!.meta.changes,
    adminSessions: admins!.meta.changes,
    uploads,
  };
}

/**
 * Multipart uploads the admin started but never finished (W4's media rows still 'uploading' a day
 * later): abort them in R2 (frees the stored parts) and mark the row 'aborted'.
 */
export async function abortAbandonedUploads(env: Pick<Env, "DB" | "MEDIA">, now: number, limit = 50): Promise<number> {
  const { results } = await env.DB.prepare(
    "SELECT id, key, upload_id FROM media WHERE status = 'uploading' AND updated_at < ? ORDER BY id LIMIT ?",
  )
    .bind(now - UPLOAD_ABANDON_AFTER, limit)
    .all<{ id: number; key: string; upload_id: string | null }>();
  let aborted = 0;
  for (const row of results) {
    if (row.upload_id) {
      try {
        await env.MEDIA.resumeMultipartUpload(row.key, row.upload_id).abort();
      } catch {
        /* already gone in R2 (completed elsewhere or expired): the row is still marked aborted */
      }
    }
    const res = await env.DB.prepare("UPDATE media SET status = 'aborted', updated_at = ? WHERE id = ? AND status = 'uploading'").bind(now, row.id).run();
    aborted += res.meta.changes;
  }
  return aborted;
}

/** The job itself. Exported for the admin's "run now" and for tests. */
export async function runDaily(env: Partial<Env>, now: number = unixNow()): Promise<{ cleanup: CleanupCounts | null; backup: string | null; errors: string[] }> {
  if (!hasDb(env)) return { cleanup: null, backup: null, errors: ["no database"] };
  const db = env.DB;
  const errors: string[] = [];
  let counts: CleanupCounts | null = null;
  let backup: string | null = null;
  try {
    counts = await cleanup(env as Env, now);
  } catch (err) {
    errors.push(`cleanup: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (env.MEDIA) {
    try {
      const last = (await getSetting(db, "last_backup_at")) ?? 0;
      if (now - last >= DAILY_INTERVAL) backup = (await runBackup(env as Env, now)).key;
    } catch (err) {
      errors.push(`backup: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const e of errors) console.error(`daily: ${e}`);
  try {
    await auditStatement(db, {
      actor: "system",
      action: errors.length ? "daily.failed" : "daily.run",
      entity: "system",
      entityId: "daily",
      data: { cleanup: counts, backup, errors },
      now,
    }).run();
  } catch {
    /* the log is best effort */
  }
  return { cleanup: counts, backup, errors };
}

export async function maybeRunDaily(env: Env, ctx: WaitUntil): Promise<void> {
  if (!hasDb(env)) return;
  const now = unixNow();
  let claimed = false;
  try {
    claimed = await claimDailyRun(env.DB, now);
  } catch (err) {
    console.error(`daily: claim failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (claimed) ctx.waitUntil(runDaily(env, now));
}
