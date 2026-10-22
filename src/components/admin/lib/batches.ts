/** In-person batches: the batch form and how a batch reads in lists. */
import type { AdminBatchRequest } from "../../../shared/api.ts";
import type { AdminBatch, BatchStatus } from "../../../shared/types.ts";
import { formatPaise, paiseToInput, parseRupees } from "./money.ts";
import { dayLabel, isIsoDate } from "./time.ts";

export interface BatchFormValues {
  title: string;
  startsOn: string;
  endsOn: string;
  scheduleText: string;
  /** "" = the course fee. */
  price: string;
  /** "" = no limit. */
  seats: string;
  status: BatchStatus;
}

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = { open: "Open for booking", closed: "Booking closed", cancelled: "Cancelled" };

export function blankBatchForm(): BatchFormValues {
  return { title: "", startsOn: "", endsOn: "", scheduleText: "", price: "", seats: "", status: "open" };
}

export function batchForm(b: AdminBatch): BatchFormValues {
  return {
    title: b.title,
    startsOn: b.startsOn,
    endsOn: b.endsOn ?? "",
    scheduleText: b.scheduleText ?? "",
    price: paiseToInput(b.pricePaise),
    seats: b.seats === null ? "" : String(b.seats),
    status: b.status,
  };
}

export type BatchResult = { ok: true; input: AdminBatchRequest } | { ok: false; errors: Record<string, string> };

export function batchInput(v: BatchFormValues, seatsTaken = 0): BatchResult {
  const errors: Record<string, string> = {};
  const title = v.title.trim();
  if (!title) errors.title = "Name the batch, like “November weekend batch”.";
  else if (title.length > 120) errors.title = "Keep the name under 120 characters.";
  if (!isIsoDate(v.startsOn)) errors.startsOn = "Choose the start date.";
  let endsOn: string | null = null;
  if (v.endsOn) {
    if (!isIsoDate(v.endsOn)) errors.endsOn = "Choose a real date.";
    else if (isIsoDate(v.startsOn) && v.endsOn < v.startsOn) errors.endsOn = "The end can't be before the start.";
    else endsOn = v.endsOn;
  }
  const scheduleText = v.scheduleText.trim();
  if (scheduleText.length > 300) errors.scheduleText = "Keep the schedule under 300 characters.";
  const price = parseRupees(v.price);
  let pricePaise: number | null = null;
  if (!price.ok) errors.pricePaise = price.error;
  else if (price.paise !== null && price.paise < 100) errors.pricePaise = "A batch fee is at least ₹1 (leave empty to use the course fee).";
  else pricePaise = price.paise;
  let seats: number | null = null;
  if (v.seats.trim()) {
    const n = v.seats.trim();
    if (!/^\d+$/.test(n) || Number(n) < 1 || Number(n) > 10_000) errors.seats = "Seats are 1 to 10,000, or empty for no limit.";
    else if (Number(n) < seatsTaken) errors.seats = `${seatsTaken} seats are already booked.`;
    else seats = Number(n);
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { title, startsOn: v.startsOn, endsOn, scheduleText: scheduleText || null, pricePaise, seats, status: v.status } };
}

/** "12 Nov – 14 Nov 2026", "12 Nov 2026". */
export function batchDates(b: Pick<AdminBatch, "startsOn" | "endsOn">): string {
  if (!b.endsOn || b.endsOn === b.startsOn) return dayLabel(b.startsOn);
  const sameYear = b.startsOn.slice(0, 4) === b.endsOn.slice(0, 4);
  return `${dayLabel(b.startsOn, !sameYear)} – ${dayLabel(b.endsOn)}`;
}

/** "8 of 12 seats booked", "8 booked (no limit)". */
export function seatsLabel(b: Pick<AdminBatch, "seats" | "seatsTaken">): string {
  return b.seats === null ? `${b.seatsTaken} booked (no limit)` : `${b.seatsTaken} of ${b.seats} seats booked`;
}

/** "₹4,999" or "Course fee". */
export function batchPrice(b: Pick<AdminBatch, "pricePaise">): string {
  return b.pricePaise === null ? "Course fee" : formatPaise(b.pricePaise);
}
