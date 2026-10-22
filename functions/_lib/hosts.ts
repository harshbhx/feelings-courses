/**
 * Routing by Host (plan 1.3, W1). Runs for every request that reaches Functions (public/_routes.json
 * keeps hashed assets and icons out), right after the migration step in functions/_middleware.ts.
 *
 * Hosts:
 *   hub      courses.feelingsbeautycare.in (config(env).hubHost): catalog, /learn, /account,
 *            /signin, /admin, /verify, legal pages, media. Served as usual (next()), except:
 *              /c/<slug>     → 301 https://<slug>.feelingsbeautycare.in/ once that course's domain
 *                              is active (dist/domains.json, written by the build);
 *              /terms …      → the hub's /legal/<page> (LEGAL_PAGES), served in place;
 *              /robots.txt   → generated for the host.
 *   course   <slug>.feelingsbeautycare.in: the course's landing page and checkout only.
 *              /             → the static page /c/<slug> (rewritten, the URL stays /);
 *              /sitemap.xml  → /sitemaps/<slug>.xml; /robots.txt generated; /terms … as on the hub;
 *              /c/<slug>     → 301 /;
 *              assets, /media/*, /legal/*, the checkout APIs (COURSE_HOST_APIS) and the payment
 *              result pages pass through;
 *              any other page → 302 to the same path on the hub (the account area, the course
 *              area and the admin live there, so their __Host- cookies stay on one host);
 *              any other API → 404 JSON (never a cross-origin redirect for an API call).
 *   preview  *.pages.dev (branch previews and the production alias): served like the hub, with
 *            X-Robots-Tag: noindex on everything and a robots.txt that disallows all.
 *   dev      localhost / 127.0.0.1 (wrangler pages dev). <slug>.localhost acts as a course host.
 *   other    any other host that reaches the project: 302 to the hub, same path.
 *
 * Every response leaving here carries the security headers (http.ts SECURITY_HEADERS plus
 * X-Frame-Options), because _headers rules don't reach responses made by Functions. Private areas
 * (admin, learn, account, auth, API) also get X-Frame-Options: DENY and X-Robots-Tag: noindex. An
 * HTML response without a Content-Security-Policy (one made by a Function) gets a baseline policy
 * that blocks framing, plugins and base/form hijacking without touching scripts; static pages keep
 * the full hashed policy that scripts/csp.mjs writes into dist/_headers.
 *
 * No code here branches on a particular course: slugs come from the host name, and whether a page
 * exists is the build's answer (a 404 from ASSETS).
 */
import { isValidCourseSlug, LEGAL_PAGES, type LegalPage } from "../../src/shared/constants.ts";
import type { DomainsManifest } from "../../src/shared/types.ts";
import { config } from "./config.ts";
import type { Env } from "./env.ts";
import { securityHeaders } from "./http.ts";

export interface MiddlewareContext {
  request: Request;
  env: Partial<Env>;
  data: Record<string, unknown>;
  next: () => Promise<Response>;
}

// ---------------------------------------------------------------- host classification

export type HostInfo =
  | { kind: "hub"; host: string }
  | { kind: "course"; host: string; slug: string; dev: boolean }
  | { kind: "preview"; host: string }
  | { kind: "dev"; host: string }
  | { kind: "other"; host: string };

const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Lower-case host name without a trailing dot or port. */
export function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, "");
}

/** Which kind of host a request came to. `hubHost` and `apexDomain` come from config(env). */
export function classifyHost(hostname: string, hubHost: string, apexDomain: string): HostInfo {
  const host = normalizeHost(hostname);
  if (host === hubHost) return { kind: "hub", host };
  if (DEV_HOSTS.has(host)) return { kind: "dev", host };
  if (host.endsWith(".localhost")) {
    const label = host.slice(0, -".localhost".length);
    return isValidCourseSlug(label) ? { kind: "course", host, slug: label, dev: true } : { kind: "dev", host };
  }
  if (host === "pages.dev" || host.endsWith(".pages.dev")) return { kind: "preview", host };
  const suffix = `.${apexDomain}`;
  if (host.endsWith(suffix)) {
    const label = host.slice(0, -suffix.length);
    if (isValidCourseSlug(label)) return { kind: "course", host, slug: label, dev: false };
  }
  return { kind: "other", host };
}

// ---------------------------------------------------------------- paths

/** APIs a course host serves itself: checkout, coupon quotes, tracking and public reads. */
export const COURSE_HOST_APIS: readonly string[] = ["/api/order", "/api/verify", "/api/coupon/quote", "/api/t"];
const COURSE_HOST_API_PREFIXES: readonly string[] = ["/api/public/"];
/** Static files and shared routes every host serves as they are. */
const SHARED_PREFIXES: readonly string[] = ["/_astro/", "/media/", "/legal/"];
const SHARED_FILES: readonly string[] = [
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-32.png",
  "/favicon-48.png",
  "/apple-touch-icon.png",
  "/og.jpg",
  // The demo checkout's result pages (W2 moves the result onto the hub).
  "/thank-you",
  "/payment-failed",
];

