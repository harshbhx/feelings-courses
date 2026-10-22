/**
 * Runtime self-migration (plan 1.15). The owner never runs a migration command: the first request
 * in each isolate brings the D1 database up to date.
 *
 * - Bookkeeping is wrangler's own table, `d1_migrations` (same columns, same names: the file name
 *   with ".sql"), so `wrangler d1 migrations apply` and this module always agree.
 * - Each missing migration is applied as ONE batch: its statements plus its d1_migrations row.
 *   D1 runs a batch as a transaction, so a migration is applied entirely or not at all.
 * - Two isolates racing: the loser's batch fails (table exists / unique name) and rolls back; it
 *   then re-reads d1_migrations, sees the migration applied, and carries on.
 * - Statements come from functions/_generated/migrations.ts, embedded at build time by
 *   scripts/embed-migrations.mjs from migrations/*.sql.
 *
 * Rule for migration authors: additive and backward compatible only (no DROP or rename in the
 * release that stops using a column). Old code keeps running during a deploy.
 */
import type { Db } from "./db/d1.ts";
import { MIGRATIONS } from "../_generated/migrations.ts";

export interface Migration {
  /** File name, "0001_init.sql". */
  name: string;
  statements: string[];
}

/** wrangler's table, created exactly as wrangler creates it. */
export const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS d1_migrations(
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

async function appliedNames(db: Db): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>();
  return new Set(results.map((r) => r.name));
}

/**
 * Applies every migration not yet in d1_migrations, in order. Returns the names it applied (a
 * racing isolate's migrations are not included). Throws if a migration fails for any reason other
 * than having been applied concurrently.
 */
export async function applyMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<string[]> {
  await db.prepare(MIGRATIONS_TABLE_SQL).run();
  let done = await appliedNames(db);
  const applied: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) continue;
    const statements = [
      ...migration.statements.map((sql) => db.prepare(sql)),
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(migration.name),
    ];
    try {
      await db.batch(statements);
      applied.push(migration.name);
    } catch (err) {
      done = await appliedNames(db);
      if (done.has(migration.name)) continue; // another isolate applied it first
      throw new Error(`migration ${migration.name} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return applied;
}

let ready: Promise<void> | null = null;

/**
 * Migrates once per isolate. Concurrent requests share one run; after a failure the next request
 * tries again.
 */
export function ensureMigrated(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  if (!ready) {
    ready = applyMigrations(db, migrations).then(
      (names) => {
        if (names.length) console.log(`migrate: applied ${names.join(", ")}`);
      },
      (err) => {
        ready = null;
        throw err;
      },
    );
  }
  return ready;
}

/** Tests only: forget that this isolate has migrated. */
export function resetMigrationState(): void {
  ready = null;
}
