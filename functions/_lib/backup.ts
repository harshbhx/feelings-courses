/**
 * Database backups to R2 (plan 1.17, W7).
 *
 * Three layers protect the data (docs/ops/BACKUPS.md):
 *   1. D1 Time Travel: Cloudflare keeps a point-in-time history of the database (7 days on the free
 *      plan, 30 on paid). Restoring a bad edit or a bad deploy is one wrangler command.
 *   2. This module: a daily SQL dump written to R2 by the lazy daily job (daily.ts), and on demand
 *      from the admin (W5's POST /api/admin/backup/run, GET /api/admin/backup). It survives the
 *      database being deleted, and is kept for BACKUP_KEEP days.
 *   3. scripts/backup-d1.mjs: `wrangler d1 export` to the owner's computer, for an offline copy.
 *
 * The dump is plain SQL that a freshly migrated database accepts (`wrangler d1 execute --file`):
 * PRAGMA defer_foreign_keys, then for every backed-up table a DELETE and multi-row INSERTs with
 * explicit column lists (so a newer schema with added columns still takes it). Sessions, login
 * tokens, admin sessions and rate-limit buckets are left out on purpose: they are short-lived and
 * credential-like, and a restore signs everyone out, which is what you want after an incident.
 *
 * Gzipped in the Worker (CompressionStream), stored as backups/d1/<ISO time>.sql.gz with the row
 * counts in customMetadata. Reads go in pages of BACKUP_PAGE_ROWS so memory stays flat.
 */
import { setSettingStatement } from "./db/settings.ts";
import type { Db } from "./db/d1.ts";
import { unixNow } from "./db/d1.ts";
import type { Env } from "./env.ts";

/** Tables in the dump, parents before children. */
export const BACKUP_TABLES = [
  "settings",
  "courses",
  "batches",
  "modules",
  "lessons",
  "media",
  "students",
  /** Which emails were proven (claim.ts): a restore must not make proven accounts look new. */
  "email_verifications",
  "coupons",
  "orders",
  "refunds",
  "invoice_counters",
  "enrollments",
  "coupon_redemptions",
  "lesson_progress",
  "certificates",
  "webhook_events",
  "daily_stats",
  "audit_log",
] as const;

/** Tables deliberately left out (see above). tests/w7/backup.test.mjs checks every table is in one list. */
export const BACKUP_EXCLUDED = ["sessions", "login_tokens", "admin_sessions", "rate_limits", "d1_migrations"] as const;

export const BACKUP_PREFIX = "backups/d1/";
/** Daily dumps kept in R2. */
export const BACKUP_KEEP = 35;
export const BACKUP_PAGE_ROWS = 500;
/** A multi-row INSERT is cut before this many characters (D1's statement limit is 100 KB). */
const MAX_STATEMENT_CHARS = 60_000;

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

/** One value as an SQL literal. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "NULL";
    // String() gives the shortest text that reads back as the same double (SQLite parses it too).
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  const text = String(value);
  // NUL can't sit inside an SQL string literal: write such text as hex and cast it back.
  if (text.includes("\u0000")) {
    const hex = Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, "0")).join("");
    return `CAST(X'${hex}' AS TEXT)`;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

export interface DumpResult {
  sql: string;
  rows: Record<string, number>;
}

/**
 * The whole dump as one string. Small databases only (the course platform is a few MB); for a big
 * one use scripts/backup-d1.mjs.
 */
