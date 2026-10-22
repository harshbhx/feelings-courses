/**
 * First-party funnel counters in daily_stats (plan 1.12, W7). No cookies, no third parties: one row
 * per (India-time day, course), course_id 0 = hub pages.
 *
 * bump() returns a statement (an upsert on (day, course_id)) so callers put it in their own batch,
 * for example inside fulfilOrder, and the counter moves with the change it counts.
 */
import type { IsoDate, StatField } from "../../src/shared/types.ts";
import type { Db, DbStatement } from "./db/d1.ts";

/** The counters bump() may touch. The column name goes into SQL, so it is checked against this list. */
export const STAT_FIELDS: readonly StatField[] = ["views", "checkouts_started", "paid_orders", "revenue_paise", "refunds_paise"];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function bump(db: Db, day: IsoDate, courseId: number, field: StatField, by = 1): DbStatement {
  if (!STAT_FIELDS.includes(field)) throw new Error(`analytics: unknown counter "${String(field)}"`);
  if (!DAY_RE.test(day)) throw new Error(`analytics: bad day "${day}"`);
  if (!Number.isSafeInteger(courseId) || courseId < 0) throw new Error(`analytics: bad course id ${courseId}`);
  if (!Number.isSafeInteger(by)) throw new Error(`analytics: bad increment ${by}`);
  return db
    .prepare(
      `INSERT INTO daily_stats (day, course_id, ${field}) VALUES (?, ?, ?) ` +
        `ON CONFLICT (day, course_id) DO UPDATE SET ${field} = ${field} + excluded.${field}`,
    )
    .bind(day, courseId, by);
}

/** "YYYY-MM-DD" in India time (UTC+5:30), the day the owner thinks in. Every daily_stats day uses it. */
export function statDay(unixSeconds: number): IsoDate {
  return new Date((unixSeconds + 19_800) * 1000).toISOString().slice(0, 10);
}
