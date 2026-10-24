/**
 * Constants shared by the browser, the build and the Pages Functions. Plain values only, so this
 * file runs everywhere (Astro, Workers, Node tests).
 */
import type { MediaKind } from "./types.ts";

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

// ---------------------------------------------------------------- owner decisions (plan section 10)

/** Refund requests are accepted within 24 hours of purchase (plan 10.4). */
export const REFUND_WINDOW_HOURS = 24;
export const REFUND_WINDOW_SECONDS = REFUND_WINDOW_HOURS * 3600;

/** Access to recorded lessons: 1 year from purchase (plan 10.6). The admin form's default for access_days. */
export const DEFAULT_ACCESS_DAYS = 365;

/** Signed-in devices per student; a new sign-in beyond this revokes the oldest (plan 10.7). */
export const MAX_DEVICES_PER_STUDENT = 2;

/** Razorpay's minimum charge: ₹1. */
export const MIN_CHARGE_PAISE = 100;

// ---------------------------------------------------------------- input rules (W8: one definition each)
// The browser checks these before sending and the server checks them again, so both import them
// from here instead of keeping their own copies.

/**
 * A phone number as E.164, or null. Indian mobiles may be typed as 10 digits, with 0, 91 or +91 in
 * front, with spaces, dots, dashes or brackets; other countries need + and the country code.
 * Used by checkout (W2), the data layer's phone() (W0), and the admin's forms (W6).
 */
export function normalizePhone(value: string): string | null {
  const compact = value.replace(/[\s().-]/g, "");
  const indian = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(compact);
  if (indian) return `+91${indian[1]}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact) && !compact.startsWith("+91")) return compact;
  return null;
}

/** A 15-character GSTIN, uppercase. Kept for the owner's records only (no GSTIN is ever shown). */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const MiB = 1024 * 1024;

/**
 * What the admin may upload (W4's rules, functions/_lib/media-rules.ts): content type → allowed
 * file extensions, and the largest file, per media kind. The admin's file picker (W6) checks them
 * before a byte is sent.
 */
export const MEDIA_FILE_TYPES: Readonly<Record<MediaKind, Readonly<Record<string, readonly string[]>>>> = {
  video: { "video/mp4": ["mp4", "m4v"], "video/webm": ["webm"] },
  image: { "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"] },
  captions: { "text/vtt": ["vtt"] },
  file: { "application/pdf": ["pdf"] },
};
export const MEDIA_MAX_BYTES: Readonly<Record<MediaKind, number>> = {
  video: 4 * 1024 * MiB,
  image: 10 * MiB,
  captions: 1 * MiB,
  file: 50 * MiB,
};

/** The file extension of a name, lowercase, without the dot, or "". */
export function extensionOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  return m ? m[1]!.toLowerCase() : "";
}
