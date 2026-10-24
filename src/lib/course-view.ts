/**
 * Wording for one course's landing page, derived from its PublicCourse (the build's snapshot), so
 * every section says the same thing in the same words. Nothing here is a new fact: each string is
 * built from the course's own fields. Plain TypeScript (no Astro imports), so Node tests run it.
 *
 * Formats (owner decision, plan 10.2): `online` (recorded lessons), `in_person` (studio batches
 * booked online) and `hybrid` (both). Sections pick their wording from `hasLessons` / `hasBatches`.
 */
import type { CourseFormat, Paise, PublicBatch, PublicCourse, PublicModule } from "../shared/types.ts";

/** "1 lesson", "9 lessons" */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const inrPaise = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });

/** 299900 → "₹2,999"; 299950 → "₹2,999.50"; 0 → "Free". */
export function formatInr(paise: Paise): string {
  if (paise === 0) return "Free";
  return paise % 100 === 0 ? inr.format(paise / 100) : inrPaise.format(paise / 100);
}

/** 365 → "12 months", 730 → "2 years", 90 → "3 months", 45 → "45 days". */
export function formatAccess(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? "12 months" : plural(years, "year");
  }
  if (days % 30 === 0) return plural(days / 30, "month");
  return plural(days, "day");
}

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
/** "2026-11-03" → "3 Nov 2026" (calendar dates, no time zone shift). */
export function formatDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDate : dateFmt.format(d);
}

/** "3 Nov 2026" or "3 Nov 2026 to 28 Feb 2027". */
export function batchDates(batch: Pick<PublicBatch, "startsOn" | "endsOn">): string {
  return batch.endsOn && batch.endsOn !== batch.startsOn
    ? `${formatDay(batch.startsOn)} to ${formatDay(batch.endsOn)}`
    : formatDay(batch.startsOn);
}

const partsFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", weekday: "short", timeZone: "UTC" });
/** "2026-11-04" → { day: "4", month: "Nov", weekday: "Wed" }, for a calendar-leaf date block. */
export function dayParts(isoDate: string): { day: string; month: string; weekday: string } | null {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(partsFmt.formatToParts(d).map((p) => [p.type, p.value]));
  return { day: parts.day ?? "", month: parts.month ?? "", weekday: parts.weekday ?? "" };
}

/** The soonest batch that still takes bookings (a seat left, or no limit), or null. */
export function nextOpenBatch(batches: readonly PublicBatch[]): PublicBatch | null {
  return batches.find((b) => b.seatsLeft !== 0) ?? null;
}

/** Few enough seats that the number deserves the accent: 5 or fewer (a real count, never a timer). */
export const FEW_SEATS = 5;

/** "4 seats left", "Full", or null when the batch has no seat limit. */
export function seatsLabel(batch: Pick<PublicBatch, "seatsLeft">): string | null {
  if (batch.seatsLeft === null) return null;
  return batch.seatsLeft === 0 ? "Full" : `${plural(batch.seatsLeft, "seat")} left`;
}

export const FORMAT_LABEL: Record<CourseFormat, string> = {
  online: "Online course",
  in_person: "Studio course",
  hybrid: "Studio and online course",
};

export const moduleMinutes = (m: PublicModule) => m.lessons.reduce((s, l) => s + l.minutes, 0);

export interface CourseView {
  course: PublicCourse;
  formatLabel: string;
  /** "Online course by Urmi Mengar" */
  eyebrow: string;
  teacherFirstName: string;
  priceDisplay: string;
  compareAtDisplay: string | null;
  /** Booking amount for studio batches (balance paid at the studio), or null. */
  depositDisplay: string | null;
  /** What the main button charges: the deposit when there is one, else the price. */
  payNowDisplay: string;
  /** "Enroll for ₹2,999" or "Book for ₹2,000" */
  enrollLabel: string;
  lessonCount: number;
  totalMinutes: number;
  moduleCount: number;
  lessonsLabel: string;
  minutesLabel: string;
  /** "6 to 15 minutes each", or null without lessons. */
  lessonLengthLabel: string | null;
  /** "12 months", or null when the course sets no access period. */
  accessText: string | null;
  /** "Access for 12 months", or null. */
  accessLabel: string | null;
  /** The access period split for a big numeral: { value: "12", unit: "months access" }. */
  accessParts: { value: string; unit: string } | null;
  /** Recorded lessons to watch. */
  hasLessons: boolean;
  /** Studio batches are part of the course (in_person or hybrid). */
  hasBatches: boolean;
  /** Up to three key facts for the hero, as big numerals. */
  stats: { value: string; unit: string }[];
  /** A short description for meta tags and cards (SEO description, subtitle, or the first line). */
  summary: string;
}

