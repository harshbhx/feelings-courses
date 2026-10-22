# Feelings Courses: project notes

The online makeup course of Feelings Beauty Care (Jamnagar; ladies' parlour, bridal studio and makeup academy run by Urmi Mengar since 2009). This repo is the course's own small site on **courses.feelingsbeautycare.in**:
- a landing page for people arriving from Instagram, where the course is promoted with short glimpses of its video lessons;
- a checkout with Razorpay;
- a gated course area where buyers watch the lessons.

The main site is a separate repo, `harshbhx/feelings-beauty-care` (live on feelingsbeautycare.in). Its brand system was copied here: tokens, fonts, global and motion CSS, icons, logo and CSP script. Read its `docs/03-design-system.md` for the look. Never copy the old dark-and-gold site.

## Status: DEMO (since 2026-10-20)

Built to show the client before they confirm anything:
- **Content:** everything in `src/data/course.ts` is example content while `course.demo` is true. That covers price, modules, lessons, duration, certificate and access.
- **Visible:** a ribbon on every page says it's a demo.
- **Search:** demo content is noindexed page by page (`<meta name="robots">` from `src/lib/seo.ts`); preview builds and `*.pages.dev` are noindex as a whole (W1).
- **Payments:** test mode only.

When the client confirms a value, change it in `course.ts`, never in a page. Only set `demo: false` when everything in `toConfirm` is confirmed **and** live payment keys are agreed with the owner.

## Stack

- Astro 5, static output, plain CSS with tokens. No UI or CSS framework, no animation library. Same versions as the main site: Astro 5.18.2, Node 22.
- Plus Jakarta Sans via Fontsource (`src/styles/fonts.css`). Weights only through the tokens `--weight-body|ui|strong|display`.
- Icons only through `src/components/Icon.astro` (Phosphor SVGs in `src/icons/`).
- Cloudflare Pages Functions in `functions/` for checkout and gating. They have their own `functions/tsconfig.json`; the root tsconfig excludes `functions/`.
- `scripts/csp.mjs` is the last build step. It hashes inline scripts and writes the Content-Security-Policy into `dist/_headers`. A new outside origin, such as Razorpay's checkout, must be added to `policy()` there.

## Contracts between the parts

The site is becoming the production course platform (8 workstreams, W0 to W7). **The full list of shared types, tables, helpers and stubs, and which workstream owns each, is in `docs/platform/CONTRACTS.md`.** Read it before touching a shared file.

- **Owner decisions (plan section 10), already in the contracts:**
  - the admin picks every course's subdomain (no hard-coded slugs);
  - academy courses are `hybrid` (batches and recorded lessons);
  - fees come from the admin;
  - refunds within 24 hours of purchase;
  - **no GSTIN and no tax lines anywhere** (invoice numbers stay);
  - 365 days of access;
  - 2 devices per student.
- **Shared contracts:** `src/shared/types.ts` (data), `src/shared/api.ts` (one request and one response type per endpoint, plus the `Endpoints` map) and `src/shared/constants.ts`. Change them only through a coordinator-approved PR.
- **Database:** Cloudflare D1. The schema is in `migrations/*.sql` (wrangler's format), and the runtime migrates itself on the first request (`functions/_lib/migrate.ts`, statements embedded by `scripts/embed-migrations.mjs`). Migrations are additive only. Only the coordinator adds new ones.
- **Data access:** code takes the `Db` interface (`functions/_lib/db/d1.ts`). Writes that belong together go in one `batch()` (`db/tx.ts`). Every admin write is logged with `db/audit.ts`. Settings go through `db/settings.ts`.
- **Functions helpers:**
  - `functions/_lib/http.ts` for responses and bodies;
  - `config.ts` for env, cookies, TTLs and rate-limit rules;
  - `crypto.ts`, `ratelimit.ts`;
  - `env.ts` (`Env`): read secrets with `requireSecret()`, because they are missing until the owner runs setup.
- **Stubs:** W0 froze the signatures of `session.ts`, `orders.ts`, `pricing.ts`, `media.ts`, `play.ts`, `certificates.ts`, `analytics.ts`, `daily.ts`, `rebuild.ts`, `snapshot.ts` and `hosts.ts`. On the integration branch every one is filled (W1 to W7); `docs/INTEGRATION.md` lists the merge order, what was settled between workstreams and the go-live checklist.
- **Content at build time:**
  - `scripts/snapshot.mjs` fetches the live snapshot on `main`, falling back to the seed on a 404 and failing the build on a 5xx.
  - `src/data/snapshot.ts` serves it to pages.
  - The landing pages (`/` and `/c/<slug>`, `src/components/landing/CourseLanding.astro`) read the snapshot and mount `<Checkout course settings platform>`, which sends W2's `OrderRequest`. Without D1 the server answers with the demo flow, so the demo keeps working.
- **Demo parts still live until the owner runs setup (no D1 bound):**
  - Enroll buttons: `data-enroll` opens `src/components/checkout/Checkout.astro`; the result pages read `src/data/course.ts`.
  - The `fbc_enroll` cookie (`functions/_lib/enrollment.ts`), which W3 replaces with D1 sessions.
  - Course facts in `src/data/course.ts`. Business facts in `src/data/site.ts`, kept in sync with the main site.
- **Tests:** `npm test` runs `tests/**/*.test.mjs` (Node 22.13+ `node:test`, D1 shim on `node:sqlite`, fakes for R2 and Razorpay in `tests/helpers/`) plus the two suites in `scripts/`. CI (`.github/workflows/ci.yml`) runs check, the Functions type check, tests and the build on every PR.

## Payments (Razorpay)

**Test mode only while `course.demo` is true.** The platform's live flow on D1 (prices from D1, the webhook, refunds within 24 hours, invoice numbers and on-screen receipts) is described in `docs/platform/PAYMENTS.md`. The demo flow below keeps answering until D1 is set up.
- **Flow:** `POST /api/order` creates a Razorpay order on the server, using the secret key. The browser opens Razorpay Checkout. `POST /api/verify` checks Razorpay's signature (HMAC-SHA256 of `order_id|payment_id` with the key secret) and only then issues the enrollment cookie. Amounts always come from `course.ts` on the server, never from the browser.
- **Secrets:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `ENROLL_SECRET`. The owner sets them in the Cloudflare dashboard (Pages project → Settings → Variables and Secrets). Secrets never go in the repo or through the assistant.
- **Razorpay test mode without a secret (`razorpay-test`):** while `course.demo` is true and no Key Secret is set, checkout opens Razorpay's real Checkout in Test Mode with the public test Key ID committed in `src/data/payments.ts` (owner-approved, not a secret), without an order. `/api/verify` can't verify those payments (no secret), so it accepts any well-formed `pay_…` id: acceptable only for the demo. Never possible once `demo` is false. Never commit a Key Secret.
- **Demo fallback:** with no Key Secret and no test Key ID, and in Instagram's and Facebook's in-app browsers in the mode above, checkout opens a built-in demo payment sheet. It is clearly labelled "test, no money is charged", and the rest of the flow is the same.

## Rules

1. **Honest content.** No rating, review count, statistic, price, award or testimonial unless the client confirmed it. Demo values are allowed only in `course.ts`, with the ribbon visible. Never invent student testimonials. No superlatives ("best in Jamnagar").
2. **Phone first.** People arrive from Instagram on phones. Check 390px first, then 768, 1024 and 1440. No horizontal scroll: every horizontal strip is `position: relative`, and `document.documentElement.scrollWidth` equals the viewport.
3. **One accent:** sindoor red (`--accent`) for the primary action. Colours come from the tokens only.
4. **Motion:** small, opacity and transform only, tiered reduced motion. No auto-playing carousels, countdown timers or fake urgency.
5. **CSP:** no inline event handlers or `javascript:` URLs (the build fails on them). JS that measures layout must do it in an IntersectionObserver or ResizeObserver, not at script start.
6. **WhatsApp:** plain `wa.me` links via `src/lib/whatsapp.ts`.

## Deploy

- Cloudflare Pages **Git integration** from GitHub `harshbhx/feelings-courses`. Pages project `feelings-courses`; `main` deploys to courses.feelingsbeautycare.in. Branches get preview URLs.
- **Never run `wrangler pages deploy`.** It creates a Direct Upload project, which can't be switched to Git integration later.

## Git

- Author: Harsh Bhanushali <bhanushaliharsh434@gmail.com>.
- **No AI attribution anywhere:** no `Co-Authored-By` trailers, no "Generated with" lines, no session links in commits, PRs or docs.
- Small conventional commits. Work goes on a branch and through a PR; the owner approves merges.
