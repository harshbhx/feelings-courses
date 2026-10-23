// A Cloudflare D1 stand-in on Node's built-in node:sqlite (Node >= 22.13), for tests.
//
//   import { createTestDb } from "../helpers/d1.mjs";
//   const db = await createTestDb();                 // schema + seed (every migrations/*.sql)
//   const empty = await createTestDb({ migrate: false });
//   const schemaOnly = await createTestDb({ only: ["0001_init.sql"] });
//
// It implements the part of D1's API the app uses (functions/_lib/db/d1.ts `Db`), with D1's rules:
// - prepare(sql).bind(...values) → first(column?), all(), run(), raw();
// - batch([...]) runs the statements in one transaction (all or none);
// - exec(sql) runs several statements;
// - bound values: string, number, null, ArrayBuffer/Uint8Array; booleans become 1/0 (as D1 does);
//   undefined is refused (D1_TYPE_ERROR), so bugs show up here first;
// - results look like D1's: { success, results, meta: { changes, last_row_id, ... } };
// - foreign keys are enforced, as on D1;
// - D1's lower limits (D1_LIMITS: 100 bound parameters, 5 compound SELECT terms, 50-byte LIKE
//   patterns) are refused, as D1 refuses them.
//
// Migrations are applied through the real functions/_lib/migrate.ts, with the same statement
// splitting as the build (scripts/lib/migrations.mjs).

import { DatabaseSync } from "node:sqlite";
import { loadMigrations } from "../../scripts/lib/migrations.mjs";
import { applyMigrations } from "../../functions/_lib/migrate.ts";

class D1TypeError extends Error {
  constructor(message) {
    super(`D1_TYPE_ERROR: ${message}`);
    this.name = "Error";
  }
}

function toBindable(value, index) {
  if (value === undefined) throw new D1TypeError(`Type 'undefined' not supported for value at index ${index}`);
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new D1TypeError(`Type '${typeof value}' not supported for value at index ${index}`);
}

// D1 runs SQLite with lower limits than node:sqlite's defaults. A statement over one of them works
// here but fails on Cloudflare (seen: the seed's 9-term UNION ALL, "too many terms in compound
// SELECT"). These are D1's documented limits, checked with `wrangler d1 execute --local`:
export const D1_LIMITS = {
  /** Bound parameters per statement. */
  boundParams: 100,
  /** Terms in one compound SELECT (UNION / UNION ALL / INTERSECT / EXCEPT chain). */
  compoundTerms: 5,
  /** Bytes in a LIKE or GLOB pattern. */
  likePatternBytes: 50,
};

const COMPOUND_RE = /\b(?:UNION|INTERSECT|EXCEPT)\b/gi;
const utf8Bytes = (s) => new TextEncoder().encode(s).length;

/**
 * Refuses what D1 refuses. The compound count is per statement (stricter than SQLite's per chain);
 * the LIKE check looks at bound strings that start or end with % in a statement with `LIKE ?`.
 */
export function checkD1Limits(sql, params = []) {
  if (params.length > D1_LIMITS.boundParams) {
    throw wrapError(new Error(`too many SQL variables (${params.length}; D1 allows ${D1_LIMITS.boundParams})`));
  }
  const code = sql.replace(/'(?:[^']|'')*'/g, "''");
  const terms = (code.match(COMPOUND_RE)?.length ?? 0) + 1;
  if (terms > D1_LIMITS.compoundTerms) throw wrapError(new Error(`too many terms in compound SELECT (${terms})`));
  if (/\b(?:LIKE|GLOB)\s+\?/i.test(code)) {
    for (const p of params) {
      if (typeof p === "string" && /^%|%$/.test(p) && utf8Bytes(p) > D1_LIMITS.likePatternBytes) {
        throw wrapError(new Error(`LIKE or GLOB pattern too complex (${utf8Bytes(p)} bytes)`));
      }
    }
  }
}