export async function dumpDatabase(db: Db, options: { now?: number; tables?: readonly string[]; pageRows?: number } = {}): Promise<DumpResult> {
  const now = options.now ?? unixNow();
  const tables = options.tables ?? BACKUP_TABLES;
  const pageRows = options.pageRows ?? BACKUP_PAGE_ROWS;
  const migrations = await db
    .prepare("SELECT name FROM d1_migrations ORDER BY id")
    .all<{ name: string }>()
    .then((r) => r.results.map((m) => m.name))
    .catch(() => [] as string[]);

  const out: string[] = [
    "-- Feelings Courses: D1 backup (functions/_lib/backup.ts)",
    `-- Taken ${new Date(now * 1000).toISOString()}. Migrations: ${migrations.join(", ") || "unknown"}.`,
    "-- Restore into a database migrated to the same version or newer (docs/ops/BACKUPS.md):",
    "--   wrangler d1 execute <database> --remote --file <this file>",
    "-- It replaces every table listed below. Sessions are not included: everyone signs in again.",
    "PRAGMA defer_foreign_keys = ON;",
  ];
  for (const table of [...tables].reverse()) {
    if (!IDENT_RE.test(table)) throw new Error(`backup: bad table name ${table}`);
    out.push(`DELETE FROM ${table};`);
  }

  const rows: Record<string, number> = {};
  for (const table of tables) {
    let count = 0;
    let columns: string[] | null = null;
    let pending: string[] = [];
    let pendingChars = 0;
    const flush = () => {
      if (columns && pending.length) out.push(`INSERT INTO ${table} (${columns.join(", ")}) VALUES\n${pending.join(",\n")};`);
      pending = [];
      pendingChars = 0;
    };
    for (let offset = 0; ; offset += pageRows) {
      const page = await db.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`).bind(pageRows, offset).all<Record<string, unknown>>();
      for (const row of page.results) {
        if (!columns) {
          columns = Object.keys(row);
          for (const c of columns) if (!IDENT_RE.test(c)) throw new Error(`backup: bad column name ${table}.${c}`);
        }
        const tuple = `(${columns.map((c) => sqlLiteral(row[c])).join(", ")})`;
        if (pendingChars + tuple.length > MAX_STATEMENT_CHARS) flush();
        pending.push(tuple);
        pendingChars += tuple.length + 2;
        count++;
      }
      if (page.results.length < pageRows) break;
    }
    flush();
    rows[table] = count;
  }
  out.push("");
  return { sql: out.join("\n"), rows };
}

/** gzip of a string (Workers and Node 18+ both have CompressionStream). */
export async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function backupKey(now: number): string {
  return `${BACKUP_PREFIX}${new Date(now * 1000).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-")}.sql.gz`;
}

export interface BackupResult {
  ok: true;
  key: string;
  at: number;
  bytes: number;
  rows: Record<string, number>;
  deleted: string[];
}

/** Old dumps beyond BACKUP_KEEP, oldest first. Keys sort by time because they are ISO times. */
export async function pruneBackups(bucket: R2Bucket, keep = BACKUP_KEEP): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor, limit: 1000 });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  keys.sort();
  const old = keys.slice(0, Math.max(0, keys.length - keep));
  if (old.length) await bucket.delete(old);
  return old;
}

/**
 * Dumps D1 into R2, prunes old dumps and records settings.last_backup_at. Throws when DB or MEDIA
 * isn't bound (the caller maps that to an error response or a log line).
 */
export async function runBackup(env: Pick<Env, "DB" | "MEDIA">, now: number = unixNow()): Promise<BackupResult> {
  if (!env.DB || !env.MEDIA) throw new Error("backup: DB and MEDIA bindings are required");
  const dump = await dumpDatabase(env.DB, { now });
  const body = await gzip(dump.sql);
  const key = backupKey(now);
  await env.MEDIA.put(key, body, {
    // Stored as a .gz file (no Content-Encoding), so a download stays compressed and named .sql.gz.
    httpMetadata: { contentType: "application/gzip", contentDisposition: `attachment; filename="${key.slice(BACKUP_PREFIX.length)}"` },
    customMetadata: { rows: JSON.stringify(dump.rows), takenAt: String(now) },
  });
  const deleted = await pruneBackups(env.MEDIA);
  await setSettingStatement(env.DB, "last_backup_at", now, now).run();
  return { ok: true, key, at: now, bytes: body.byteLength, rows: dump.rows, deleted };
}
