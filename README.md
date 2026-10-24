# Feelings Courses

The course platform of Feelings Beauty Care (Jamnagar) on **courses.feelingsbeautycare.in**, with a subdomain per course:
- **public site:** a catalog of courses and a landing page per course (online, at the studio, or both), with legal pages and per-host SEO;
- **checkout:** Razorpay, with coupons, batches for studio courses, receipts and refunds within 24 hours;
- **students:** sign-in with a single-use emailed link, the course area with recorded lessons on R2, progress, certificates with a public check page, and an account page with receipts;
- **admin** (`/admin`): courses, lessons and video uploads, students, payments and refunds, coupons, settings, backups and the activity log.

It runs on Cloudflare Pages (static Astro build plus Pages Functions) with D1, R2 and a small mailer Worker on Cloudflare Email Sending.

**Status (24 Oct 2026):** all the work is on `release/courses-v1` (draft PR [#29](https://github.com/harshbhx/feelings-courses/pull/29)), which becomes `main` when the owner merges it. Nothing is set up on Cloudflare yet, so the site runs its **demo** flow (example course, test payments only, a demo ribbon) until the owner runs the setup script. The owner's remaining steps: `docs/owner/OWNER-GUIDE.md`, "Before you start".

Read `CLAUDE.md` before changing code.

## Develop

Node 22.13 or newer.

```bash
npm ci
npm run dev          # http://localhost:4321 (the Astro pages)
npm run dev:full     # the build under wrangler pages dev, with local D1 and R2 (Functions included)
npm run check        # astro check
npm run typecheck    # Pages Functions
npm test             # unit, integration, checkout and course-area tests (node:test, D1 on node:sqlite)
npm run build        # what Cloudflare Pages runs: snapshot, astro check, build, CSP hashes
```

Heavier checks run in GitHub Actions on every pull request; none of them deploys:

| Workflow | What |
|---|---|
| CI | install, type checks, tests, migrations on D1, Functions bundle, build, `check-dist.mjs` |
| E2E | Playwright journeys in Chromium against the real Functions and build, with fake Razorpay, email, D1 and R2 (`docs/E2E.md`) |
| Quality | Lighthouse mobile and desktop (95 in every category), axe, keyboard and motion, headers and SEO (`docs/QUALITY.md`) |
| Screenshots | learner and public pages at 390 and 1280 px, as an artifact |
| Verify | on the `full-verify` label: everything CI does, plus the full build under `wrangler pages dev` with a smoke test |

`docs/CI-FIRST-RUN.md` explains how to read a failure.

## Layout

| Path | What |
|---|---|
| `src/pages/`, `src/components/` | the public site and the admin UI (Astro) |
| `functions/` | Pages Functions: checkout, Razorpay webhook, sign-in, account, course area, media, certificates, admin API |
| `functions/_lib/` | shared server code (`db/`, `pages/` for the server-rendered student pages, `admin/`) |
| `migrations/` | the D1 schema; the site applies them itself on the first request |
| `workers/mailer/` | the mailer Worker (Cloudflare Email Sending, sends as `courses@`) |
| `scripts/` | build steps (`snapshot.mjs`, `csp.mjs`), `setup.mjs` (Cloudflare setup), backups, checks |
| `src/shared/` | the shared types, API shapes and constants (the contracts) |
| `tests/` | unit and integration tests, `e2e/` (Playwright), `quality/`, `ux/` |

## Docs

- `docs/owner/`: the owner guide (setup, everyday admin work, going live), the Razorpay test checklist, rollback, monitoring, legal questions and the setup script reference.
- `docs/platform/`: contracts, hosts, payments, students, media and email.
- `docs/ops/`: runbook, backups, the Cloudflare API notes.
- `docs/design/`: the public site and learner pages.
- `docs/INTEGRATION.md` (how the workstreams were combined), `docs/RELEASE-MERGE.md` (the release branch), `docs/SECURITY-REVIEW.md`.

## Deploy

- **Cloudflare Pages project `feelings-courses`**, Git-integrated with this repo. Build `npm run build`, output `dist`, Node 22. `main` deploys to production; every other branch gets a preview at `https://<branch>.feelings-courses.pages.dev` (slashes become hyphens).
- **Never run `wrangler pages deploy`.** It makes a Direct Upload project, which can't go back to Git integration. Push to GitHub instead.
- **Bindings, variables and secrets** are set per environment by `npm run setup` (`scripts/setup.mjs`, `docs/owner/SETUP.md`): bindings `DB` (D1), `MEDIA` (R2) and `MAILER` (the mailer Worker); variables `APP_ENV`, `HUB_HOST`, `APEX_DOMAIN`, `RAZORPAY_KEY_ID`, `EMAIL_PROVIDER`; secrets `APP_SECRET`, `ADMIN_PASSWORD_HASH`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `MAILER_KEY` and, on production, `DEPLOY_HOOK_URL`. The owner supplies only the Razorpay keys, a Cloudflare token and the deploy hook, in a local `setup.local.json` that git ignores. Values never go in the repo.
- **Before setup** (no D1 bound) the site keeps the old demo flow: the checkout answers in demo or Razorpay test mode from `src/data/course.ts` and `ENROLL_SECRET`, and the account, course area and admin say they aren't set up yet. `docs/platform/PAYMENTS.md` describes the live flow; the demo's payment modes are in `functions/_lib/checkout.ts` (`paymentMode()`).

### Razorpay test payments

In Razorpay's Test Mode: UPI `success@razorpay` succeeds and `failure@razorpay` fails; cards such as Visa `4100 2800 0000 1007` or Mastercard `5500 6700 0000 1002` with any future expiry and any CVV; netbanking shows a mock bank page. The full test plan is `docs/owner/RAZORPAY-TEST-CHECKLIST.md`.
