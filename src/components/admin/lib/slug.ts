/**
 * Course and lesson web addresses. A course slug is also its subdomain (<slug>.feelingsbeautycare.in),
 * so it follows DNS rules; the checks match the API's (functions/_lib/admin/courses.ts) so the form
 * can say what's wrong before saving.
 */
import {
  COURSE_SLUG_RE,
  DEFAULT_APEX_DOMAIN,
  DEFAULT_HUB_HOST,
  LESSON_SLUG_RE,
  RESERVED_LABELS,
  RESERVED_LESSON_SLUGS,
} from "../../../shared/constants.ts";

/** Lowercase ascii words joined by single hyphens, from any title. */
function words(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Cuts a slug to `max` characters at a hyphen when it can, never leaving a trailing hyphen. */
function cut(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const short = slug.slice(0, max);
  const at = short.lastIndexOf("-");
  return (at >= Math.floor(max / 2) ? short.slice(0, at) : short).replace(/-+$/, "");
}

/** A suggested course slug for a title: "Bridal Makeup & Hair" → "bridal-makeup-and-hair". */
export function courseSlugFrom(title: string): string {
  const slug = cut(words(title), 40);
  if (slug.length >= 2 && !RESERVED_LABELS.includes(slug)) return slug;
  if (slug.length >= 2) return cut(`${slug}-course`, 40);
  return "";
}

/** Tidies what someone types into the slug field (lowercase, spaces to hyphens), keeping it editable. */
export function tidyCourseSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40);
}

/** Why a course slug can't be used, or null when it can. Same wording as the API. */
export function courseSlugProblem(slug: string): string | null {
  const s = slug.trim().toLowerCase();
  if (!s) return "Choose the course's web address.";
  if (RESERVED_LABELS.includes(s)) return `"${s}" is reserved. Choose another web address.`;
  if (!COURSE_SLUG_RE.test(s)) return 'Use 2 to 40 lowercase letters, digits or single hyphens, like "bridal-basics".';
  return null;
}

/** A lesson slug from its title, unique among `taken`: "Soft glam" → "soft-glam", then "soft-glam-2". */
export function lessonSlugFrom(title: string, taken: ReadonlySet<string> = new Set()): string {
  let base = cut(words(title), 72) || "lesson";
  if (RESERVED_LESSON_SLUGS.includes(base) || /^tmp-reorder-\d+$/.test(base)) base = `${base}-lesson`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
}

/** Why a lesson slug can't be used, or null. */
export function lessonSlugProblem(slug: string): string | null {
  const s = slug.trim().toLowerCase();
  if (!s) return "Give the lesson a web address.";
  if (s.length > 80 || !LESSON_SLUG_RE.test(s)) return 'Use lowercase words joined by hyphens, like "soft-glam".';
  if (RESERVED_LESSON_SLUGS.includes(s) || /^tmp-reorder-\d+$/.test(s)) return `"${s}" is reserved. Choose another.`;
  return null;
}

export interface CourseAddresses {
  /** bridal-basics.feelingsbeautycare.in */
  host: string;
  /** https://bridal-basics.feelingsbeautycare.in/ */
  subdomainUrl: string;
  /** https://courses.feelingsbeautycare.in/c/bridal-basics (always works, even before the subdomain). */
  hubUrl: string;
}

/** Where a course lives on the web. */
export function courseAddresses(slug: string, apex = DEFAULT_APEX_DOMAIN, hub = DEFAULT_HUB_HOST): CourseAddresses {
  const host = `${slug}.${apex}`;
  return { host, subdomainUrl: `https://${host}/`, hubUrl: `https://${hub}/c/${slug}` };
}

/**
 * A YouTube video id from an id or any YouTube link people paste (watch, youtu.be, shorts, embed,
 * live). Null when there isn't one.
 */
export function youtubeId(input: string): string | null {
  const v = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(v)) return v;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname);
      id = m ? m[1]! : null;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}