function wrapError(err) {
  if (err instanceof D1TypeError) return err;
  const e = new Error(`D1_ERROR: ${err?.message ?? String(err)}`, { cause: err });
  return e;
}

class Statement {
  constructor(db, sql, params = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values) {
    return new Statement(this.db, this.sql, values.map(toBindable));
  }

  /** Runs the statement and returns D1's result shape. Synchronous inside. */
  _exec() {
    checkD1Limits(this.sql, this.params);
    const sqlite = this.db.sqlite;
    const before = sqlite.prepare("SELECT total_changes() AS t").get().t;
    let rows;
    try {
      rows = sqlite.prepare(this.sql).all(...this.params);
    } catch (err) {
      throw wrapError(err);
    }
    const after = sqlite.prepare("SELECT total_changes() AS t, last_insert_rowid() AS id").get();
    const changes = after.t - before;
    return {
      success: true,
      results: rows.map((row) => ({ ...row })),
      meta: {
        changes,
        last_row_id: after.id,
        changed_db: changes > 0,
        duration: 0,
        rows_read: rows.length,
        rows_written: changes,
        size_after: 0,
      },
    };
  }

  async first(column) {
    const { results } = this._exec();
    const row = results[0] ?? null;
    if (column === undefined) return row;
    if (row === null) return null;
    if (!(column in row)) throw wrapError(new Error(`Column not found: ${column}`));
    return row[column];
  }

  async all() {
    return this._exec();
  }

  async run() {
    return this._exec();
  }

  async raw(options = {}) {
    const sqlite = this.db.sqlite;
    let stmt;
    try {
      stmt = sqlite.prepare(this.sql);
    } catch (err) {
      throw wrapError(err);
    }
    const rows = this._exec().results;
    const columns = stmt.columns ? stmt.columns().map((c) => c.name) : Object.keys(rows[0] ?? {});
    const values = rows.map((row) => columns.map((c) => row[c]));
    return options.columnNames ? [columns, ...values] : values;
  }
}

export class TestD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    /** Every SQL text prepared, in order (for tests that count queries). */
    this.log = [];
  }

  prepare(sql) {
    this.log.push(sql);
    return new Statement(this, sql);
  }

  async batch(statements) {
    if (!Array.isArray(statements)) throw new TypeError("batch() takes an array of statements");
    const sqlite = this.sqlite;
    sqlite.exec("BEGIN");
    try {
      const results = statements.map((s) => {
        if (!(s instanceof Statement)) throw new TypeError("batch() items must come from this database's prepare()");
        return s._exec();
      });
      sqlite.exec("COMMIT");
      return results;
    } catch (err) {
      sqlite.exec("ROLLBACK");
      throw err instanceof Error && err.message.startsWith("D1_") ? err : wrapError(err);
    }
  }

  async exec(sql) {
    try {
      this.sqlite.exec(sql);
    } catch (err) {
      throw wrapError(err);
    }
    return { count: sql.split(";").filter((s) => s.trim()).length, duration: 0 };
  }

  /** Synchronous helpers for assertions. */
  get(sql, ...params) {
    return this.sqlite.prepare(sql).get(...params.map(toBindable)) ?? null;
  }
  rows(sql, ...params) {
    return this.sqlite.prepare(sql).all(...params.map(toBindable));
  }

  close() {
    this.sqlite.close();
  }
}

/**
 * A fresh in-memory database. By default every migration in migrations/ is applied (schema and
 * seed). `only` limits it to the named files, `migrate: false` leaves it empty.
 */
export async function createTestDb({ migrate = true, only } = {}) {
  const db = new TestD1();
  if (migrate) {
    let migrations = loadMigrations();
    if (only) migrations = migrations.filter((m) => only.includes(m.name));
    await applyMigrations(db, migrations);
  }
  return db;
}

/** The migrations as the runtime sees them. */
export { loadMigrations };
