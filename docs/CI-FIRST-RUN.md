# The first CI run

GitHub Actions has been blocked by billing since the platform work started, so the first CI run
on `feat/integration-w0-w7` will also be the first real build of the combined code. This page
says what was checked before that run, what is still unknown, and how to read each failure.

## What runs

| Workflow | When | What |
|---|---|---|
| `.github/workflows/ci.yml` (CI) | every pull request, every push to `main`, or by hand | `npm ci` · `astro check` · `tsc -p functions` · `npm test` · migrations on D1 · Functions bundle · `npm run build:fast` · `check-dist.mjs` |
| `.github/workflows/verify.yml` (Verify) | the `full-verify` label on a pull request, or Actions → Verify → Run workflow (listed once the file is on `main`), or `gh workflow run verify.yml --ref <branch>` | everything CI does, plus `wrangler d1 migrations apply` twice, the full `npm run build` (as Cloudflare Pages runs it), a smoke test of `dist/` under `wrangler pages dev`, and the build plus the dev server log as an artifact |

Both use Node 22 (Cloudflare Pages' default, and `engines`) on `ubuntu-24.04` (pinned: `ubuntu-latest`
is moving to the Ubuntu 26 beta). Builds always use the seed snapshot (`SNAPSHOT_SOURCE=seed`), never
the live site.

## Checked before the first run (23 Oct 2026, on the VM)

On Node 22.23.4 (what `setup-node` picks for `22`) and Node 24:

- `npm ci` would succeed: `package-lock.json` matches `package.json` (re-resolved with
  `npm install --package-lock-only`; only the root's `engines` and `hasInstallScript` were stale, now
  fixed). The lock has the linux-x64 builds of rollup, esbuild, sharp and workerd.
- `tsc -p functions`: clean. `astro check`: 0 errors, 0 warnings (4 hints).
- `npm test`: 385 unit and integration tests, 42 checkout tests, 20 course-area tests, all pass on Node 22.
- `scripts/ci/d1-check.mjs`: migrations apply through the runtime's `migrate.ts` on workerd's D1,
  then a second run applies nothing.
- `wrangler d1 migrations apply --local`, twice: both migrations, then "No migrations to apply".
- `wrangler pages functions build`: every route file (76 route paths), 467 KB (115 KB gzipped), well under the 3 MB limit.
- `scripts/ci/smoke-local.mjs` against `wrangler pages dev` serving a small stand-in `dist/` with the
  real `public/`, `_headers` (CSP from `csp.mjs`), `_routes.json` and `functions/`: 31 checks pass.
  The hashed CSP from `dist/_headers` reaches static pages through the root middleware, and the first
  request migrates D1.

### Found and fixed in this pass

