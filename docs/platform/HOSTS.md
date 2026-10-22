# Hosts, routing and SEO (W1)

One Cloudflare Pages project serves every host. The build is static (Astro); `functions/_middleware.ts` runs `hostRouting()` (`functions/_lib/hosts.ts`) on every request that reaches Functions. `public/_routes.json` keeps hashed assets (`/_astro/*`) and icons out of Functions, so they cost no Function invocation.

## Hosts

| Host | What it serves |
|---|---|
| `courses.feelingsbeautycare.in` (hub, `HUB_HOST`) | `/` (the single course's landing page, or the catalog once 2+ courses are published), `/c/<slug>`, `/learn`, `/account`, `/signin`, `/admin`, `/verify`, `/legal/*`, media, all APIs |
| `<slug>.feelingsbeautycare.in` (course host) | `/` = the static `/c/<slug>` page (the URL stays `/`), checkout APIs, assets, `/media/*`, `/legal/*`, `/terms` and friends, its own `robots.txt` and `sitemap.xml` |
| `*.pages.dev` (previews, production alias) | Like the hub, plus `X-Robots-Tag: noindex, nofollow` on everything and a robots.txt that disallows all |
| `localhost`, `<slug>.localhost` | `wrangler pages dev`: hub and course hosts locally (noindex) |
| anything else | 302 to the hub, same path |

Slugs are never hard-coded: the course host's label is the slug, and whether a course exists is the build's answer (the page `/c/<slug>` exists or `ASSETS` answers 404). Reserved labels (`RESERVED_LABELS`) are never course hosts.

## Course host rules

| Request | Answer |
|---|---|
| `GET /` | the static page `/c/<slug>`; unknown course → 302 to the hub's `/` |
| `/c/<own slug>` | 301 `/` (query kept) |
| `/c/<other>` | 302 to the hub's `/c/<other>` |
| `/terms`, `/refunds`, `/privacy`, `/delivery` | the hub's `/legal/<page>`, served in place (all hosts) |
| `/sitemap.xml` | the static `/sitemaps/<slug>.xml` |
| `/robots.txt` | generated, with `Sitemap: https://<slug>.feelingsbeautycare.in/sitemap.xml` |
| `/api/order`, `/api/verify`, `/api/coupon/quote`, `/api/t`, `/api/public/*` | pass through (checkout runs on the course host) |
| `/_astro/*`, icons, `/og.jpg`, `/media/*`, `/legal/*`, `/thank-you`, `/payment-failed` | pass through |
| any other API | 404 JSON (an API call is never redirected cross-origin) |
| any other page (GET/HEAD) | 302 to the same path on the hub, so `/learn`, `/account` and `/admin` and their `__Host-` cookies live on one host |
| any other POST | 404 |

On the hub, `GET /c/<slug>` answers **301** to `https://<slug>.feelingsbeautycare.in/` once that slug is in `dist/domains.json` (built from `courses.domain_status = 'active'`). The manifest is read once per deployment; a missing or broken file means "no active domains", which is always safe.

## Security headers

`_headers` rules don't reach responses made by Functions, and the course host's `/` is a rewritten asset. So `finish()` in `hosts.ts` adds to every response that leaves Functions, without overwriting what is already there:

- `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security` (`http.ts` `SECURITY_HEADERS`);
- `X-Frame-Options: SAMEORIGIN`, or `DENY` on private paths (`/admin`, `/learn`, `/account`, `/signin`, `/auth`, `/api`), where it overrides the static `SAMEORIGIN`;
- `X-Robots-Tag: noindex, nofollow` on private paths and on preview and dev hosts;
- for an HTML response with no `Content-Security-Policy` (one built by a Function), a baseline policy (`base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'self'`, or `'none'` on private paths). Static pages keep the full hashed policy `scripts/csp.mjs` writes into `dist/_headers`.

Check a deployment with `node scripts/smoke-hosts.mjs [slug …]` (read-only GETs; exit 1 on a problem). This answers the hub's open item "confirm security headers reach the course subdomains".

## SEO per host

All in `src/lib/seo.ts` and `src/lib/course-view.ts`, tested in `tests/w1/seo.test.mjs`.

- **Canonical:** a course's `canonicalUrl` comes from the snapshot: `https://<slug>.feelingsbeautycare.in/` once its domain is active, else `https://courses.feelingsbeautycare.in/c/<slug>` (no trailing slash: `trailingSlash: "never"`). The hub's `/` with a single course renders that course's page with the course's canonical, so the two URLs never compete.
- **Robots:** demo content (`isDemo`) and preview builds (`CF_PAGES_BRANCH` ≠ `main`) get `<meta name="robots" content="noindex, nofollow">`. The old site-wide `X-Robots-Tag: noindex` in `public/_headers` is gone; `/admin*`, `/learn*` and the payment result pages keep a header-level noindex.
- **Titles and descriptions:** the admin's `seo_title` / `seo_description`, else `"<title> by <teacher> | Feelings Beauty Care"` and the subtitle (clipped to 160 characters).
- **Open Graph:** the course's `og_image_key` (absolute hub URL) or the site's `/og.jpg`; `og:url` is the canonical URL.
- **Structured data:** a schema.org `Course` with an `Offer` (INR) and a `CourseInstance` per mode: `online` for recorded lessons, `onsite` per open batch. No ratings or reviews (CLAUDE.md rule 1), and no GSTIN.
- **Sitemaps:** `/sitemap.xml` on the hub lists `/`, every real course still on the hub, and the legal pages. `/sitemaps/<slug>.xml` (served as the course host's `/sitemap.xml`) lists the course host once its domain is active. Both are empty while everything is demo content.
- **404:** `src/pages/404.astro` exists, so Pages answers unknown paths with a real 404 instead of the home page with a 200 (which would also hide a missing course from the router).

## Content snapshot

`GET /api/public/snapshot` (`functions/api/public/snapshot.ts`, `functions/_lib/snapshot.ts`):

- 404 until D1 is bound (the build then uses the seed); a D1 error is a 5xx on purpose (the build fails and the previous deployment stays live);
- published, non-deleted, priced courses in the admin's order; lessons without video references, notes or captions keys; open batches starting today or later (India time), with seats left;
- the business facts built field by field, so the GSTIN can never reach a page;
- one D1 batch (consistent while the admin saves), cached 10 s at the edge.

The build also writes `dist/build.json` (`BuildInfo`, polled by the admin after a publish) and `dist/domains.json` (`DomainsManifest`).

## Adding a course domain (owner, about 4 clicks)

1. Admin → course → choose the slug (it becomes the subdomain; it locks once the domain is active).
2. Cloudflare dashboard → Workers & Pages → `feelings-courses` → Custom domains → Set up a domain → `<slug>.feelingsbeautycare.in` → Activate (the zone is on Cloudflare, so the DNS record is added for you).
3. Admin → course → "Check domain" (W5) marks it active and publishes; the rebuild adds the slug to `domains.json`, and the hub's `/c/<slug>` starts redirecting.
4. Run `node scripts/smoke-hosts.mjs <slug>`.
