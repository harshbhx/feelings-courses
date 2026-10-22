/**
 * Dashboard numbers from GET /api/admin/stats: a complete day-by-day series (days without a row
 * count as zero), period totals, and the comparison with the period before.
 */
import type { DailyStat, IsoDate, Paise, Stats } from "../../../shared/types.ts";
import { addDays, daysBetween } from "./time.ts";

export interface DayPoint {
  day: IsoDate;
  views: number;
  checkoutsStarted: number;
  paidOrders: number;
  revenuePaise: Paise;
  refundsPaise: Paise;
}

export interface Totals {
  views: number;
  checkoutsStarted: number;
  paidOrders: number;
  revenuePaise: Paise;
  refundsPaise: Paise;
}

const zero = (day: IsoDate): DayPoint => ({ day, views: 0, checkoutsStarted: 0, paidOrders: 0, revenuePaise: 0, refundsPaise: 0 });

/** Every day from `from` to `to`, summing rows of the same day (the API may send one per course). */
export function fillSeries(series: DailyStat[], from: IsoDate, to: IsoDate): DayPoint[] {
  const byDay = new Map<IsoDate, DayPoint>();
  for (const day of daysBetween(from, to)) byDay.set(day, zero(day));
  for (const row of series) {
    const p = byDay.get(row.day);
    if (!p) continue;
    p.views += row.views;
    p.checkoutsStarted += row.checkoutsStarted;
    p.paidOrders += row.paidOrders;
    p.revenuePaise += row.revenuePaise;
    p.refundsPaise += row.refundsPaise;
  }
  return [...byDay.values()];
}

export function sum(points: DayPoint[]): Totals {
  return points.reduce<Totals>(
    (t, p) => ({
      views: t.views + p.views,
      checkoutsStarted: t.checkoutsStarted + p.checkoutsStarted,
      paidOrders: t.paidOrders + p.paidOrders,
      revenuePaise: t.revenuePaise + p.revenuePaise,
      refundsPaise: t.refundsPaise + p.refundsPaise,
    }),
    { views: 0, checkoutsStarted: 0, paidOrders: 0, revenuePaise: 0, refundsPaise: 0 },
  );
}

/** The range to ask the API for: this period plus the one before it, for the comparison. */
export function statsRange(today: IsoDate, days: number): { from: IsoDate; to: IsoDate; split: IsoDate } {
  const split = addDays(today, -(days - 1));
  return { from: addDays(split, -days), to: today, split };
}

/** Splits the filled series at `split`: [previous period, this period]. */
export function splitPeriods(points: DayPoint[], split: IsoDate): [DayPoint[], DayPoint[]] {
  return [points.filter((p) => p.day < split), points.filter((p) => p.day >= split)];
}

/** Whole-percent change, or null when there's nothing to compare against. */
export function change(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** Paid orders per 100 checkouts started, one decimal; null without checkouts. */
export function conversion(t: Pick<Totals, "paidOrders" | "checkoutsStarted">): number | null {
  if (!t.checkoutsStarted) return null;
  return Math.round((t.paidOrders / t.checkoutsStarted) * 1000) / 10;
}

/** A round axis maximum at or above `max` (paise), so gridlines land on tidy rupee values. */
export function niceMax(max: number): number {
  if (max <= 0) return 100_000;
  const steps = [1, 2, 2.5, 5];
  let magnitude = 10 ** Math.floor(Math.log10(max / 3));
  for (;;) {
    for (const s of steps) if (s * magnitude * 3 >= max) return s * magnitude * 3;
    magnitude *= 10;
  }
}

export type { Stats };