1. **The seed migration would have failed on Cloudflare.** `migrations/0002_seed.sql` built its
   lesson lists with 9- and 17-term `UNION ALL SELECT` chains. D1 allows at most **5 terms in a
   compound SELECT** (`too many terms in compound SELECT`); `node:sqlite` in the tests allows 500, so
   every test passed. On the first request in production, 0002 would have rolled back: the schema
   without any course or settings, and an error logged on every request. The lists are now `VALUES`
   rows (not limited). Nothing has been applied to a real D1 yet (setup hasn't run), so editing the
   migration in place is safe.
2. **The admin's student search could fail.** D1 refuses a LIKE pattern over **50 bytes**. The search
   accepted 100 characters, so a long email, or a Gujarati name of about 16 letters (3 bytes each),
   would have answered 500. `likePattern()` now keeps the longest prefix that fits.
3. **The test D1 now has D1's limits.** `tests/helpers/d1.mjs` refuses more than 100 bound
   parameters, a compound SELECT over 5 terms and a LIKE pattern over 50 bytes, as D1 does
   (`tests/db/d1-limits.test.mjs`). With the old seed, the migration tests fail, as they should.
4. **Names agree.** `tests/foundation/env-names.test.mjs` checks that `functions/_lib/env.ts`,
   `scripts/setup.mjs`, every `env.NAME` in `functions/` and `dev:full`'s `--d1 DB --r2 MEDIA` use the
   same binding and variable names. README's list of secrets was the demo's; it now lists the platform's.

### Not checked (the VM doesn't run builds)

- `astro build` itself (images through sharp, every `getStaticPaths`, the endpoints).
- `check-dist.mjs` and `csp.mjs` on a real `dist/` (they pass on `tests/w7`'s fixture build).
- The smoke test on the real build.

## Reading a failure

Commands: `gh run list -R harshbhx/feelings-courses -L 5`, then `gh run view <id> --log-failed`.
Verify's artifact: `gh run download <id> -n verify-<run number>` (`dist/` and `dist-pages-dev.log`).

| Step | Most likely failure | What it means, what to do |
|---|---|---|
| (job never starts, 3 s, annotation "recent account payments have failed") | billing | Still blocked: GitHub → Settings → Billing and plans. Nothing in the repo can fix it. |
| Install | `npm ci` "lock file's … does not satisfy" | `package.json` changed without the lock. Run `npm install` and commit `package-lock.json`. |
| Install | `sharp` / `workerd` download error | Network flake on the runner. Re-run the job. |
| Type check (Astro) | `ts(…)` errors in `.astro` or `src/` | A real type error. The file and line are in the log. |
| Type check (Functions) | `Cannot find module '../_generated/migrations.ts'` | postinstall didn't run (`--ignore-scripts`?). `npm run migrations:embed`. |
| Tests | `not ok … ` with a `D1_ERROR: too many …` / `LIKE or GLOB pattern too complex` | A query over one of D1's limits. Rewrite the SQL (VALUES rows, chunked IN lists, `likePattern()`), don't raise the limit in the shim. |
| Tests | a time- or order-dependent failure that passes on re-run | Report it: the tests use mocked `Date`, so this would be a real flake to fix. |
| Migrations on D1 | `first run failed: migration 000N_….sql failed: D1_ERROR: …` | That migration doesn't run on D1. It would fail in production on the first request. Fix the SQL. |
| Migrations on D1 | `second run applied …` | A migration name or the `d1_migrations` bookkeeping changed. Check `functions/_lib/migrate.ts`. |
| Bundle Pages Functions | `Could not resolve "…"` | An import that only works in Node or in tests (a `node:` module, a dev dependency, a path with the wrong case). |
| Bundle Pages Functions | `test "$gz" -lt 3000000` fails | The bundle grew past 3 MB gzipped: something large was imported into `functions/`. |
| Build | `[GetStaticPathsRequired]`, `[ImageNotFound]`, `MissingSharp` | An Astro build error; the log names the page. Never seen on the VM (no builds there): expect this step to be where a first-run surprise appears. |
| Build | `csp: … inline event handler` / `javascript: URL` | Markup the CSP would block. Move the code into a `<script>`. |
| Build | `csp: the header is … characters` | Too many distinct inline scripts for Pages' 2,000-character header. Merge some, or bundle them. |
| Check dist | `dist/…: N canonical links (want 1)` | A public page without `Base`'s canonical, or with two. |
| Check dist | `dist/…: shows a GSTIN` | Owner decision: a GSTIN is never displayed. Remove it from the page. |
| Check dist | `dist/sitemaps/<slug>.xml is missing` | A course page without its course-host sitemap. |
| Smoke (Verify) | `GET /api/public/snapshot: 500` | The runtime migration failed under Pages. `dist-pages-dev.log` has the `migrate:` line. |
| Smoke (Verify) | `CSP without the build's script-src` | `dist/_headers` didn't reach the page through the middleware (or `csp.mjs` didn't run). |
| Smoke (Verify) | `didn't come up in 60 s` | `wrangler pages dev` failed to start. The log artifact says why. |

## After the first green run

- Turn on branch protection for `main` with the CI `check` job required.
- After `npm run setup` on the preview (docs/INTEGRATION.md, Harsh's steps), the real D1 runs the
  migrations on its first request. `wrangler d1 execute fbc-courses-preview --remote --command
  "SELECT name FROM d1_migrations"` should list `0001_init.sql` and `0002_seed.sql`.
- Static pages served through Functions in production: check once on the preview that `/` carries
  the hashed `Content-Security-Policy` from `dist/_headers` (the smoke test checks this under
  `wrangler pages dev`; production should match, and if not, pages fall back to the baseline policy
  from `functions/_lib/hosts.ts`, which doesn't block scripts).
