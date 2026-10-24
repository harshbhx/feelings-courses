# CI: what runs and how to read it

GitHub Actions works on this repo: the billing block is gone, and the first CI run was on
`feat/platform-foundation` on the evening of 22 Oct 2026; every PR since has run the workflows below, and the
release branch `release/courses-v1` (docs/RELEASE-MERGE.md) runs all five, the full Verify
included. Nothing in CI deploys: Cloudflare Pages builds from GitHub on its own (production from
`main`, a preview from every other branch).

## What runs

| Workflow | When | What |
|---|---|---|
| `.github/workflows/ci.yml` (CI) | every pull request, every push to `main`, or by hand | `npm ci` · `astro check` · `tsc -p functions` · `npm test` · migrations on D1 · Functions bundle · `npm run build:fast` · `check-dist.mjs` |
| `.github/workflows/verify.yml` (Verify) | the `full-verify` label on a pull request, or Actions → Verify → Run workflow (listed once the file is on `main`), or `gh workflow run verify.yml --ref <branch>` | everything CI does, plus `wrangler d1 migrations apply` twice, the full `npm run build` (as Cloudflare Pages runs it), a smoke test of `dist/` under `wrangler pages dev`, and the build plus the dev server log as an artifact |
| `.github/workflows/e2e.yml` (E2E) | every pull request, or by hand | real Chromium journeys (Playwright) against the real Functions and build, with fake Razorpay, email, D1 and R2 (`docs/E2E.md`) |
| `.github/workflows/quality.yml` (Quality) | every pull request, or by hand | Lighthouse mobile and desktop (95 in every category), axe, keyboard and motion, header, caching and per-host SEO checks (`docs/QUALITY.md`) |
| `.github/workflows/screenshots.yml` (Screenshots) | pull requests that touch the learner or public pages, or by hand | screenshots at 390 and 1280 px as an artifact (`docs/design/`) |

CI and Verify use Node 22 (Cloudflare Pages' default, and `engines`) on `ubuntu-24.04` (pinned:
`ubuntu-latest` is moving to the Ubuntu 26 beta). Builds always use the seed snapshot
(`SNAPSHOT_SOURCE=seed`), never the live site. `gh workflow run` only works for a workflow that is
already on `main`; until the release is merged, use the pull request's checks (and the
`full-verify` label for Verify).

Never run these on the 2-CPU VM. Push the branch and read the results with
`gh run watch`, `gh run view --log-failed` and `gh run download`.

## Checked before the first run (23 Oct 2026, on the VM)