/** The first sentence-ish of a text, at most `max` characters, cut on a word. */
export function clip(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[,.;:!?-]+$/, "")}…`;
}

export function courseView(course: PublicCourse): CourseView {
  const lessons = course.modules.flatMap((m) => m.lessons);
  const lessonCount = lessons.length;
  const totalMinutes = lessons.reduce((s, l) => s + l.minutes, 0);
  const minutes = lessons.map((l) => l.minutes).filter((n) => n > 0);
  const shortest = minutes.length ? Math.min(...minutes) : 0;
  const longest = minutes.length ? Math.max(...minutes) : 0;
  const hasBatches = course.format !== "online";
  const hasLessons = course.format !== "in_person" && lessonCount > 0;
  const accessText = course.accessDays ? formatAccess(course.accessDays) : null;
  const accessMatch = accessText ? /^(\d+)\s+(.+)$/.exec(accessText) : null;
  const priceDisplay = formatInr(course.pricePaise);
  const depositDisplay = hasBatches && course.depositPaise ? formatInr(course.depositPaise) : null;
  const payNowDisplay = depositDisplay ?? priceDisplay;
  const teacherFirstName = course.teacher.split(" ")[0] ?? course.teacher;

  const stats: { value: string; unit: string }[] = [];
  if (hasLessons) {
    stats.push({ value: String(lessonCount), unit: lessonCount === 1 ? "lesson" : "lessons" });
    if (totalMinutes > 0) stats.push({ value: String(totalMinutes), unit: "minutes" });
  }
  const duration = course.durationText ? /^(\S+)\s+(.+)$/.exec(course.durationText) : null;
  if (hasBatches && duration) stats.push({ value: duration[1]!, unit: duration[2]! });
  if (hasBatches && course.batches.length > 0) {
    stats.push({ value: String(course.batches.length), unit: course.batches.length === 1 ? "batch open" : "batches open" });
  }
  if (hasLessons && accessText) {
    stats.push(accessMatch ? { value: accessMatch[1]!, unit: `${accessMatch[2]} access` } : { value: accessText, unit: "access" });
  }

  const summary = clip(course.seoDescription ?? course.subtitle ?? course.description ?? `${FORMAT_LABEL[course.format]} by ${course.teacher}.`);

  return {
    course,
    formatLabel: FORMAT_LABEL[course.format],
    eyebrow: `${FORMAT_LABEL[course.format]} by ${course.teacher}`,
    teacherFirstName,
    priceDisplay,
    compareAtDisplay: course.compareAtPaise ? formatInr(course.compareAtPaise) : null,
    depositDisplay,
    payNowDisplay,
    enrollLabel: depositDisplay ? `Book for ${depositDisplay}` : `Enroll for ${priceDisplay}`,
    lessonCount,
    totalMinutes,
    moduleCount: course.modules.filter((m) => m.lessons.length > 0).length,
    lessonsLabel: plural(lessonCount, "lesson"),
    minutesLabel: plural(totalMinutes, "minute"),
    lessonLengthLabel:
      minutes.length === 0 ? null : shortest === longest ? `${plural(shortest, "minute")} each` : `${shortest} to ${longest} minutes each`,
    accessText,
    accessLabel: accessText ? `Access for ${accessText}` : null,
    accessParts: accessText ? (accessMatch ? { value: accessMatch[1]!, unit: `${accessMatch[2]} access` } : { value: accessText, unit: "access" }) : null,
    hasLessons,
    hasBatches,
    stats: stats.slice(0, 3),
    summary,
  };
}
