/**
 * Wording derived from src/data/course.ts and src/data/site.ts, so every section says the same
 * thing in the same words. Nothing here is a new fact: each string is built from the data files.
 */
import { course, lessonCount, totalMinutes } from "../../data/course";
import { site } from "../../data/site";

/** "1 lesson", "9 lessons" */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const lessonsLabel = plural(lessonCount, "lesson");
export const minutesLabel = plural(totalMinutes, "minute");
/** "9 lessons · 88 min" */
export const lessonsAndMinutes = `${lessonsLabel} · ${totalMinutes} min`;

const allMinutes = course.modules.flatMap((m) => m.lessons.map((l) => l.minutes));
const shortest = Math.min(...allMinutes);
const longest = Math.max(...allMinutes);
/** "6 to 15 minutes each" */
export const lessonLengthLabel = shortest === longest ? `${plural(shortest, "minute")} each` : `${shortest} to ${longest} minutes each`;

export const moduleMinutes = (m: (typeof course.modules)[number]) => m.lessons.reduce((s, l) => s + l.minutes, 0);

export const accessLabel = `Access for ${course.access}`;

/** "Oct 2026": the month the owner confirmed the Google rating. */
export const ratingMonth = new Date(`${site.googleRating.asOf}T00:00:00Z`).toLocaleDateString("en-IN", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
export const ratingCount = site.googleRating.count.toLocaleString("en-IN");

/** "Om Residency, Hirji Mistry Road, Near J J Tower, Jamnagar, Gujarat 361006" */
export const addressLine = [
  site.address.street,
  site.address.landmark,
  site.address.city,
  `${site.address.region} ${site.address.postalCode}`,
].join(", ");

/** "feelingsbeautycare" from the Instagram profile URL. */
export const instagramHandle = new URL(site.social.instagram).pathname.split("/").filter(Boolean)[0] ?? site.name;

/** "feelingsbeautycare.in" */
export const mainHost = new URL(site.mainUrl).host;

/** "Urmi" */
export const teacherFirstName = course.teacher.split(" ")[0];

/** The access period split for a big numeral: "12 months" -> { value: "12", unit: "months" }. */
export const accessParts = (() => {
  const m = /^(\d+)\s+(.+)$/.exec(course.access);
  return m ? { value: m[1], unit: `${m[2]} access` } : { value: course.access, unit: "access" };
})();
