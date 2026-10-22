/**
 * The seed snapshot: the public content the build uses when there is no live D1 snapshot (first
 * deploy, preview branches, local builds, CI with SNAPSHOT_SOURCE=seed).
 *
 * Built from src/data/course.ts (texts, price, modules), src/data/lessons.ts (lesson slugs) and
 * src/data/site.ts (business facts), with the same ids and slug as migrations/0002_seed.sql, so a
 * build from the seed and a build from a freshly seeded D1 render the same pages.
 * tests/db/seed.test.mjs checks the two agree.
 *
 * DEMO: the course is example content (course.toConfirm), marked isDemo.
 *
 * Plain TypeScript with no Vite features, so Node tests can import it.
 */
import { DEFAULT_HUB_HOST } from "../shared/constants.ts";
import type { PublicCourse, PublicSettings, Snapshot } from "../shared/types.ts";
import { course } from "./course.ts";
import { modules as lessonModules } from "./lessons.ts";
import { site } from "./site.ts";

/** The demo course's slug in D1 (migrations/0002_seed.sql), also its subdomain label. */
export const SEED_COURSE_SLUG = "selfmakeup";
export const SEED_COURSE_ID = 1;

/** "12 months" → 365, "90 days" → 90 (same reading as the demo's enrollment cookie). */
function accessDaysFrom(access: string): number | null {
  const m = /(\d+)\s*(day|week|month|year)s?/i.exec(access);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? Math.round((n * 365) / 12) : n * 365;
}

export function seedSettings(): PublicSettings {
  const a = site.address;
  return {
    business: {
      name: site.name,
      legalName: site.name,
      address: `${a.street}, ${a.landmark}, ${a.city}, ${a.region} ${a.postalCode}`,
      stateCode: "24",
      phone: site.phone.tel,
      whatsapp: site.whatsappNumber,
    },
    legalConfirmed: false,
    testMode: true,
  };
}

export function seedCourse(): PublicCourse {
  let lessonId = 0;
  return {
    id: SEED_COURSE_ID,
    slug: SEED_COURSE_SLUG,
    title: course.title,
    subtitle: course.subtitle,
    description: null,
    teacher: course.teacher,
    format: "online",
    pricePaise: course.price.amount,
    compareAtPaise: course.price.compareAt,
    depositPaise: null,
    level: course.level,
    language: course.language,
    durationText: null,
    accessDays: accessDaysFrom(course.access),
    certificateTitle: course.certificate,
    details: {
      outcomes: [...course.outcomes],
      forWho: [...course.forWho],
      faqs: course.faqs.map(({ q, a }) => ({ q, a })),
      glimpses: course.glimpses.map(({ id, label }) => ({ youtubeId: id, label })),
      highlights: [],
    },
    coverUrl: null,
    ogImageUrl: null,
    seoTitle: null,
    seoDescription: null,
    isDemo: course.demo,
    domainActive: false,
    canonicalUrl: `https://${DEFAULT_HUB_HOST}/c/${SEED_COURSE_SLUG}/`,
    modules: lessonModules.map((mod) => ({
      id: mod.number,
      position: mod.number,
      title: mod.title,
      lessons: mod.lessons.map((lesson) => ({
        id: ++lessonId,
        slug: lesson.slug,
        title: lesson.title,
        minutes: lesson.minutes,
        freePreview: false,
        vertical: false,
        hasVideo: false,
      })),
    })),
    batches: [],
  };
}

/** The whole seed snapshot. `generatedAt` defaults to now. */
export function seedSnapshot(generatedAt: number = Math.floor(Date.now() / 1000)): Snapshot {
  return { contentVersion: 1, generatedAt, courses: [seedCourse()], settings: seedSettings() };
}