/** Areas that are personal or operational: never framed, never indexed. */
const PRIVATE_PREFIXES: readonly string[] = ["/admin", "/learn", "/account", "/signin", "/auth", "/api"];

/** True when `pathname` is `prefix` itself or below it (`/admin`, `/admin/x`, `/admin.html`). */
export function underPath(pathname: string, prefix: string): boolean {
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname === `${prefix}.html`;
}

export function isPrivatePath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return PRIVATE_PREFIXES.some((p) => underPath(lower, p));
}

/** "/terms" → "terms" (also "/terms.html" and "/terms/"), else null. */
export function legalShortPath(pathname: string): LegalPage | null {
  const m = /^\/([a-z]+)(?:\.html|\/)?$/.exec(pathname);
  return m && (LEGAL_PAGES as readonly string[]).includes(m[1]!) ? (m[1] as LegalPage) : null;
}

/** "/c/<slug>" (also with a trailing slash or .html, or a deeper path) → its slug, else null. */
export function coursePath(pathname: string): { slug: string; rest: string } | null {
  const m = /^\/c\/([^/]+?)(?:\.html)?(\/.*)?$/.exec(pathname);
  if (!m || !isValidCourseSlug(m[1]!)) return null;
  return { slug: m[1]!, rest: m[2] ?? "" };
}

// ---------------------------------------------------------------- robots.txt

/** Lines every indexable host disallows (personal areas and the API). */
const ROBOTS_DISALLOW = ["/admin", "/learn", "/account", "/signin", "/auth/", "/api/", "/thank-you", "/payment-failed"];

