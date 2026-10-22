/**
 * Constants shared by the browser, the build and the Pages Functions. Plain values only, so this
 * file runs everywhere (Astro, Workers, Node tests).
 */

/** The hub: catalog, /learn, /account, /signin, /admin, /verify, legal pages, media. */
export const DEFAULT_HUB_HOST = "courses.feelingsbeautycare.in";
/** Course hosts are first-level labels of this domain: <slug>.feelingsbeautycare.in. */
export const DEFAULT_APEX_DOMAIN = "feelingsbeautycare.in";

/**
 * Labels that are never a course host (the salon's own names and infrastructure). A course slug
 * may not be one of these either.
 */
export const RESERVED_LABELS: readonly string[] = [
  "www",
  "courses",
  "admin",
  "api",
  "app",
  "mail",
  "review",
  "preview",
  "staging",
  "static",
  "cdn",
  "media",
  "blog",
  "shop",
  "book",
  "m",
  "salon",
  "academy",
  "bridal",
  "nails",
  "mehndi",
];

/**
 * A course slug, which is also a DNS label: 2 to 40 of a-z, 0-9 and single inner hyphens.
 * Same rule as the CHECK on courses.slug.
 */
export const COURSE_SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,39}$/;

/** A lesson slug: 1 to 80 of a-z, 0-9 and single inner hyphens (CHECK on lessons.slug). */
export const LESSON_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Lesson slugs the course area uses for itself. */
export const RESERVED_LESSON_SLUGS: readonly string[] = ["certificate", "logout", "index"];

/** True when `slug` may name a course (format and reserved list). */
export function isValidCourseSlug(slug: string): boolean {
  return COURSE_SLUG_RE.test(slug) && !RESERVED_LABELS.includes(slug);
}

/** Paths a course host serves from the hub's legal pages (/terms → /legal/terms). */
export const LEGAL_PAGES = ["terms", "refunds", "privacy", "delivery"] as const;
export type LegalPage = (typeof LEGAL_PAGES)[number];

/** Razorpay's minimum charge: ₹1. */
export const MIN_CHARGE_PAISE = 100;
