/**
 * Audit log: who changed what, and when. Append only.
 *
 * Mutations in this module add their audit row to the same batch as the change itself (with
 * auditStatement), so a change and its log entry are committed together or not at all.
 */
import type { Db, DbStatement, DbValue } from "./d1.ts";
import { ValidationError } from "./errors.ts";
import * as v from "./validate.ts";

export interface AuditEntry {
  /** Who: "admin", "student:12", "razorpay", "system". Defaults to "system". */
  actor?: string;
  /** What, as noun.verb: "course.publish", "order.paid". */
  action: string;
  /** The kind of record: "course", "order", "coupon"... */
  entity: string;
  entityId?: string | number | null;
  /** Small JSON-serialisable details. Over 16,000 characters, only a note that it was cut is kept. */
  data?: unknown;
  now?: number;
}

export interface AuditRecord {
  id: number;
  actor: string;
  action: string;
  entity: string;
  entityId: string | null;
  data: unknown;
  createdAt: number;
}

interface AuditRow {
  id: number;
  actor: string;
  action: string;
  entity: string;
  entity_id: string | null;
  data: string | null;
  created_at: number;
}

const MAX_DATA = 16_000;

/** Checks an entry and returns the values for an audit_log row, in column order. */
function auditValues(entry: AuditEntry): DbValue[] {
  const actor = v.actor(entry.actor);
  if (typeof entry.action !== "string" || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(entry.action) || entry.action.length > 80) {
    throw new ValidationError("action", 'action must look like "course.publish".');
  }
  if (typeof entry.entity !== "string" || !/^[a-z][a-z0-9_]{0,39}$/.test(entry.entity)) {
    throw new ValidationError("entity", 'entity must look like "course".');
  }
  let entityId: string | null = null;
  if (!v.isMissing(entry.entityId)) {
    entityId = String(entry.entityId);
    if (entityId.length < 1 || entityId.length > 80) throw new ValidationError("entityId", "entityId must be 1 to 80 characters.");
  }
  let data: string | null = null;
  if (entry.data !== undefined) {
    data = JSON.stringify(entry.data) ?? null;
    if (data !== null && data.length > MAX_DATA) data = JSON.stringify({ truncated: true, length: data.length });
  }
  return [actor, entry.action, entry.entity, entityId, data, v.now(entry.now)];
}

/** An INSERT for the audit log, to put in a batch next to the change it records. */
export function auditStatement(db: Db, entry: AuditEntry): DbStatement {
  return db
    .prepare("INSERT INTO audit_log (actor, action, entity, entity_id, data, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(...auditValues(entry));
}

/**
 * Like auditStatement, but only inserts when `condition` holds when the batch reaches it. Used
 * where a change in the same batch is itself conditional (an order that is still unpaid), so the
 * log only records what really happened.
 *
 * `condition.sql` is a fixed SQL expression written in this module, never text from a request.
 * It uses anonymous `?` parameters, whose values go in `condition.params` (bound after the
 * entry's six values).
 */
export function auditStatementWhen(db: Db, entry: AuditEntry, condition: { sql: string; params: DbValue[] }): DbStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (actor, action, entity, entity_id, data, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${condition.sql}`,
    )
    .bind(...auditValues(entry), ...condition.params);
}

/** Writes one audit entry on its own. */
export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await auditStatement(db, entry).run();
}

export interface AuditQuery {
  entity?: string;
  entityId?: string | number;
  limit?: number;
  /** Only entries with an id below this one (for "load older"). */
  beforeId?: number;
}

/** Newest first. Filter by entity, or by entity and id. */
export async function listAuditLog(db: Db, query: AuditQuery = {}): Promise<AuditRecord[]> {
  const entity = v.isMissing(query.entity) ? null : v.text(query.entity, "entity", { max: 40 });
  const entityId = v.isMissing(query.entityId) ? null : String(query.entityId);
  const { limit } = v.page(query.limit, 0, 50);
  const beforeId = v.isMissing(query.beforeId) ? null : v.id(query.beforeId, "beforeId");
  if (entityId !== null && entity === null) throw new ValidationError("entity", "entity is required with entityId.");

  // Fixed fragments only, so the (entity, entity_id) index is used when filtering.
  const where: string[] = [];
  const params: DbValue[] = [];
  const filter = (sql: string, value: DbValue) => {
    where.push(sql);
    params.push(value);
  };
  if (entity !== null) filter("entity = ?", entity);
  if (entityId !== null) filter("entity_id = ?", entityId);
  if (beforeId !== null) filter("id < ?", beforeId);
  const { results } = await db
    .prepare(
      `SELECT id, actor, action, entity, entity_id, data, created_at
       FROM audit_log
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(...params, limit)
    .all<AuditRow>();
  return results.map((row) => ({
    id: row.id,
    actor: row.actor,
    action: row.action,
    entity: row.entity,
    entityId: row.entity_id,
    data: row.data === null ? null : JSON.parse(row.data),
    createdAt: row.created_at,
  }));
}