/** robots.txt for a host. Preview and dev hosts disallow everything. */
export function robotsTxt(info: HostInfo, origin: string): string {
  if (info.kind === "preview" || info.kind === "dev" || (info.kind === "course" && info.dev)) {
    return "# Preview deployment: not for search engines.\nUser-agent: *\nDisallow: /\n";
  }
  return [
    "User-agent: *",
    ...ROBOTS_DISALLOW.map((p) => `Disallow: ${p}`),
    "Allow: /",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- domains manifest (dist/domains.json)

let activeDomains: Promise<ReadonlySet<string>> | null = null;

/** Forgets the cached manifest (tests; each deployment is a fresh isolate anyway). */
export function resetHostState(): void {
  activeDomains = null;
}

/**
 * Slugs whose subdomain is active, from the build's dist/domains.json. Read once per isolate (a new
 * deployment is a new isolate). A missing or broken file means "none": the hub keeps serving
 * /c/<slug> itself, which is always safe.
 */
export function readActiveDomains(env: Partial<Env>, origin: string): Promise<ReadonlySet<string>> {
  if (!activeDomains) {
    activeDomains = (async () => {
      try {
        const res = await env.ASSETS?.fetch(new Request(`${origin}/domains.json`));
        if (!res || res.status !== 200) return new Set<string>();
        const data = (await res.json()) as Partial<DomainsManifest>;
        const slugs = Array.isArray(data.active) ? data.active.filter((s): s is string => typeof s === "string" && isValidCourseSlug(s)) : [];
        return new Set(slugs);
      } catch {
        return new Set<string>();
      }
    })();
  }
  return activeDomains;
}

// ---------------------------------------------------------------- responses

/** Statuses that must not carry a body. */
const NULL_BODY = new Set([101, 204, 205, 304]);

/** Baseline policy for HTML made by Functions (no hashes, so no script restrictions). */
export const BASELINE_CSP = "base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'self'";
const BASELINE_CSP_PRIVATE = "base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'";

export interface FinishOptions {
  /** X-Robots-Tag: noindex. */
  noindex?: boolean;
  /** Admin, learn, account: X-Frame-Options DENY and frame-ancestors 'none'. */
  private?: boolean;
}

/**
 * A mutable copy of `response` with the security headers, never overwriting a header the response
 * already set, except where the result is stricter (X-Robots-Tag, X-Frame-Options on private paths).
 */
export function finish(response: Response, options: FinishOptions = {}): Response {
  // Responses from fetch() or ASSETS have immutable headers: copy before changing anything.
  const copy = new Response(NULL_BODY.has(response.status) ? null : response.body, response);
  const headers = copy.headers;
  // Private areas are never framed, even when a static rule already said SAMEORIGIN.
  if (options.private) headers.set("X-Frame-Options", "DENY");
  securityHeaders(headers, { frameDeny: options.private });
  if (options.noindex) headers.set("X-Robots-Tag", "noindex, nofollow");
  const type = headers.get("Content-Type") ?? "";
  if (type.toLowerCase().startsWith("text/html") && !headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", options.private ? BASELINE_CSP_PRIVATE : BASELINE_CSP);
  }
  return copy;
}

function redirectTo(location: string, status: 301 | 302 | 307 | 308): Response {
  return new Response(null, { status, headers: { Location: location, "Cache-Control": status === 301 || status === 308 ? "public, max-age=3600" : "no-store" } });
}

function notFoundJson(): Response {
  return new Response(JSON.stringify({ error: "not_found", message: "Not found." }), {
    status: 404,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function text(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=3600" } });
}

/**
 * Fetches a static file from the build in place of the requested path (the visitor's URL doesn't
 * change). Method and conditional headers carry over, so HEAD and 304s keep working.
 */
async function serveAsset(env: Partial<Env>, request: Request, pathname: string): Promise<Response | null> {
  if (!env.ASSETS) return null;
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  return env.ASSETS.fetch(new Request(url.href, { method, headers: request.headers }));
}

// ---------------------------------------------------------------- the router

/** Routes the request by host; calls `next` for anything the hub serves as usual. */
export async function hostRouting(context: MiddlewareContext, next: () => Promise<Response>): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const cfg = config(env);
  const info = classifyHost(url.hostname, cfg.hubHost, cfg.apexDomain);
  const pathname = url.pathname;
  const isPrivate = isPrivatePath(pathname);
  const previewLike = info.kind === "preview" || info.kind === "dev" || (info.kind === "course" && info.dev);
  const done = (res: Response) => finish(res, { noindex: previewLike || isPrivate, private: isPrivate });
  const readOnly = request.method === "GET" || request.method === "HEAD";

  // The hub's origin as seen from this request (a dev course host points at localhost:<port>).
  const hubOrigin = info.kind === "course" && info.dev ? `${url.protocol}//localhost${url.port ? `:${url.port}` : ""}` : cfg.hubOrigin;

  if (info.kind === "other") {
    return done(redirectTo(`${cfg.hubOrigin}${pathname}${url.search}`, readOnly ? 302 : 307));
  }

  if (pathname === "/robots.txt" && readOnly) {
    return done(text(robotsTxt(info, url.origin), "text/plain; charset=utf-8"));
  }

  const legal = readOnly ? legalShortPath(pathname) : null;
  if (legal) {
    const res = await serveAsset(env, request, `/legal/${legal}`);
    if (res) return done(res);
  }

  if (info.kind === "course") return done(await routeCourseHost(context, info.slug, hubOrigin, next));

  // Hub, preview and dev: /c/<slug> moves to the course's own host once its domain is active (only
  // on the real hub; previews keep /c/<slug> so a branch can be checked before the domain exists).
  if (info.kind === "hub" && readOnly) {
    const course = coursePath(pathname);
    if (course) {
      const active = await readActiveDomains(env, url.origin);
      if (active.has(course.slug)) {
        return done(redirectTo(`https://${course.slug}.${cfg.apexDomain}/${url.search}`, 301));
      }
    }
  }
  return done(await next());
}

async function routeCourseHost(
  context: MiddlewareContext,
  slug: string,
  hubOrigin: string,
  next: () => Promise<Response>,
): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const readOnly = request.method === "GET" || request.method === "HEAD";

  if ((pathname === "/" || pathname === "/index.html") && readOnly) {
    const res = await serveAsset(env, request, `/c/${slug}`);
    if (res && res.status !== 404) return res;
    // No published course behind this host (renamed, archived, or not built yet): the catalog.
    return redirectTo(`${hubOrigin}/`, 302);
  }

  if (pathname === "/sitemap.xml" && readOnly) {
    const res = await serveAsset(env, request, `/sitemaps/${slug}.xml`);
    return res ?? notFoundJson();
  }

  const course = coursePath(pathname);
  if (course) {
    if (course.slug === slug) return redirectTo(`/${url.search}`, 301);
    return redirectTo(`${hubOrigin}${pathname}${url.search}`, 302);
  }

  const shared = SHARED_FILES.includes(pathname) || SHARED_PREFIXES.some((p) => pathname.startsWith(p));
  const api = COURSE_HOST_APIS.includes(pathname) || COURSE_HOST_API_PREFIXES.some((p) => pathname.startsWith(p));
  if (shared || api) return next();

  if (pathname.startsWith("/api/") || pathname === "/api") return notFoundJson();
  if (!readOnly) return notFoundJson();
  return redirectTo(`${hubOrigin}${pathname}${url.search}`, 302);
}
