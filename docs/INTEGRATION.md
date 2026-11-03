# Integration of W0 to W7 (W8)

Branch `feat/integration-w0-w7`. It is the combined result of all the platform workstreams (W0 to W7, including W6's real admin UI), plus the glue between them, so the whole diff can be read and tested in one place. Draft PR into `main`. Nothing here is merged anywhere else.

**CI not run (GitHub Actions is blocked by billing).** Run locally with Node 24: `tsc -p functions` (clean), `astro check` (0 errors), `tests/**/*.test.mjs` (376 pass), `scripts/test-checkout.mjs` (42 pass) and `scripts/test-learn.mjs` (20 pass). No build, no Playwright, no `check-dist.mjs` against a real `dist/` (the VM rule).

## 1. Merge order

Each branch was merged with `git merge --no-ff` at the commit below, in the hub's documented order:

| Step | Workstream | Branch | PR | Commit merged |
|---|---|---|---|---|
| 0 | W0 foundation (base of the branch) | `feat/platform-foundation` | [#10](https://github.com/harshbhx/feelings-courses/pull/10) | `a004426` |
| 1 | W1 hosts and SEO | `feat/hosts-seo` | [#11](https://github.com/harshbhx/feelings-courses/pull/11) | `769ab1c` |
| 2 | W7 legal and ops (stacked on W1) | `feat/legal-ops` | [#13](https://github.com/harshbhx/feelings-courses/pull/13) | `b5e209e` |
| 3 | W2 payments | `feat/payments-live` | [#12](https://github.com/harshbhx/feelings-courses/pull/12) | `cbb4d93` |
| 4 | W3 students and course area | `feat/learn-accounts` | [#14](https://github.com/harshbhx/feelings-courses/pull/14) | `33954a7` |
| 5 | W4 media on R2 | `feat/media-r2` | [#15](https://github.com/harshbhx/feelings-courses/pull/15) | `5012657` |
| 6 | W5 admin API | `feat/admin-api` | [#16](https://github.com/harshbhx/feelings-courses/pull/16) | `1d63d0b` |
| 7 | W6 real admin UI (stacked on W5) | `feat/admin-real` | [#18](https://github.com/harshbhx/feelings-courses/pull/18) | `0bd4492` |

W1 to W5 started from the same W0 commit; W7 is stacked on W1 and W6 on W5. None changed `package.json` or the lockfile.

## 2. Conflicts resolved

Only two files conflicted. Everything else merged cleanly, W6 included.

| Merge | File | Resolution |
|---|---|---|
| W2, W3, W4 | `docs/platform/CONTRACTS.md` | Each workstream appended its own section after the stub table. All of them were kept, and then the file was tidied: W2 and W3 got their own `### W2 additions` and `### W3 additions` headings (their notes had ended up inside W7's section), and a `### W8 integration` table was added. |
| W3, W4, W5 | `tests/foundation/lib.test.mjs` | Each workstream removed its own stubs from the "still a stub" test. After W5 nothing is a stub any more, so the test now only checks `statDay` and the hub pass-through of `hostRouting`. The real code is covered by each workstream's tests and by `tests/integration/`. |

`CLAUDE.md` merged without a conflict (W1, W2 and W7 edited different lines). Its contract notes were then updated for the integrated state.

W6 merged without a conflict too:
- `src/lib/media-upload.ts`: W6 carried a copy of W4's file so it could build alone. It is the same blob as W4's (`55a3709`), so git kept W4's file as it is.
- W6 deletes the demo admin (its screens, `src/lib/demo-store-coupons.ts` and `src/lib/demo-store-students.ts`). Nothing else on the branch used them; the public demo catalog still uses `src/lib/demo-store.ts`.

## 3. Glue added on this branch

| What | Where |
|---|---|
| **Checkout on the live W2 flow.** `<Checkout course settings platform>` (CheckoutProps) sends an `OrderRequest` naming the course. It has a batch picker (required for in-person courses, optional for hybrid ones), a coupon field checked with `POST /api/coupon/quote`, and the terms, refund (24 hours) and privacy checkbox. Free orders go straight in. A `409 already_enrolled` offers the account. Verify's redirect is followed only to this site or the hub. Without D1 the server answers with the demo flow, so today's demo behaves as before. | `src/components/checkout/Checkout.astro`, `src/components/landing/CourseLanding.astro`, `src/pages/payment-failed.astro` |
| **Session at payment.** W2's verify (and free orders) hand off to W3's `/auth/continue` on the hub, which signs the buyer in and lands on the receipt (or the course for a free order, or `/account` for a studio-only booking). | already wired by W2 and W3 through the frozen `issueLoginToken`; tests updated |
| **Receipts in the account.** `GET /api/me/orders/:id` (W2's `buildReceipt`, own orders only), plus a Receipt link on each `/account` payment. | `functions/api/me/orders/[id].ts`, `student-api.ts`, `pages/account.ts` |
| **Expired video links.** When a 2-hour W4 link has expired, the lesson page asks the play API once for fresh links and resumes from the same place. | `public/app/learn.js`, `pages/learn.ts` |
| **Admin backups.** `POST /api/admin/backup/run` and `GET /api/admin/backup` over W7's `backup.ts` (W5 left them for integration). | `functions/_lib/admin/routes.ts`, `functions/api/admin/backup/` |
| **Host routing for W2 and W3 routes.** `/receipt/*` is private (noindex, never framed) and disallowed in robots.txt. `/app/*` (W3's static CSS and JS) skips Functions. A snapshot test lists what a course host does with every route file (serve, hub or 404), and fails when a new route isn't listed. | `functions/_lib/hosts.ts`, `public/_routes.json`, `tests/integration/routes.test.mjs` |
| **Admin UI on the integrated API (W6).** Refund, Re-check with Razorpay and Replay (W2) and the one-time sign-in link and certificates (W3) are live; their "501 until merged" notes are gone. | `src/components/admin/client/payments.ts`, `students.ts`, `lib/errors.ts` |
| **Backups panel (W6 over the backup routes).** Settings shows the last copy, "Back up now" (`POST /api/admin/backup/run`) and "Download the newest" (`GET /api/admin/backup`, saved through `download()`, with the API's "no backup yet" message). | `src/pages/admin/settings.astro`, `client/settings.ts`, `client/api.ts` |
| **One answer for hosts in the admin.** `GET /api/admin/me` now also returns `hubHost` and `apexDomain` from `config(env)`, the same values the router and the domain check use. The admin builds every course address, the Cloudflare steps and the slug field's domain from them (production's until the answer arrives), and the shell and screens share one `me` request. Admin pages and the admin API keep the router's rules: hub only in production (course hosts and unknown hosts are sent to the hub, the API answers 404 off the hub), any host on a preview with `APP_ENV=preview`. | `functions/_lib/admin/routes.ts`, `src/shared/api.ts`, `src/components/admin/client/api.ts`, `lib/slug.ts`, `lib/domain.ts` |
| **Re-check answers like the drawer's GET.** `POST /api/admin/orders/:id/sync` runs W2's `syncOrder`, then answers with W5's `getOrder` (the shape the drawer already renders). | `functions/_lib/admin/routes.ts` |
| **One definition each** (duplicate helpers removed): session cookie parsing (W3, used by W4), `enrollmentActive` (W3, used by W5), `refundableUntil` (W2, used by W3 and W5), the admin access link (W3's `createAccessLink`, used by W5), the certificate audit row (W3, with the admin as actor), and, with W6: phone numbers (`normalizePhone`, used by W0's validator, W2's checkout and W6), the GSTIN format (W5, W6), the upload types and sizes (W4's table, used by W6's file picker) and rupee formatting (W1's `formatInr`, used by W6). | see `docs/platform/CONTRACTS.md` → W8 integration |

## 4. Bugs and contract mismatches found in the individual PRs

All of these are fixed on this branch only. The individual PRs are unchanged.

| PR | Finding | Fix here |
|---|---|---|
| [#16](https://github.com/harshbhx/feelings-courses/pull/16) W5 | The admin's "issue certificate" wrote two audit rows: W5's own, and W3's, which named the **student** as the actor. | W5 passes `actor: "admin"` to W3's `issueCertificate`, which writes the one row. |
| [#16](https://github.com/harshbhx/feelings-courses/pull/16) W5 | W5's `enrollmentActive` copy ignored `starts_at`, so the admin could show a future-dated enrollment as active while W3 and W4 refuse it. | W5 uses W3's function. |
| [#16](https://github.com/harshbhx/feelings-courses/pull/16) W5 / [#14](https://github.com/harshbhx/feelings-courses/pull/14) W3 | Two `createAccessLink` implementations (the overlap W5's PR flagged). | W3's is kept. W5 checks for a missing (404) or erased (409) student first. |
| [#12](https://github.com/harshbhx/feelings-courses/pull/12) W2 | A free order for an **in-person** course handed off to `/learn/<slug>`, which has nothing to show for a studio-only course. | It lands on `/account`. |
| [#12](https://github.com/harshbhx/feelings-courses/pull/12) W2 + checkout | Verify now redirects to an absolute hub URL (`https://courses…/auth/continue?t=…`), but the existing Checkout followed only paths starting with `/`. Every live buyer would have been sent to `/thank-you` without being signed in. | Checkout follows same-site paths and the hub's origin. |
| [#11](https://github.com/harshbhx/feelings-courses/pull/11) W1 | robots.txt didn't disallow `/receipt/` (W2's pages: name, masked phone, amounts), and the router didn't count it as private. Low impact: W2's receipt already sends `noindex` and `DENY` itself. | Added to the disallow list and the private paths. |
| [#14](https://github.com/harshbhx/feelings-courses/pull/14) W3 / [#16](https://github.com/harshbhx/feelings-courses/pull/16) W5 | Each kept its own copy of `paidAt + 24 h` next to W2's `refundableUntil`. | Both import W2's. |
| [#15](https://github.com/harshbhx/feelings-courses/pull/15) W4 | Its own session-cookie parser accepted tokens of 16 to 128 characters, while W3 issues exactly 43. Harmless, but there were two definitions of the cookie. | W4 uses W3's `sessionToken()`. |
| [#14](https://github.com/harshbhx/feelings-courses/pull/14) W3 | The play API didn't pass its clock to `playLesson`. Its test fixtures use video keys (`v/2001.mp4`) that W4's `MEDIA_KEY_RE` refuses, so no W3 test ever played a real-shaped key. | The clock is passed. `tests/integration` uses W4-shaped keys and plays one end to end. |
| [#15](https://github.com/harshbhx/feelings-courses/pull/15) W4 → W3 | W4 asked the player to fetch new links when a 2-hour link expires. W3's `learn.js` didn't. | Added (section 3). |
| W2, W3, W4, W5 tests | Seven tests asserted the stub-era answer (501, `/thank-you`, `no_match`). | Updated to the integrated behaviour. |
| [#18](https://github.com/harshbhx/feelings-courses/pull/18) W6 | Course addresses used the hub host and the domain typed into the code (and the editor's `.feelingsbeautycare.in` label), not the server's `HUB_HOST` / `APEX_DOMAIN`. A deployment with either set would show addresses the router doesn't serve. | They come from `GET /api/admin/me` (section 3). |
| [#18](https://github.com/harshbhx/feelings-courses/pull/18) W6 / [#12](https://github.com/harshbhx/feelings-courses/pull/12) W2 | "Re-check with Razorpay" rendered W2's `syncOrder` answer, a second mapping of the order next to W5's that the drawer loads. | Sync answers with W5's `getOrder`. |
| [#18](https://github.com/harshbhx/feelings-courses/pull/18) W6 | Own copies of the phone rule, the GSTIN pattern and W4's upload table ("mirrors W4"), which could drift from what the server accepts. | Shared from `src/shared/constants.ts`; a test runs both sides on the same inputs. |
| [#18](https://github.com/harshbhx/feelings-courses/pull/18) W6 | No backups panel (W6 listed it as waiting for the routes). | Added (section 3). |

Nothing was found that changes a frozen signature or the schema. No new migration was needed. The contract additions are all additive: `AdminMeResponse.hubHost` and `apexDomain`, and the shared rules in `src/shared/constants.ts`.

## 5. Integration tests (`tests/integration/`)

- `site.mjs` routes a request the way Pages does: the root `_middleware.ts`, then folder middlewares, then the route file found on disk, then `ASSETS`. The tests therefore run the real `functions/` files, on the D1 shim (`node:sqlite`), the fake R2 and the fake Razorpay, with node:test's mocked `Date`. `world.mjs` builds that world (one published course, `glow`, on its own host) for every test file.
- `purchase.test.mjs`:
  - The buy-to-refund path:
    1. Buy on `glow.feelingsbeautycare.in` with a coupon (₹1,499 less 10% = ₹1,349.10, priced on the server).
    2. Verify, then the hub's handoff signs the buyer in.
    3. The receipt shows `FBC/26-27/00001` and a masked phone, with no GSTIN even though one is stored.
    4. `/account` and `GET /api/me/orders/:id` show the order.
    5. The course area opens, and a signed video plays as a 206 range. The same link without the cookie gets 403.
    6. 2 hours later, the admin refunds it with "remove access".
    7. Razorpay sends its `refund.processed` webhook.
    8. Access is gone: the course area, the play API, and (after the 60-second check cache) the video. The receipt now says Refunded.
  - A refund after 24 hours gets a 409 `refund_window_closed`. Razorpay isn't called, and access stays.
  - A free coupon needs no Razorpay call and signs the buyer in. A second order gets 409.
  - The webhook can arrive before verify: there is still one enrollment and one invoice number.
  - Course hosts send account pages to the hub and answer 404 for hub-only APIs. `/c/glow` on the hub moves to the course host.
  - The admin can run a backup and download the newest one. The daily job's backup counts too.
- `admin-ui.test.mjs`: the requests W6's screens send, checked with W6's own logic (`src/components/admin/lib/`):
  - the session check returns the router's hosts, and the admin's course addresses built from it are served; admin pages go to the hub from course hosts and unknown hosts, the admin API answers 404 off the hub, and a preview (`APP_ENV=preview`) serves both on its own host;
  - payments drawer: `refundState` offers the refund, a full refund goes through, Re-check settles it and answers exactly like the drawer's GET, and Replay of the stored webhook counts nothing twice;
  - student drawer: the sign-in link (confirm page, then signed in) and a certificate issued by the admin, with its public check page;
  - backup panel: "no backup yet", then a run whose time is the panel's "last copy", then the download;
  - one rule each: W6's and W4's upload checks, the three phone checks and both GSTIN checks agree on the same inputs.
- `routes.test.mjs`: the course-host decision for all 74 route files.

## 6. Pre-go-live checklist for Harsh

In order. Nothing here has been done to the Cloudflare or Razorpay accounts.

1. **GitHub billing:** fix it (GitHub → Settings → Billing) so Actions runs. Then re-run CI on this PR: check, Functions type check, tests, `build:fast` and `check-dist.mjs`. That is the first full build of the combined code.
2. **Choose how to merge.** Either review and merge the individual PRs in the order of section 1 and close this one, or merge #10 into `main` and then this PR (it contains all of them, plus the fixes in section 4). If you go one by one, the section 4 fixes still have to land, so take them from this branch.
3. **Legal wording (W7, #13):** confirm the points listed in that PR. They are the grievance officer, the 2-working-day refund start, the 7/30-day rights answers, batch cancellation, and adults only. Then tick "legal confirmed" in the admin.
4. **Setup, preview first:** put the Razorpay **test** keys in `setup.local.json`, enable R2, create the deploy hook, then run `npm run setup -- --check`, then `--dry-run`, then `--env preview`, then production. The plain-language version, with the test checklist, rollback plan, monitoring and the legal wording questions, is in `docs/owner/` (start at `OWNER-GUIDE.md`).
5. **Razorpay dashboard (test mode):**
   - webhook URL `https://courses.feelingsbeautycare.in/api/razorpay/webhook`, with the secret the setup script wrote;
   - events `payment.captured`, `payment.failed`, `order.paid`, `refund.processed` and `refund.failed`;
   - auto-capture on.
6. **The admin on the preview (W6, never seen in a browser yet):** at 390, 768, 1024 and 1440 px.
   1. Sign in with the setup password, then change it in Settings → Admin password (every other session ends).
   2. Make a course: web address, fee, a module and lessons, upload a video (pause and resume once), a cover image; publish it and check "Publish changes".
   3. Settings → Backups: "Back up now", then "Download the newest", and keep the file somewhere off Cloudflare.
   4. Check that "Open Cloudflare" in the web-address helper lands on the project's Custom domains page for this account.
7. **One real test purchase on the preview, on a phone at 390px:**
   1. buy with a coupon;
   2. check the receipt;
   3. open the course and play a lesson;
   4. sign in on a second device, then a third (the first one is signed out);
   5. refund from the admin's Payments drawer within 24 hours, then "Re-check with Razorpay";
   6. check that the course closes once Razorpay confirms the refund;
   7. from the Students drawer, send a sign-in link on WhatsApp and open it on another phone, and issue a certificate and open its check page.

   Also try a free coupon, and in Instagram's in-app browser, the redirect flow.
8. **Course subdomains:** add each one in Pages (the admin shows the steps). Then run `node scripts/smoke-hosts.mjs`, which covers W1's open item "security headers reach the course subdomains" (the CSP on `/c/<slug>` served through the router).
9. **Confirm:** the invoice prefix `FBC/`, and that a payment flagged as a duplicate may be refunded after 24 hours (W2).
10. **Go live:**
   1. publish the real courses with their fees;
   2. unpublish the demo course;
   3. `npm run go-live` with the live keys (it refuses while the legal pages are unconfirmed or the demo is published);
   4. `check-dist.mjs --live`;
   5. switch the Razorpay webhook to live mode.

## 7. Known limits and risks

- **A refund removes access when Razorpay confirms it** (the `refund.processed` webhook, or "Sync with Razorpay" in the admin). Refunds start as pending. If the webhook is missing, access stays until a sync.
- **Video access lasts up to 60 seconds after a refund or sign-out.** W4 reuses a passed check for 60 s in each isolate. The course area and the play API refuse at once.
- **Checkout UI and the whole admin UI haven't been seen in a browser.** No build or Playwright ran on the VM. `astro check` type-checks the scripts, but the checkout's batch picker, coupon field and checkbox, and every admin screen (W6), need a look at 390px and up (checklist steps 6 and 7).
- **W5's admin order views** keep their own SQL mapping, next to W2's `loadAdminOrder` and `toOrderSummary` (two mappings of the same rows). The admin UI now only sees W5's (sync answers with it too); settling on one server mapping is a follow-up.
- **The admin's course addresses** show production's hosts for the moment before `GET /api/admin/me` answers; the screens that list addresses wait for it, so this only matters if that request fails.
- **W6 follow-ups still open:** no live preview of an unpublished course (needs a preview route), and the Cloudflare deep link depends on Cloudflare's dashboard URL format.
- **Backups run from the admin API and the webhook** (W7's lazy daily job). A day with no admin visit and no payment has no backup. D1 Time Travel still covers it.
