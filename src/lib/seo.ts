/**
 * Search and link-preview data per host (W1): titles, canonical URLs, robots, sitemaps and the
 * schema.org description of a course. Plain TypeScript, used by the Astro pages and endpoints at
 * build time and by the Node tests.
 *
 * Rules:
 * - Example content (isDemo) is never indexed and never in a sitemap.
 * - Preview builds (any branch but main on Cloudflare Pages) are noindex as a whole.
 * - A course's canonical URL is its own host once the domain is active, else the hub's /c/<slug>
 *   (PublicCourse.canonicalUrl, decided by the snapshot). Legal pages are canonical on the hub.
 * - Structured data says only what the course data says: no ratings, no reviews (CLAUDE.md rule 1).
 */
import { DEFAULT_HUB_HOST, LEGAL_PAGES } from "../shared/constants.ts";
import type { PublicBusiness, PublicCourse, Snapshot } from "../shared/types.ts";
import { site } from "../data/site.ts";
import { clip, courseView } from "./course-view.ts";

export interface BuildEnv {
  CF_PAGES_BRANCH?: string;
  HUB_HOST?: string;
}

/** The production branch Cloudflare Pages deploys to the live hosts. */
export const PRODUCTION_BRANCH = "main";

/** True for Cloudflare Pages preview builds. Local and CI builds count as production (seed content is demo anyway). */
export function isPreviewBuild(env: BuildEnv): boolean {
  const branch = env.CF_PAGES_BRANCH?.trim();
  return !!branch && branch !== PRODUCTION_BRANCH;
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/** https://<hub>, from HUB_HOST at build time (same rule as functions config()). */
export function hubOrigin(env: BuildEnv): string {
  const host = env.HUB_HOST?.trim().toLowerCase() ?? "";
  return `https://${HOST_RE.test(host) ? host : DEFAULT_HUB_HOST}`;
}

/** The <title> of a course page: the admin's SEO title, else "<title> by <teacher> | <business>". */
export function courseTitle(course: PublicCourse, businessName: string): string {
  return course.seoTitle?.trim() || `${course.title} by ${course.teacher} | ${businessName}`;
}

/** The meta description of a course page (at most 160 characters). */
export function courseDescription(course: PublicCourse): string {
  return courseView(course).summary;
}

/** True when a course page may be indexed. */
export function courseIndexable(course: PublicCourse, env: BuildEnv): boolean {
  return !course.isDemo && !isPreviewBuild(env);
}

/** True when the hub's own pages (catalog, legal) may be indexed: something real is published. */
export function hubIndexable(snapshot: Snapshot, env: BuildEnv): boolean {
  return !isPreviewBuild(env) && snapshot.courses.some((c) => !c.isDemo);
}

// ---------------------------------------------------------------- sitemaps

export interface SitemapUrl {
  loc: string;
  /** "YYYY-MM-DD" */
  lastmod?: string;
}

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
export const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]!);

export function sitemapXml(urls: readonly SitemapUrl[]): string {
  const body = urls
    .map((u) => `  <url><loc>${xmlEscape(u.loc)}</loc>${u.lastmod ? `<lastmod>${xmlEscape(u.lastmod)}</lastmod>` : ""}</url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}${body ? "\n" : ""}</urlset>\n`;
}

const isoDay = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

/**
 * The hub's sitemap: its catalog, legal pages, and every indexable course that still lives on the
 * hub (an active domain lists the course in that host's own sitemap instead).
 */
export function hubSitemapUrls(snapshot: Snapshot, env: BuildEnv): SitemapUrl[] {
  if (!hubIndexable(snapshot, env)) return [];
  const origin = hubOrigin(env);
  const lastmod = isoDay(snapshot.generatedAt);
  const urls: SitemapUrl[] = [{ loc: `${origin}/`, lastmod }];
  for (const c of snapshot.courses) {
    if (courseIndexable(c, env) && !c.domainActive) urls.push({ loc: c.canonicalUrl, lastmod });
  }
  for (const page of LEGAL_PAGES) urls.push({ loc: `${origin}/legal/${page}` });
  return urls;
}

/** A course host's sitemap: its landing page, once the domain is active and the course is real. */
export function courseSitemapUrls(course: PublicCourse, snapshot: Snapshot, env: BuildEnv): SitemapUrl[] {
  if (!course.domainActive || !courseIndexable(course, env)) return [];
  return [{ loc: course.canonicalUrl, lastmod: isoDay(snapshot.generatedAt) }];
}

// ---------------------------------------------------------------- structured data

/** schema.org Course for a landing page, as a JSON-LD object. Facts only. */
export function courseJsonLd(course: PublicCourse, business: PublicBusiness): Record<string, unknown> {
  const view = courseView(course);
  const provider = { "@type": "Organization", name: business.name, sameAs: site.mainUrl };
  const instances: Record<string, unknown>[] = [];
  if (view.hasLessons) {
    instances.push({ "@type": "CourseInstance", courseMode: "online", instructor: { "@type": "Person", name: course.teacher } });
  }
  for (const b of course.batches) {
    instances.push({
      "@type": "CourseInstance",
      courseMode: "onsite",
      name: b.title,
      startDate: b.startsOn,
      ...(b.endsOn ? { endDate: b.endsOn } : {}),
      location: { "@type": "Place", name: business.name, address: business.address },
      instructor: { "@type": "Person", name: course.teacher },
    });
  }
  return {
    "@context": "https://schema.org",
    "@type": "Course",
    name: course.title,
    description: clip(course.description ?? course.subtitle ?? view.summary, 500),
    url: course.canonicalUrl,
    provider,
    ...(course.language ? { inLanguage: course.language } : {}),
    ...(course.level ? { educationalLevel: course.level } : {}),
    ...(course.certificateTitle ? { educationalCredentialAwarded: course.certificateTitle } : {}),
    offers: {
      "@type": "Offer",
      category: course.pricePaise === 0 ? "Free" : "Paid",
      price: (course.pricePaise / 100).toFixed(2),
      priceCurrency: "INR",
      url: course.canonicalUrl,
    },
    ...(instances.length ? { hasCourseInstance: instances } : {}),
  };
}

/** JSON for a <script type="application/ld+json">, safe inside HTML (no "</script>" breakout). */
export function jsonLdText(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
