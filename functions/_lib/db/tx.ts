/**
 * Batch ("transaction") helpers. D1 has no BEGIN/COMMIT: statements that must apply together go
 * in one `db.batch()`, which runs them in one transaction (all or none).
 *
 * The pattern for conditional work inside one batch (plan 1.9, fulfilOrder):
 *   1. the first statement makes the change that decides everything, with a WHERE that only
 *      matches once (UPDATE orders SET status = 'paid' … WHERE id = ? AND status IN (…));
 *   2. every later statement is written as INSERT … SELECT … WHERE EXISTS (<proof the first one
 *      applied in this batch>), or UPDATE … WHERE … AND EXISTS (…), so a second, racing batch
 *      changes nothing;
 *   3. the caller reads `changes(results[0])` to tell "did it" from "already done".
 * `whenExists()` builds the EXISTS fragment for step 2.
 */
import type { Db, DbResult, DbStatement, DbValue } from "./d1.ts";

/** A statement or a skipped slot (so callers can write `cond && stmt`). */
export type MaybeStatement = DbStatement | null | undefined | false;

/** Runs the statements in one transaction, skipping empty slots. Returns one result per statement run. */
export async function batch<T = Record<string, unknown>>(db: Db, statements: readonly MaybeStatement[]): Promise<DbResult<T>[]> {
  const list = statements.filter((s): s is DbStatement => Boolean(s));
  if (list.length === 0) return [];
  return db.batch<T>(list);
}

/** Rows changed by a write. */
export function changes(result: DbResult<unknown> | undefined): number {
  return result?.meta.changes ?? 0;
}

/** The rowid of the last INSERT. */
export function lastId(result: DbResult<unknown>): number {
  return result.meta.last_row_id;
}

/** "?, ?, ?" for an IN list of `count` values. Throws for 0 (an empty IN list is a bug upstream). */
export function placeholders(count: number): string {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("placeholders: count must be at least 1");
  return Array.from({ length: count }, () => "?").join(", ");
}

/** D1 allows at most 100 bound parameters per statement. */
export const MAX_BOUND_PARAMS = 100;

/** Splits `values` into chunks of at most `size` (for IN lists over the parameter limit). */
export function chunked<T>(values: readonly T[], size = MAX_BOUND_PARAMS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * A guard condition: `EXISTS (SELECT 1 FROM <table> WHERE <where>)`, with its parameters. `table`
 * and `where` are fixed SQL written in code, never request text.
 */
export function whenExists(table: string, where: string, params: DbValue[]): { sql: string; params: DbValue[] } {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("whenExists: bad table name");
  return { sql: `EXISTS (SELECT 1 FROM ${table} WHERE ${where})`, params };
}

/** Prepares `sql` and binds `params` (a small convenience for building batches). */
export function stmt(db: Db, sql: string, ...params: DbValue[]): DbStatement {
  return params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
}
