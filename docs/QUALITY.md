# Quality: performance, accessibility, SEO and headers

Every public, learner and admin page is measured in GitHub Actions by `.github/workflows/quality.yml`:

- **Lighthouse**, mobile and desktop, three runs per page, judged on the median run;
- **axe** (WCAG 2.0, 2.1 and 2.2, A and AA, plus axe's best practices) and a keyboard and motion pass in a real browser, at 390 px and 1280 px;
- **HTTP checks**: security headers, caching and search (robots, sitemaps, canonicals, structured data) for each host.

It never deploys and never touches Cloudflare. It builds with the seed snapshot and serves the build in the runner under `wrangler pages dev`, with a local D1 and R2.

## Running it and reading a failure

- It runs on every pull request. To run it by hand: Actions → Quality → Run workflow, or `gh workflow run quality.yml --ref <branch>`.
- The job summary shows the score table and every problem. Reports: `gh run download <run-id>` gives:
  - `lighthouse-mobile` and `lighthouse-desktop`: the HTML reports in `quality-report/lighthouse/` and `assertion-results.json`;
  - `a11y-http`: `quality-report/a11y.json`;
  - the server logs.
- A failed **Thresholds** step names the audit, the page and the value. A failed **axe** step lists the rule and the elements. A failed **HTTP** step lists the header or tag.
- Don't run any of this on the VM (2 CPUs): it needs Chrome and a full build.

### What it looks at

| Group | Pages | Served by |
|---|---|---|
| Public | home, course landing on the hub (`/c/selfmakeup`) and on its own host (`selfmakeup.localhost`), catalog, legal index, terms, refunds, privacy, thank you, payment failed, 404 | the build under `wrangler pages dev` (real `_headers`, `_routes.json` and the root middleware) |
| Learner | sign in and certificate lookup (live), plus account, empty account, course home, lesson, certificate, receipt, link sent, sign-in error, link expired and access ended | the live ones as above; the signed-in states by `tests/quality/learner-server.mjs`, which serves the exact `Response` each Functions handler returns for the test world in `tests/ux/world.mjs` |
| Admin | sign in, dashboard, courses, course editor, students, payments, coupons, settings, activity | the build, signed in with a throwaway password that exists only in the runner (`tests/quality/serve.sh`) |

The list is in `tests/quality/pages.mjs`. Pages that answer 4xx on purpose (the 404, sign-in error, link expired and access ended pages) get the axe and keyboard pass only, because Lighthouse refuses to score an error status.

### Thresholds

These come from `tests/quality/lighthouserc.cjs`, and every one is an error:

- **Scores:** 95 or more in Performance, Accessibility, Best practices and SEO, on mobile and desktop.
- **Core Web Vitals under Lighthouse throttling:**
  - CLS at most 0.1;
  - LCP at most 2.5 s on mobile and 1.2 s on desktop;
  - TBT at most 200 ms.
- **Images:** every image has a width and height. Lighthouse must find no oversized, offscreen-eager or old-format images.
- **Text:** fonts use `font-display` and text is compressed.
- **Other audits:** no console errors, and every accessible name starts with its visible label.
- **JavaScript budget** (bytes over the wire, per page):

  | Pages | Budget |
  |---|---|
  | Public | 60 KB |
  | Learner | 25 KB |
  | Admin | 120 KB |

The accessibility pass fails on any axe violation and on any of these:

- the first Tab doesn't land on a visible skip link;
- after the skip link, Tab doesn't continue in the main content;
- any of the first 40 Tab stops is invisible or has no focus ring;
- with reduced motion, anything loops or runs longer than 300 ms (the site's tiered rule: movement goes, short fades stay);
- the page scrolls sideways;
- `<html lang>` is missing;
- the console shows an error.

#### Deliberate exceptions

Each one is written next to the rule:

- **`is-crawlable` is skipped everywhere.** Every page here is noindex for a reason that is not a defect: the dev host, the demo course and the private areas. Instead, `tests/quality/headers.mjs` checks robots per host, with the production host names.
- **Admin sign-in: `errors-in-console` is off.** The screen asks `GET /api/admin/me` whether a session exists, so it can skip the form, and the browser logs the expected 401.
- **Receipt: SEO is at least 85.** The receipt's policy is the strictest on the site (`default-src 'none'`), so Lighthouse's in-page fetch of `/robots.txt` is refused. Search engines fetch robots.txt themselves, and the page is personal and noindex.
- **Catalog: `uses-responsive-images` is off.** The srcset picks the right width, but a phone shows the 4:5 cover cropped to 4:3, and Lighthouse counts the hidden part as waste. A real fix is a 4:3 crop for phones (follow-ups).

## Scores

"Before" is the first full run on `feat/email-auth` as it was, on 23 Oct 2026: run 39933010560, one run per page. "After" is this branch, the median of three runs: run 39939314848. An arrow marks a change.

Reading the tables:

- LCP and CLS come from Lighthouse's simulated throttling against a server in the runner. Read them for direction, not as field data.
- Below 100 by a point (catalog 99, home 99 on mobile) is run-to-run noise.

<!-- scores:start -->
#### Mobile

| Page | Performance | Accessibility | Best practices | SEO | CLS | LCP (ms) | JS (KB) |
|---|---|---|---|---|---|---|---|
| home | 70 → 99 | 100 | 100 | 100 | 0.025 → 0.008 | 1823 → 1677 | 6.3 |
| course landing (hub) | 99 → 100 | 100 | 100 | 100 | 0.025 → 0.008 | 1310 → 1762 | 6.3 |
| course landing (course host) | 100 | 100 | 100 | 100 | 0.025 → 0.008 | 1392 → 1771 | 6.3 |
| catalog | 100 → 99 | 100 | 100 | 100 | 0.03 → 0 | 1829 → 1983 | 9.9 |
| legal index | 100 | 100 | 100 | 100 | 0.004 → 0.037 | 916 → 919 | 0 |
| terms | 100 | 100 | 100 | 100 | 0.003 → 0.021 | 916 | 0 |
| refunds | 100 | 100 | 100 | 100 | 0 | 913 → 917 | 0 |
| privacy | 100 | 100 | 100 | 100 | 0.002 → 0 | 918 | 0 |
| thank you | 100 | 100 | 100 | 100 | 0.03 → 0.012 | 914 → 918 | 0 |
| payment failed | 99 → 100 | 100 | 100 | 100 | 0.066 → 0 | 1065 → 1066 | 6.3 |
| sign in | 100 | 100 | 100 | 88 → 100 | 0 | 1223 → 1221 | 0 |
| verify a certificate | 100 | 100 | 100 | 88 → 100 | 0 | 1221 → 1222 | 0 |
| account | 99 → 100 | 100 | 100 | 86 → 100 | 0 | 1816 → 1356 | 0 |
| account, empty | 100 | 100 | 100 | 86 → 100 | 0 | 1357 → 1206 | 0 |
| course home | 100 | 100 | 100 | 86 → 100 | 0 | 1353 → 1130 | 0 |
| lesson | 81 → 100 | 100 | 100 | 86 → 100 | 0 | 1428 → 1357 | 2.1 |
| certificate | 100 | 100 | 100 | 86 → 100 | 0 | 1279 → 1130 | 0 |
| receipt | 100 | 100 | 100 | 75 → 88 | 0 | 1579 → 1131 | 0 |
| sign-in link sent | 100 | 100 | 100 | 86 → 100 | 0 | 1352 → 1132 | 0 |
| admin sign in | 100 | 100 | 96 | 88 → 100 | 0.012 → 0.001 | 1220 → 1227 | 18.1 |
| admin dashboard | 82 → 100 | 100 | 100 | 88 → 100 | 0.361 → 0.004 | 1244 → 1095 | 35.9 |
| admin courses | 100 | 100 | 100 | 88 → 100 | 0.036 → 0.034 | 1407 → 1088 | 36.9 |
| admin course editor | 99 | 100 | 100 | 88 → 100 | 0.004 | 1953 → 2029 | 52.2 |
| admin students | 99 → 100 | 100 | 100 | 88 → 100 | 0.069 → 0.004 | 1388 → 1096 | 40.8 |
| admin payments | 94 → 100 | 100 | 100 | 88 → 100 | 0.149 → 0.004 | 1093 → 1102 | 34.1 |
| admin coupons | 100 | 100 | 100 | 88 → 100 | 0.006 → 0.005 | 1088 → 1085 | 29.6 |
| admin settings | 100 | 100 | 100 | 88 → 100 | 0.004 | 1087 → 1151 | 28.9 |
| admin activity | 100 | 100 | 100 | 88 → 100 | 0.004 | 1233 → 1382 | 21.4 |

#### Desktop

| Page | Performance | Accessibility | Best practices | SEO | CLS | LCP (ms) | JS (KB) |
|---|---|---|---|---|---|---|---|
| home | 100 | 100 | 100 | 100 | 0.019 → 0.009 | 407 → 418 | 6.3 |
| course landing (hub) | 100 | 100 | 100 | 100 | 0.019 → 0.009 | 424 → 428 | 6.3 |
| course landing (course host) | 100 | 100 | 100 | 100 | 0.019 → 0.009 | 420 | 6.3 |
| catalog | 100 | 100 | 100 | 100 | 0.005 → 0 | 434 → 424 | 9.9 |
| legal index | 100 | 100 | 100 | 100 | 0.028 → 0 | 256 → 262 | 0 |
| terms | 100 | 100 | 100 | 100 | 0.001 → 0.006 | 257 → 255 | 0 |
| refunds | 100 | 100 | 100 | 100 | 0.017 → 0.006 | 253 → 255 | 0 |
| privacy | 100 | 100 | 100 | 100 | 0.002 → 0.006 | 252 → 256 | 0 |
| thank you | 100 | 100 | 100 | 100 | 0.003 → 0 | 253 | 0 |
| payment failed | 100 | 100 | 100 | 100 | 0.02 → 0 | 301 → 292 | 6.3 |
| sign in | 100 | 100 | 100 | 88 → 100 | 0 | 342 → 299 | 0 |
| verify a certificate | 100 | 100 | 100 | 88 → 100 | 0 | 345 → 303 | 0 |
| account | 100 | 100 | 100 | 86 → 100 | 0 | 416 → 326 | 0 |
| account, empty | 100 | 100 | 100 | 86 → 100 | 0 | 326 → 288 | 0 |
| course home | 100 | 100 | 100 | 86 → 100 | 0 | 306 → 284 | 0 |
| lesson | 100 | 100 | 100 | 86 → 100 | 0 | 346 → 308 | 2.1 |
| certificate | 100 | 100 | 100 | 86 → 100 | 0 | 305 → 287 | 0 |
| receipt | 100 | 100 | 100 | 75 → 88 | 0 | 368 → 307 | 0 |
| sign-in link sent | 100 | 100 | 100 | 86 → 100 | 0 | 306 → 287 | 0 |
| admin sign in | 100 | 100 | 96 | 88 → 100 | 0.001 → 0 | 345 → 394 | 18.1 |
| admin dashboard | 92 → 100 | 100 | 100 | 86 → 100 | 0.175 → 0.002 | 447 → 430 | 35.9 |
| admin courses | 98 → 100 | 100 | 100 | 86 → 100 | 0.089 → 0.002 | 362 → 420 | 36.9 |
| admin course editor | 100 | 100 | 100 | 86 → 100 | 0.002 → 0.001 | 573 → 562 | 52.2 |
| admin students | 100 | 100 | 100 | 86 → 100 | 0.013 → 0.001 | 438 → 431 | 40.8 |
| admin payments | 93 → 100 | 100 | 100 | 86 → 100 | 0.163 → 0.001 | 450 → 427 | 34.1 |
| admin coupons | 100 | 100 | 100 | 86 → 100 | 0.002 | 356 → 409 | 29.6 |
| admin settings | 100 | 100 | 100 | 86 → 100 | 0.011 → 0.01 | 520 → 504 | 28.9 |
| admin activity | 100 | 100 | 100 | 86 → 100 | 0.001 → 0.003 | 446 → 412 | 21.4 |
<!-- scores:end -->

### Accessibility pass

| | Before | After |
|---|---|---|
| Problems (32 pages × 2 widths) | 26 | 0 |
| axe: content outside landmarks (demo ribbon on every public page; the admin sidebar's brand and catalog link at 1280 px) | 20 | 0 |
| No skip link (404 page) | 2 | 0 |
| Other | 4: the admin sign-in's autofocus moved the first Tab, and the 401 session probe. Both are expected, and the check now allows for them | 0 |

The very first run (before the admin was signed in) also caught:

- a contrast failure on the hero rating, measured while the entrance fade was still running. The check now waits for entrance animations to end. The colours themselves pass: `--text-muted` is 5.5:1 on white.
- the course editor without an `<h1>` while it couldn't load.

### HTTP checks

312 checks. Before: 7 failed. After: 0.

| Check | Before | After |
|---|---|---|
| Fonts in `/app/fonts/`, favicons, the touch icon and `og.jpg` | `max-age=0, must-revalidate`: revalidated on every visit | 30 days (fonts) or 1 day (icons, share image), then `stale-while-revalidate` |
| An unknown `/api/…` path on the hub | the HTML 404 page | the JSON 404 every API uses (`{ error: "not_found" }`, `no-store`), as course hosts already did |
| Privacy page meta description | 183 characters | 150 |

## What changed

### Performance and Core Web Vitals

- **Fonts:**
  - A metric-matched fallback face, "Plus Jakarta Sans Fallback", is used in `src/styles/fonts.css` and the font tokens. It is the local Arial, Helvetica or Roboto, resized to Plus Jakarta Sans' width and line metrics, so the swap to the web font barely moves text.
    - Landing CLS: 0.025 → 0.008 on mobile and 0.019 → 0.009 on desktop.
    - The long legal pages move a little on the swap: at most 0.037 on mobile, well under 0.1.
  - A preload of the Latin file was tried (run 39937001099). It took CLS to 0 everywhere, but on simulated slow 4G it competed with the render-blocking CSS and made LCP about 150 ms later on every public page (legal pages 916 → 1066 ms). It was removed.
  - **The landing's LCP element is now the hero poster** (about 1.7 s on mobile), where it was the demo ribbon's text (1.3 s). The requests and first paint are unchanged (FCP 976 → 940 ms). Most likely, before the fallback fix the wider system font pushed the poster partly below the fold at first paint, so Chrome never counted it. 1.7 s is the truer figure, and it is inside the 2.5 s limit.
- **Admin dashboard (CLS 0.361 → 0.004):** the "Getting ready to sell" card appears above the numbers once settings load, and pushed everything down. The numbers, chart and lists are now laid out but not painted until the script knows whether the card shows (`.setup-known`), or for at most 2 s. Without JavaScript nothing stays hidden.
- **Admin lists (payments CLS 0.149 → 0.004, students 0.069 → 0.004):**
  - An empty list region already has the height of the loading placeholder its script will put in (`--skel-rows` on the region).
  - An empty or error state keeps that height (`.state` in `admin.css`, set by `loadInto`), so the "Razorpay events" card below no longer jumps.
- **Catalog:** the first card's cover, the page's LCP image, has a `srcset` (320, 480 and 720 px WebP), `sizes` and `fetchpriority="high"`. The cards the browser redraws from the demo store use the same set.
- **Learner pages:** every page has a meta description (SEO 86 → 100). The lesson page's mobile score went from 81 to 100 between runs, with no code change to it. That first run was single and noisy, and three runs with the median removed the noise.
- **Images already in good shape:** Astro builds AVIF and WebP in several widths, with `sizes`, `loading="lazy"` below the fold and an eager, high-priority hero poster. Every image has a width and height.
- **JavaScript:**
  - Public pages ship 6 to 10 KB and learner pages 0 to 2 KB.
  - The admin ships 18 KB for the sign-in screen and up to 52 KB for the course editor.
  - All are well inside the budgets.

### Accessibility

- The demo ribbon is an `<aside aria-label="Demo notice">` (a landmark), not a loose paragraph.
- The admin sidebar is an `<aside aria-label="Admin menu">`, so its brand link and footer links sit in a landmark.
- The 404 page has the skip link every other page has.
- The admin editor's "View on site" link: its accessible name now starts with the visible words (WCAG 2.5.3).
- Already in place and now checked on every page:
  - skip links that work;
  - visible focus rings (`:focus-visible`, 2 px red, offset 3 px);
  - labelled fields;
  - `role="alert"` and `role="status"` for errors and notices, and `aria-live` on list counts;
  - tiered reduced motion;
  - `lang` set on every page.

### Caching

Every kind of response, as `tests/quality/headers.mjs` checks it:

| Response | Cache-Control |
|---|---|
| Hashed build assets (`/_astro/*`) | `public, max-age=31536000, immutable` |
| Static HTML (landing, legal, admin shells) | Pages' default `public, max-age=0, must-revalidate` (a deploy shows at once) |
| `/app/app.css`, `/app/learn.js` (fixed names, change on deploy) | Pages' default, revalidated |
| `/app/fonts/*` | `public, max-age=2592000, stale-while-revalidate=604800` |
| Favicons, touch icon, `og.jpg` | `public, max-age=86400, stale-while-revalidate=604800` |
| `robots.txt`, `sitemap.xml` | `public, max-age=3600` |
| `build.json`, `domains.json` | `no-cache` |
| Learner pages, receipts, the admin API and every JSON API | `private, no-store` or `no-store` |
| 404 page | not cached for long, never immutable |

### Security headers

Every response kind gets `X-Content-Type-Options: nosniff`, Referrer-Policy, Permissions-Policy, HSTS and X-Frame-Options:

- static pages;
- hashed assets;
- `/app` files;
- Function pages;
- APIs;
- robots and sitemaps;
- the 404.

The hub, a course host and the dev host are all checked.

Every HTML response has a Content-Security-Policy with `frame-ancestors`, plugins blocked and no inline scripts allowed:

- static pages: the hashed policy from `scripts/csp.mjs`;
- learner pages: `PAGE_CSP`;
- the receipt: its own stricter policy.

Private areas (`/admin`, `/signin`, `/account`, `/learn`) are `X-Frame-Options: DENY` with `X-Robots-Tag: noindex`.

### Search, per host

The production host names are sent as the Host header, so the router treats them exactly as on Cloudflare.

- **Hub** (`courses.feelingsbeautycare.in`):
  - robots.txt keeps `/admin`, `/api/` and the private paths out, and names the hub's sitemap;
  - the sitemap is valid with absolute https URLs;
  - every public page has exactly one absolute https canonical that matches `og:url`, a title of 10 to 70 characters and a description of 50 to 160;
  - the course landing has one schema.org `Course` with provider, description and an INR offer, and no ratings or reviews (CLAUDE.md rule 1).
- **Course host** (`selfmakeup.feelingsbeautycare.in`):
  - robots.txt names the host's own sitemap, which is served from `/sitemaps/<slug>.xml`;
  - hub-only pages such as `/admin` redirect to the hub.
- **Dev and preview hosts** (`localhost`, `*.pages.dev`): `X-Robots-Tag: noindex`, and robots.txt disallows everything.
- hreflang isn't needed: the site is English only.

## Follow-ups

None of these fails a threshold today.

- **Catalog cover crop:** a 4:3 crop for phones, with `<picture>` and a media query, would stop sending the hidden part of each cover. `/catalog` is the demo-store catalog. The hub's home becomes the catalog once two courses are published.
- **`public/app/app.css`** (37 KB, not minified) is render-blocking on every learner page. Minifying it at build time would save a few KB. Scores are already 100.
- **Admin sign-in session probe:** `GET /api/admin/me` answers 401 when signed out, which browsers log as an error. A readable "signed in" hint cookie (no secret in it) would let the page skip the call.
- **Real-user Core Web Vitals:** Lighthouse measures a local server in the runner, not Cloudflare's edge or real phones. Switching on Cloudflare Web Analytics, which the CSP already allows, would give field data.
