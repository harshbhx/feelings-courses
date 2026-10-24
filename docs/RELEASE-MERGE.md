# Release merge: `release/courses-v1`

Branch `release/courses-v1` holds everything for Feelings Courses v1 in one place: the platform (W0 to W8), email sign-in, the round-2 fixes and the five PRs that were open on top of it. It is meant to **become `main`** in one step, through the draft PR [#29](https://github.com/harshbhx/feelings-courses/pull/29) ("Release: Feelings Courses (merge when switching)"). Nothing on `main` was changed to build it.

Made on 24 Oct 2026. Every merge is a merge commit (`git merge --no-ff`); no branch was squashed, rebased or force-pushed, and no feature branch was edited.

## 1. Starting point

The branch starts at the head of `feat/email-auth` ([#23](https://github.com/harshbhx/feelings-courses/pull/23), commit `ce37e5a`). That head already contains, checked with `git merge-base --is-ancestor`:

| PR | Branch | What |
|---|---|---|
| [#10](https://github.com/harshbhx/feelings-courses/pull/10) | `feat/platform-foundation` | W0 foundation: contracts, D1 schema and migrations, helpers, tests, CI |
| [#11](https://github.com/harshbhx/feelings-courses/pull/11) | `feat/hosts-seo` | W1 course subdomains, per-host SEO, security headers |
| [#12](https://github.com/harshbhx/feelings-courses/pull/12) | `feat/payments-live` | W2 Razorpay live flow on D1 |
| [#13](https://github.com/harshbhx/feelings-courses/pull/13) | `feat/legal-ops` | W7 legal pages, backups, rate limits |
| [#14](https://github.com/harshbhx/feelings-courses/pull/14) | `feat/learn-accounts` | W3 sessions, course area, certificates |
| [#15](https://github.com/harshbhx/feelings-courses/pull/15) | `feat/media-r2` | W4 video on R2 |
| [#16](https://github.com/harshbhx/feelings-courses/pull/16) | `feat/admin-api` | W5 admin API |
| [#18](https://github.com/harshbhx/feelings-courses/pull/18) | `feat/admin-real` | W6 real admin UI |
| [#17](https://github.com/harshbhx/feelings-courses/pull/17) | `feat/integration-w0-w7` | W8 integration of all of the above (`docs/INTEGRATION.md`) |
| [#19](https://github.com/harshbhx/feelings-courses/pull/19) | `fix/security-review` | Security review fixes |
| [#20](https://github.com/harshbhx/feelings-courses/pull/20) | `feat/learner-ux` | Learner UX |
| [#21](https://github.com/harshbhx/feelings-courses/pull/21) | `ci/first-run-readiness` | CI first-run readiness |
| [#22](https://github.com/harshbhx/feelings-courses/pull/22) | `ops/golive-setup-docs` | Go-live ops: setup script, owner guide, rollback, monitoring |
| [#23](https://github.com/harshbhx/feelings-courses/pull/23) | `feat/email-auth` | Email magic-link identity |

`main` itself (the demo, PRs #1 to #9) is also an ancestor, so the release PR into `main` is a fast-forward-shaped diff with no conflicts.

## 2. Merge order

| Step | PR | Branch | Commit merged | Merge commit | Result |
|---|---|---|---|---|---|
| 1 | [#24](https://github.com/harshbhx/feelings-courses/pull/24) Public site polish | `feat/site-polish` | `09f394c` | `3adcf9c` | clean |
| 2 | [#25](https://github.com/harshbhx/feelings-courses/pull/25) E2E journeys | `test/e2e-journeys` | `64c9e61` | `2c0992e` | clean |
| 3 | [#26](https://github.com/harshbhx/feelings-courses/pull/26) Quality (Lighthouse, axe) | `quality/perf-a11y-seo` | `a0fae43` | `af340b8` | clean |
| 4 | [#27](https://github.com/harshbhx/feelings-courses/pull/27) Cloudflare prep (docs only) | `ops/cf-prep` | `ac4c2ef` | `8ae7eae` | clean |
| 5 | [#28](https://github.com/harshbhx/feelings-courses/pull/28) Header and footer (builds on #24) | `feat/header-footer` | `46e5825` | `fa79790` | clean |

All five branches started from `ce37e5a` (none was behind it). #28 contains #24's seven commits, so after step 1 only its own commits were new.

## 3. Conflicts and overlaps

Git reported **no conflicts**. These files were changed by more than one of the five PRs and merged automatically; each result was read by hand:

| File | Changed by | Merged result |
|---|---|---|
| `src/layouts/Base.astro` | #24, #26, #28 | #26 turns the demo ribbon into an `<aside aria-label="Demo notice">` (a landmark, for axe); #24 and #28 changed other parts of the layout. Both kept. #28's header script lists `.demo-ribbon` among the elements hidden behind the open menu, which still matches the `<aside>`. |
| `src/pages/404.astro` | #24, #26, #28 | #26 adds the skip link; #24 and #28 redesign the page. One skip link, before the header, as on every other public page. |
| `src/pages/catalog.astro` | #26, #28 | #26 makes the first card's image the LCP image (`srcset`, `sizes`, `fetchpriority="high"`); #28 changes the header and layout around it. Both kept. |
| `functions/_lib/pages/html.ts` | #25, #26, #28 | #26 adds a meta description to the learner layout; #25 and #28 touch other lines (test hooks, the header and footer). Both kept. |
| `.github/workflows/screenshots.yml` | #24, #28 | #28 already contains #24's version and extends it, so git took #28's. |

The quality, e2e and screenshot workflows check exactly these combinations (the skip link, landmarks, LCP and the header), so a bad automatic merge would fail them.

## 4. Fixes made on this branch

| Commit | Why |
|---|---|
| `036bbc8` test(learner): read the certificate's issue date from D1 | `tests/w3/pages.test.mjs` asserted the fixed text "23 October 2026" for a certificate issued on the real clock, so it failed on every day after 23 Oct. Not caused by the merge; the first CI run on 24 Oct caught it. |

Release docs (this file, the owner guide, README, CLAUDE.md, `docs/INTEGRATION.md`, `docs/CI-FIRST-RUN.md`) were brought up to date in separate `docs:` commits. `.gitignore` already ignores `setup.local.json`, `setup.local.*.json` (the script's output and backup files) and `setup.local.out.txt` since W0, so it needed no change.

## 5. CI on the release branch

All five workflows ran on the pull request [#29](https://github.com/harshbhx/feelings-courses/pull/29) (the `full-verify` label starts Verify).

| Commit | CI | Verify | E2E | Quality | Screenshots |
|---|---|---|---|---|---|
| `fa79790` (the five merges) | failed: one test, the date bug in section 4 | failed: the same test | cancelled by the next push | cancelled | cancelled |
| `036bbc8` (the test fix, the last code change) | [success](https://github.com/harshbhx/feelings-courses/actions/runs/40052733810) | [success](https://github.com/harshbhx/feelings-courses/actions/runs/40052851696) (first full build under `wrangler pages dev` ever) | [success](https://github.com/harshbhx/feelings-courses/actions/runs/40052733817) | [success](https://github.com/harshbhx/feelings-courses/actions/runs/40052733818) (Lighthouse mobile and desktop, axe and HTTP) | [success](https://github.com/harshbhx/feelings-courses/actions/runs/40052733859) |

The commits after `036bbc8` change only docs; the PR's checks show their runs.

## 6. Deploys

- Cloudflare Pages project `feelings-courses` is Git-integrated with **production branch `main`**. Pushing `release/courses-v1` only builds a **preview** (`release-courses-v1.feelings-courses.pages.dev`). The preview environment has no bindings or secrets yet, so the preview runs the demo flow.
- No workflow in `.github/workflows` deploys anything (CI, E2E, Quality, Screenshots and Verify only build and test inside the runner).
- `npm run setup` has **not** been run on Cloudflare, for preview or production.

## 7. Switching to `main` (Harsh)

1. Open [#29](https://github.com/harshbhx/feelings-courses/pull/29), check the checks are green, mark it **Ready for review**, and **Merge pull request** (a merge commit; the history is kept).
2. That push to `main` makes Cloudflare build **production** from the new code. With no bindings on production yet, the new code serves the public pages and the demo checkout, as `main` does today; the learner area and admin say "not set up yet" until setup runs.
3. Then close the stacked PRs (#10 to #28) as included in #29, and delete their branches if you like.
4. Follow `docs/owner/OWNER-GUIDE.md` Part A: setup on the **preview** first, production only after this merge.
