/**
 * The smallest part of Cloudflare D1's API that the data layer uses.
 *
 * Cloudflare's `D1Database` (and a `D1DatabaseSession` from `withSession()`) fit this interface as
 * they are, so a Pages Function or an Astro endpoint passes `env.DB` straight in. The tests pass a
 * node:sqlite shim with the same shape (tests/helpers/d1.mjs). Nothing here imports
 * @cloudflare/workers-types, so the module type-checks in both the Workers and the Astro project.
 *
 * Rules the data layer keeps, because D1 has them:
 * - Bound values are only string, number or null. Never undefined or boolean (booleans are 0/1).
 * - A statement uses either anonymous `?` or ordered `?1 ?2 ...` parameters, never both, and binds
 *   exactly as many values as it has parameters.
 * - There is no BEGIN/COMMIT. Writes that must happen together go in one `batch()`, which D1 runs
 *   as a single transaction: if one statement fails, none of them apply.
 */

export interface DbMeta {
  /** Rows changed by an INSERT, UPDATE or DELETE. */
  changes: number;
  last_row_id: number;
}

export interface DbResult<T = Record<string, unknown>> {
  results: T[];
  meta: DbMeta;
}

export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  /** The first row, or null when there is none. */
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<DbResult<T>>;
  run<T = Record<string, unknown>>(): Promise<DbResult<T>>;
}

export interface Db {
  prepare(query: string): DbStatement;
  /** Runs the statements in order, in one transaction. */
  batch<T = Record<string, unknown>>(statements: DbStatement[]): Promise<DbResult<T>[]>;
}

/** A value that may be bound to a statement. */
export type DbValue = string | number | null;

/** Current time as integer unix seconds (the unit of every timestamp column). */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export const DAY_SECONDS = 86_400;
