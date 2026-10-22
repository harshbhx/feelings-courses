/**
 * Dates and times for the admin, always in India time (Asia/Kolkata, UTC+5:30, no daylight saving),
 * whatever the browser's own time zone is. The API speaks unix seconds and "YYYY-MM-DD" India days.
 *
 * Pure functions: no DOM, so tests/w6 runs them in Node.
 */
import type { IsoDate, Unix } from "../../../shared/types.ts";

/** India is UTC+5:30 all year. */
export const IST_OFFSET_SECONDS = 5.5 * 3600;
const TZ = "Asia/Kolkata";

const pad = (n: number) => String(n).padStart(2, "0");

/** The India-time calendar day of a unix time: "2026-10-23". */
export function istDay(unix: Unix): IsoDate {
  const d = new Date((unix + IST_OFFSET_SECONDS) * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Unix time of 00:00 India time on `day`. Null for anything that isn't a real date. */
export function istDayStart(day: string): Unix | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return ms / 1000 - IST_OFFSET_SECONDS;
}

/** True for a real "YYYY-MM-DD" date. */
export function isIsoDate(value: unknown): value is IsoDate {
  return typeof value === "string" && istDayStart(value) !== null;
}

/** `day` moved by `delta` days. */
export function addDays(day: IsoDate, delta: number): IsoDate {
  const start = istDayStart(day);
  if (start === null) throw new Error(`addDays: "${day}" is not a date`);
  return istDay(start + delta * 86400 + 3600);
}

/** Every day from `from` to `to`, inclusive. */
export function daysBetween(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  let day = from;
  for (let i = 0; i < 1000 && day <= to; i++) {
    out.push(day);
    day = addDays(day, 1);
  }
  return out;
}

/** The value for an `<input type="datetime-local">`, in India time: "2026-10-23T18:30". */
export function istInputValue(unix: Unix | null): string {
  if (unix === null) return "";
  const d = new Date((unix + IST_OFFSET_SECONDS) * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Reads a datetime-local value as India time. "" → null; anything malformed → undefined. */
export function unixFromIstInput(value: string): Unix | null | undefined {
  const v = value.trim();
  if (!v) return null;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(v);
  if (!m) return undefined;
  const start = istDayStart(m[1]!);
  const hh = Number(m[2]);
  const mm = Number(m[3]);
  if (start === null || hh > 23 || mm > 59) return undefined;
  return start + hh * 3600 + mm * 60;
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });
const dayMonthFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true });
const longFmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });

/** "23 Oct 2026" */
export const istDate = (unix: Unix) => dateFmt.format(unix * 1000);
/** "23 Oct" */
export const istDayMonth = (unix: Unix) => dayMonthFmt.format(unix * 1000);
/** "6:30 pm" */
export const istTime = (unix: Unix) => timeFmt.format(unix * 1000).replace(/\s?([AP])M$/i, (_, p: string) => ` ${p.toLowerCase()}m`);
/** "23 Oct 2026, 6:30 pm" */
export const istDateTime = (unix: Unix) => `${istDate(unix)}, ${istTime(unix)}`;
/** "Friday, 23 October" */
export const istLongDate = (unix: Unix) => longFmt.format(unix * 1000);

/** A "YYYY-MM-DD" day as "23 Oct 2026" (no time zone shift: it is already a calendar day). */
export function dayLabel(day: IsoDate, withYear = true): string {
  const start = istDayStart(day);
  if (start === null) return day;
  return withYear ? istDate(start + 3600) : istDayMonth(start + 3600);
}

/** "Just now", "12 min ago", "3 h ago", "Yesterday, 4:05 pm", "21 Oct, 4:05 pm", "21 Oct 2025". */
export function ago(unix: Unix, now: Unix): string {
  const diff = Math.max(0, now - unix);
  if (diff < 60) return "Just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  const today = istDay(now);
  if (istDay(unix) === today) return `${Math.floor(diff / 3600)} h ago`;
  if (istDay(unix) === addDays(today, -1)) return `Yesterday, ${istTime(unix)}`;
  if (istDay(unix).slice(0, 4) === today.slice(0, 4)) return `${istDayMonth(unix)}, ${istTime(unix)}`;
  return istDate(unix);
}

/** "about 3 minutes", "about 2 hours", "a few seconds": for waits and time left. */
export function roughDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 45) return "a few seconds";
  if (s < 90) return "about a minute";
  const min = Math.round(s / 60);
  if (min < 60) return `about ${min} minutes`;
  const h = Math.round(s / 3600);
  if (h < 2) return "about an hour";
  if (h < 48) return `about ${h} hours`;
  return `about ${Math.round(s / 86400)} days`;
}

/** "5 h 12 min", "38 min", "under a minute": exact-ish time left, for the refund window. */
export function timeLeft(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return "under a minute";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Unix seconds now. */
export const unixNow = () => Math.floor(Date.now() / 1000);
