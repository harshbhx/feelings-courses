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
- **Search:** the site is noindexed (meta tag plus `X-Robots-Tag` in `public/_headers`).
- **Payments:** test mode only.

When the client confirms a value, change it in `course.ts`, never in a page. Only set `demo: false` when everything in `toConfirm` is confirmed **and** live payment keys are agreed with the owner.

## Stack

- Astro 5, static output, plain CSS with tokens. No UI or CSS framework, no animation library. Same versions as the main site: Astro 5.18.2, Node 22.
- Plus Jakarta Sans via Fontsource (`src/styles/fonts.css`). Weights only through the tokens `--weight-body|ui|strong|display`.
- Icons only through `src/components/Icon.astro` (Phosphor SVGs in `src/icons/`).
- Cloudflare Pages Functions in `functions/` for checkout and gating. They have their own `functions/tsconfig.json`; the root tsconfig excludes `functions/`.
- `scripts/csp.mjs` is the last build step. It hashes inline scripts and writes the Content-Security-Policy into `dist/_headers`. A new outside origin, such as Razorpay's checkout, must be added to `policy()` there.

## Contracts between the parts

Three parts were built in parallel. Keep these boundaries:

| Part | Owns |
|---|---|
| Landing page | `src/pages/index.astro`, `src/components/landing/*` |
| Checkout and enrollment | `functions/api/*`, `functions/_lib/*` (including `enrollment.ts`), `src/components/checkout/*`, `src/pages/thank-you.astro`, `src/pages/payment-failed.astro`, Razorpay origins in `scripts/csp.mjs` |
| Course area and deploy | `src/pages/learn/*`, `functions/learn/*`, `src/components/learn/*`, README deploy notes |

- **Enroll buttons:** any element with `data-enroll` opens checkout. On the landing page they are plain links to `#pricing`, so they still work without JS. The checkout component (`src/components/checkout/Checkout.astro`) is included once on the landing page and binds to every `[data-enroll]`.
- **Enrollment cookie:** see `functions/_lib/enrollment.ts`. Checkout issues it after a verified payment. The course area's middleware only calls `verifyEnrollment()`.
- **Course data:** every part reads `src/data/course.ts`; nobody retypes course facts. Business facts are in `src/data/site.ts`, copied from the main site; keep them in sync.

## Payments (Razorpay)

**Test mode only while `course.demo` is true.**
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
