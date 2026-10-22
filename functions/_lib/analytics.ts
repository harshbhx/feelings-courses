/**
 * First-party funnel counters in daily_stats (plan 1.12). STUB: bump() signature frozen by W0,
 * body by W7.
 *
 * bump() returns a statement (an upsert on (day, course_id)) so callers put it in their own batch,
 * for example inside fulfilOrder. course_id 0 = hub pages.
 */
import type { IsoDate, StatField } from "../../src/shared/types.ts";
import type { Db, DbStatement } from "./db/d1.ts";
import { notImplemented } from "./stub.ts";

export function bump(db: Db, day: IsoDate, courseId: number, field: StatField, by = 1): DbStatement {
  return notImplemented("bump", "W7");
}

/** "YYYY-MM-DD" in India time (UTC+5:30), the day the owner thinks in. Every daily_stats day uses it. */
export function statDay(unixSeconds: number): IsoDate {
  return new Date((unixSeconds + 19_800) * 1000).toISOString().slice(0, 10);
}
