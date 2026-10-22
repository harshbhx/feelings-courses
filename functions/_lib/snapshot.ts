/**
 * The D1 → Snapshot query behind GET /api/public/snapshot (plan 1.1, W1). The build fetches it
 * (scripts/snapshot.mjs) and renders every public page from it.
 *
 * What goes in, and what never does:
 * - published, non-deleted courses that have a price, in the admin's order (sort_order, id);
 * - their modules and lessons, but never a video reference, captions key or notes: only
 *   `hasVideo`, so the public site can't leak a paid lesson's R2 key;
 * - open batches that haven't started yet (India time), soonest first, with seats left;
 * - the business facts WITHOUT the GSTIN (owner decision, plan 10.5: stored for records only);
 * - legal_confirmed, and testMode (true unless live Razorpay keys are set).
 *
 * One D1 round trip: the five reads go in one batch (D1 runs a batch as one transaction, so the
 * snapshot is consistent even while the admin is saving).
 *
 * Contract with scripts/snapshot.mjs: while the DB isn't bound (setup not run), the endpoint must
 * answer 404, never 5xx, or every production build fails (functions/api/public/snapshot.ts).
 */
import { isValidCourseSlug } from "../../src/shared/constants.ts";
import type {
  CourseDetails,
  CourseFormat,
  PublicBatch,
  PublicBusiness,
  PublicCourse,
  PublicLesson,
  PublicModule,
  Snapshot,
} from "../../src/shared/types.ts";
import { statDay } from "./analytics.ts";
import { config, type AppConfig } from "./config.ts";
import type { Db } from "./db/d1.ts";
import { unixNow } from "./db/d1.ts";
import type { Env } from "./env.ts";

interface CourseRow {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  teacher: string;
  format: CourseFormat;
  price_paise: number;
  compare_at_paise: number | null;
  deposit_paise: number | null;
  level: string | null;
  language: string | null;
  duration_text: string | null;
  access_days: number | null;
  certificate_title: string | null;
  details: string;
  cover_key: string | null;
  og_image_key: string | null;
  seo_title: string | null;
  seo_description: string | null;
  is_demo: number;
  domain_status: string;
}

interface ModuleRow {
  id: number;
  course_id: number;
  position: number;
  title: string;
}

interface LessonRow {
  id: number;
  course_id: number;
  module_id: number;
  slug: string;
  title: string;
  minutes: number;
  free_preview: number;
  vertical: number;
  has_video: number;
}

interface BatchRow {
  id: number;
  course_id: number;
  title: string;
  starts_on: string;
  ends_on: string | null;
  schedule_text: string | null;
  price_paise: number | null;
  seats: number | null;
  seats_taken: number;
}

/** Published, live courses (the same filter in every query below). */
const LIVE = "c.status = 'published' AND c.deleted_at IS NULL AND c.price_paise IS NOT NULL";

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** courses.details, read defensively: a malformed value never breaks the build. */
export function parseDetails(raw: string | null | undefined): CourseDetails {
  let value: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch {
    /* falls back to empty details */
  }
  const faqs = Array.isArray(value.faqs)
    ? value.faqs.flatMap((f) => (f && typeof f === "object" && typeof f.q === "string" && typeof f.a === "string" ? [{ q: f.q, a: f.a }] : []))
    : [];
  const glimpses = Array.isArray(value.glimpses)
    ? value.glimpses.flatMap((g) =>
        g && typeof g === "object" && typeof g.youtubeId === "string" && /^[A-Za-z0-9_-]{11}$/.test(g.youtubeId) && typeof g.label === "string"
          ? [{ youtubeId: g.youtubeId, label: g.label }]
          : [],
      )
    : [];
  return {
    outcomes: strings(value.outcomes),
    forWho: strings(value.forWho),
    faqs,
    glimpses,
    highlights: strings(value.highlights),
  };
}

/** An R2 key as the root-relative image URL W4 serves (/media/i/<key>, each segment encoded). */
export function mediaImagePath(key: string): string {
  return `/media/i/${key.split("/").map(encodeURIComponent).join("/")}`;
}

/** Where a course's landing page lives: its own host once the domain is active, else the hub. */
export function canonicalCourseUrl(slug: string, domainActive: boolean, cfg: Pick<AppConfig, "hubOrigin" | "apexDomain">): string {
  return domainActive ? `https://${slug}.${cfg.apexDomain}/` : `${cfg.hubOrigin}/c/${slug}`;
}