Kept for the record: what the readiness pass (PR #21) checked locally while Actions was blocked.

- `npm ci` would succeed: `package-lock.json` matches `package.json`.
- `tsc -p functions` clean, `astro check` 0 errors, `npm test` all passing on Node 22.
- `scripts/ci/d1-check.mjs`: migrations apply through the runtime's `migrate.ts` on workerd's D1,
  then a second run applies nothing. `wrangler d1 migrations apply --local`, twice, agrees.
- `wrangler pages functions build`: well under the 3 MB (gzipped) limit.

### Found and fixed in that pass

1. **The seed migration would have failed on Cloudflare.** `migrations/0002_seed.sql` built its
   lesson lists with 9- and 17-term `UNION ALL SELECT` chains. D1 allows at most **5 terms in a
   compound SELECT**; `node:sqlite` allows 500. The lists are now `VALUES` rows.
2. **The admin's student search could fail.** D1 refuses a LIKE pattern over **50 bytes**.
   `likePattern()` now keeps the longest prefix that fits.
3. **The test D1 now has D1's limits.** `tests/helpers/d1.mjs` refuses more than 100 bound
   parameters, a compound SELECT over 5 terms and a LIKE pattern over 50 bytes, as D1 does.
4. **Names agree.** `tests/foundation/env-names.test.mjs` checks that `functions/_lib/env.ts`,
   `scripts/setup.mjs`, every `env.NAME` in `functions/` and `dev:full` use the same names.

### Found by the real runs

- The first runs of each workstream branch on 22 Oct failed on small things the VM couldn't see
  (each fixed on its branch before the integration went green the same night).
- 24 Oct, release branch: a certificate test asserted the fixed date "23 October 2026" for a
  certificate issued on the real clock, so it failed from 24 Oct on. It now reads the date back
  from D1 (`tests/w3/pages.test.mjs`).

## Reading a failure

Commands: `gh run list -R harshbhx/feelings-courses -L 5`, then `gh run view <id> --log-failed`.
Verify's artifact: `gh run download <id> -n verify-<run number>` (`dist/` and `dist-pages-dev.log`).

| Step | Most likely failure | What it means, what to do |
|---|---|---|
| (job never starts, 3 s, annotation "recent account payments have failed") | billing | GitHub → Settings → Billing and plans. Nothing in the repo can fix it. |
| Install | `npm ci` "lock file's … does not satisfy" | `package.json` changed without the lock. Run `npm install` and commit `package-lock.json`. |
| Install | `sharp` / `workerd` download error | Network flake on the runner. Re-run the job. |
| Type check (Astro) | `ts(…)` errors in `.astro` or `src/` | A real type error. The file and line are in the log. |
| Type check (Functions) | `Cannot find module '../_generated/migrations.ts'` | postinstall didn't run (`--ignore-scripts`?). `npm run migrations:embed`. |
| Tests | `not ok … ` with a `D1_ERROR: too many …` / `LIKE or GLOB pattern too complex` | A query over one of D1's limits. Rewrite the SQL (VALUES rows, chunked IN lists, `likePattern()`), don't raise the limit in the shim. |
| Tests | a time- or order-dependent failure that passes on re-run | Report it: the tests use mocked `Date`, so this would be a real flake to fix. A failure that started on a new day is a date hard-coded against the real clock (as in the certificate test above). |
| Migrations on D1 | `first run failed: migration 000N_….sql failed: D1_ERROR: …` | That migration doesn't run on D1. It would fail in production on the first request. Fix the SQL. |
| Migrations on D1 | `second run applied …` | A migration name or the `d1_migrations` bookkeeping changed. Check `functions/_lib/migrate.ts`. |
| Bundle Pages Functions | `Could not resolve "…"` | An import that only works in Node or in tests (a `node:` module, a dev dependency, a path with the wrong case). |
| Bundle Pages Functions | `test "$gz" -lt 3000000` fails | The bundle grew past 3 MB gzipped: something large was imported into `functions/`. |
| Build | `[GetStaticPathsRequired]`, `[ImageNotFound]`, `MissingSharp` | An Astro build error; the log names the page. |
| Build | `csp: … inline event handler` / `javascript: URL` | Markup the CSP would block. Move the code into a `<script>`. |
| Build | `csp: the header is … characters` | Too many distinct inline scripts for Pages' 2,000-character header. Merge some, or bundle them. |
| Check dist | `dist/…: N canonical links (want 1)` | A public page without `Base`'s canonical, or with two. |
| Check dist | `dist/…: shows a GSTIN` | Owner decision: a GSTIN is never displayed. Remove it from the page. |
| Check dist | `dist/sitemaps/<slug>.xml is missing` | A course page without its course-host sitemap. |
| Smoke (Verify) | `GET /api/public/snapshot: 500` | The runtime migration failed under Pages. `dist-pages-dev.log` has the `migrate:` line. |
| Smoke (Verify) | `CSP without the build's script-src` | `dist/_headers` didn't reach the page through the middleware (or `csp.mjs` didn't run). |
| Smoke (Verify) | `didn't come up in 60 s` | `wrangler pages dev` failed to start. The log artifact says why. |

## After the release is on `main`

- Optional (a repo setting, Harsh's call): branch protection for `main` with the CI `check` job required.
- After `npm run setup` on the preview (`docs/owner/OWNER-GUIDE.md` Part A), the real D1 runs the
  migrations on its first request. `wrangler d1 execute fbc-courses-preview --remote --command
  "SELECT name FROM d1_migrations"` should list `0001_init.sql` and `0002_seed.sql`.
- Static pages served through Functions in production: check once on the preview that `/` carries
  the hashed `Content-Security-Policy` from `dist/_headers` (the smoke test checks this under
  `wrangler pages dev`; production should match, and if not, pages fall back to the baseline policy
  from `functions/_lib/hosts.ts`, which doesn't block scripts).
