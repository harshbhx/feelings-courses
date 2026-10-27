/**
 * In-person batches (W5): the dates students book for an in_person or hybrid course.
 *
 * - seats NULL means no limit. seats can't go below seats_taken (W2's fulfil counts bookings).
 * - price_paise NULL means the course fee applies.
 * - A batch nobody booked can be deleted; once it has orders or enrollments it can only be closed
 *   or cancelled (business rows are never hard deleted).
 * - Changes on a published course bump content_version (batches are on the landing page).
 */
import type { AdminBatch, BatchStatus } from "../../../src/shared/types.ts";
import { auditStatement } from "../db/audit.ts";
import type { Db } from "../db/d1.ts";
import { ConflictError, ValidationError, isCheckViolation } from "../db/errors.ts";
import { bumpContentVersionStatement } from "../db/settings.ts";
import { batch, lastId } from "../db/tx.ts";
import * as v from "../db/validate.ts";
import { ADMIN_ACTOR } from "./auth.ts";
import { BATCH_COLUMNS, MAX_PRICE_PAISE, courseRow, mapBatch, takesBatches, type BatchRow } from "./courses.ts";
import { NotFoundError, isIsoDate } from "./request.ts";

export const BATCH_STATUSES: readonly BatchStatus[] = ["open", "closed", "cancelled"];
export const MAX_SEATS = 10_000;

interface BatchValues {
  title: string;
  starts_on: string;
  ends_on: string | null;
  schedule_text: string | null;
  price_paise: number | null;
  seats: number | null;
  status: BatchStatus;
}

function isoDate(value: unknown, field: string): string {
  if (!isIsoDate(value)) throw new ValidationError(field, `${field} must be a date like 2026-11-02.`);
  return value;
}

/** Checks a batch body. On edit, fields left out keep their value. */
export function batchValues(input: Record<string, unknown>, current: BatchRow | null): BatchValues {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  const pick = <T>(key: string, column: keyof BatchRow, check: (value: unknown) => T, fallback?: unknown): T =>
    current && !has(key) ? (current[column] as T) : check(has(key) ? input[key] : fallback);

  const values: BatchValues = {
    title: pick("title", "title", (x) => v.text(x, "title", { max: 120 })),
    starts_on: pick("startsOn", "starts_on", (x) => isoDate(x, "startsOn")),
    ends_on: pick("endsOn", "ends_on", (x) => (v.isMissing(x) || x === "" ? null : isoDate(x, "endsOn"))),
    schedule_text: pick("scheduleText", "schedule_text", (x) => v.optionalText(x, "scheduleText", { max: 300 })),
    price_paise: pick("pricePaise", "price_paise", (x) => (v.isMissing(x) ? null : v.paise(x, "pricePaise", 100, MAX_PRICE_PAISE))),
    seats: pick("seats", "seats", (x) => v.optionalInt(x, "seats", 1, MAX_SEATS)),
    status: pick("status", "status", (x) => v.oneOf(x, "status", BATCH_STATUSES), "open"),
  };
  if (values.ends_on !== null && values.ends_on < values.starts_on) {
    throw new ValidationError("endsOn", "The batch can't end before it starts.");
  }
  if (current && values.seats !== null && values.seats < current.seats_taken) {
    throw new ValidationError("seats", `${current.seats_taken} seats are already booked.`);
  }
  return values;
}

async function batchRow(db: Db, id: number): Promise<BatchRow> {
  const row = await db
    .prepare(`SELECT ${BATCH_COLUMNS.split(", ").map((c) => `b.${c}`).join(", ")} FROM batches b JOIN courses c ON c.id = b.course_id WHERE b.id = ? AND c.deleted_at IS NULL`)
    .bind(id)
    .first<BatchRow>();
  if (!row) throw new NotFoundError("That batch doesn't exist.");
  return row;
}

export async function getBatch(db: Db, id: number): Promise<AdminBatch> {
  return mapBatch(await batchRow(db, id));
}

export async function listBatches(db: Db, courseId: number): Promise<AdminBatch[]> {
  await courseRow(db, courseId);
  const { results } = await db
    .prepare(`SELECT ${BATCH_COLUMNS} FROM batches WHERE course_id = ? ORDER BY starts_on, id`)
    .bind(courseId)
    .all<BatchRow>();
  return results.map(mapBatch);
}

export async function createBatch(db: Db, courseId: number, input: Record<string, unknown>, now: number): Promise<AdminBatch> {
  const course = await courseRow(db, courseId);
  if (!takesBatches(course.format)) {
    throw new ValidationError("format", "This is a recorded course. Set it to in-person or both to add batches.");
  }
  const values = batchValues(input, null);
  const result = await db
    .prepare(
      "INSERT INTO batches (course_id, title, starts_on, ends_on, schedule_text, price_paise, seats, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(courseId, values.title, values.starts_on, values.ends_on, values.schedule_text, values.price_paise, values.seats, values.status, now, now)
    .run()
    .catch(rethrow);
  const id = lastId(result);
  await batch(db, [
    course.status === "published" && bumpContentVersionStatement(db, now),
    auditStatement(db, { actor: ADMIN_ACTOR, action: "batch.create", entity: "batch", entityId: id, data: { courseId, ...values }, now }),
  ]);
  return getBatch(db, id);
}

export async function updateBatch(db: Db, id: number, input: Record<string, unknown>, now: number): Promise<AdminBatch> {
  const current = await batchRow(db, id);
  const course = await courseRow(db, current.course_id);
  const values = batchValues(input, current);
  const changed = (Object.keys(values) as (keyof BatchValues)[]).filter((k) => values[k] !== current[k]);
  if (changed.length === 0) return mapBatch(current);
  await batch(db, [
    db
      .prepare(`UPDATE batches SET ${changed.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...changed.map((c) => values[c]), now, id),
    course.status === "published" && bumpContentVersionStatement(db, now),
    auditStatement(db, {
      actor: ADMIN_ACTOR,
      action: "batch.update",
      entity: "batch",
      entityId: id,
      data: { changed, ...(changed.includes("status") ? { status: { from: current.status, to: values.status } } : {}) },
      now,
    }),
  ]).catch(rethrow);
  return getBatch(db, id);
}

/** Deletes a batch nobody booked. Booked batches must be closed or cancelled instead. */
export async function deleteBatch(db: Db, id: number, now: number): Promise<void> {
  const current = await batchRow(db, id);
  const course = await courseRow(db, current.course_id);
  const used = await db
    .prepare("SELECT (SELECT count(*) FROM orders WHERE batch_id = ?1) + (SELECT count(*) FROM enrollments WHERE batch_id = ?1) AS n")
    .bind(id)
    .first<{ n: number }>();
  if ((used?.n ?? 0) > 0 || current.seats_taken > 0) {
    throw new ConflictError("in_use", "This batch has bookings. Close or cancel it instead.");
  }
  await batch(db, [
    db.prepare("DELETE FROM batches WHERE id = ?").bind(id),
    course.status === "published" && bumpContentVersionStatement(db, now),
    auditStatement(db, { actor: ADMIN_ACTOR, action: "batch.delete", entity: "batch", entityId: id, data: { courseId: current.course_id, title: current.title }, now }),
  ]);
}

function rethrow(err: unknown): never {
  if (isCheckViolation(err)) throw new ValidationError("batch", "Some of these values aren't allowed.");
  throw err;
}