/** The public business facts. Built field by field so nothing else (the GSTIN) can slip through. */
export function publicBusiness(raw: unknown): PublicBusiness {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : "");
  return {
    name: s("name"),
    legalName: s("legalName") || s("name"),
    address: s("address"),
    stateCode: s("stateCode"),
    phone: s("phone"),
    whatsapp: s("whatsapp"),
  };
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Reads the snapshot from `db`. `now` and `cfg` are parameters for tests. */
export async function readSnapshot(db: Db, cfg: AppConfig, now: number = unixNow()): Promise<Snapshot> {
  const today = statDay(now);
  const [courses, modules, lessons, batches, settings] = await db.batch([
    db.prepare(
      `SELECT c.id, c.slug, c.title, c.subtitle, c.description, c.teacher, c.format, c.price_paise, c.compare_at_paise,
              c.deposit_paise, c.level, c.language, c.duration_text, c.access_days, c.certificate_title, c.details,
              c.cover_key, c.og_image_key, c.seo_title, c.seo_description, c.is_demo, c.domain_status
       FROM courses c WHERE ${LIVE} ORDER BY c.sort_order, c.id`,
    ),
    db.prepare(
      `SELECT m.id, m.course_id, m.position, m.title FROM modules m JOIN courses c ON c.id = m.course_id
       WHERE ${LIVE} ORDER BY m.course_id, m.position`,
    ),
    db.prepare(
      `SELECT l.id, l.course_id, l.module_id, l.slug, l.title, l.minutes, l.free_preview, l.vertical,
              CASE WHEN l.video_provider = 'none' THEN 0 ELSE 1 END AS has_video
       FROM lessons l JOIN courses c ON c.id = l.course_id
       WHERE ${LIVE} ORDER BY l.course_id, l.module_id, l.position`,
    ),
    db
      .prepare(
        `SELECT b.id, b.course_id, b.title, b.starts_on, b.ends_on, b.schedule_text, b.price_paise, b.seats, b.seats_taken
         FROM batches b JOIN courses c ON c.id = b.course_id
         WHERE ${LIVE} AND c.format <> 'online' AND b.status = 'open' AND b.starts_on >= ?
         ORDER BY b.course_id, b.starts_on, b.id`,
      )
      .bind(today),
    db.prepare("SELECT key, value FROM settings WHERE key IN ('business', 'legal_confirmed', 'content_version')"),
  ]);

  const settingsMap = new Map((settings!.results as { key: string; value: string }[]).map((r) => [r.key, r.value]));

  const lessonsByModule = new Map<number, PublicLesson[]>();
  for (const l of lessons!.results as unknown as LessonRow[]) {
    const list = lessonsByModule.get(l.module_id) ?? [];
    list.push({
      id: l.id,
      slug: l.slug,
      title: l.title,
      minutes: l.minutes,
      freePreview: l.free_preview === 1,
      vertical: l.vertical === 1,
      hasVideo: l.has_video === 1,
    });
    lessonsByModule.set(l.module_id, list);
  }

  const modulesByCourse = new Map<number, PublicModule[]>();
  for (const m of modules!.results as unknown as ModuleRow[]) {
    const list = modulesByCourse.get(m.course_id) ?? [];
    list.push({ id: m.id, position: m.position, title: m.title, lessons: lessonsByModule.get(m.id) ?? [] });
    modulesByCourse.set(m.course_id, list);
  }

  const batchesByCourse = new Map<number, PublicBatch[]>();
  for (const b of batches!.results as unknown as BatchRow[]) {
    const list = batchesByCourse.get(b.course_id) ?? [];
    list.push({
      id: b.id,
      title: b.title,
      startsOn: b.starts_on,
      endsOn: b.ends_on,
      scheduleText: b.schedule_text,
      pricePaise: b.price_paise,
      seatsLeft: b.seats === null ? null : Math.max(0, b.seats - b.seats_taken),
    });
    batchesByCourse.set(b.course_id, list);
  }

  const publicCourses: PublicCourse[] = [];
  for (const c of courses!.results as unknown as CourseRow[]) {
    // The CHECK on courses.slug matches COURSE_SLUG_RE; a reserved label could still be stored by
    // hand, and must never become a host. Such a course is left out of the public site.
    if (!isValidCourseSlug(c.slug)) continue;
    const domainActive = c.domain_status === "active";
    publicCourses.push({
      id: c.id,
      slug: c.slug,
      title: c.title,
      subtitle: c.subtitle,
      description: c.description,
      teacher: c.teacher,
      format: c.format,
      pricePaise: c.price_paise,
      compareAtPaise: c.compare_at_paise,
      depositPaise: c.deposit_paise,
      level: c.level,
      language: c.language,
      durationText: c.duration_text,
      accessDays: c.access_days,
      certificateTitle: c.certificate_title,
      details: parseDetails(c.details),
      coverUrl: c.cover_key ? mediaImagePath(c.cover_key) : null,
      ogImageUrl: c.og_image_key ? `${cfg.hubOrigin}${mediaImagePath(c.og_image_key)}` : null,
      seoTitle: c.seo_title,
      seoDescription: c.seo_description,
      isDemo: c.is_demo === 1,
      domainActive,
      canonicalUrl: canonicalCourseUrl(c.slug, domainActive, cfg),
      modules: modulesByCourse.get(c.id) ?? [],
      batches: c.format === "online" ? [] : (batchesByCourse.get(c.id) ?? []),
    });
  }

  const version = Number(parseJson(settingsMap.get("content_version")));
  return {
    contentVersion: Number.isInteger(version) && version > 0 ? version : 1,
    generatedAt: now,
    courses: publicCourses,
    settings: {
      business: publicBusiness(parseJson(settingsMap.get("business"))),
      legalConfirmed: parseJson(settingsMap.get("legal_confirmed")) === true,
      testMode: cfg.paymentMode !== "live",
    },
  };
}

/** The snapshot for this environment. The caller checks hasDb(env) first. */
export async function buildSnapshot(env: Env): Promise<Snapshot> {
  return readSnapshot(env.DB, config(env));
}
