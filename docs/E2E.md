# Browser journeys (e2e)

Real Chromium (Playwright) clicking through the site the way students and the admin do, on every pull request (`.github/workflows/e2e.yml`, about 4 minutes). Never run it on the 2-CPU VM; push and let Actions run it.

## What runs

`tests/e2e/server.mjs` serves the **real** Functions (`functions/`, routed like Pages by `tests/integration/site.mjs`) and the **real** build (`dist/`, with `_headers`, so the hashed CSP is enforced in the browser) over HTTPS. Only the edges are fake:

| Part | Stand-in |
|---|---|
| D1 | `node:sqlite` with every migration, then `tests/e2e/world.mjs` (Glow Makeup: recorded, own subdomain; Studio Makeup Batch: in person, a 1-seat and a 10-seat batch, booking amount; coupons WELCOME10 and GIFTGLOW) |
| R2 | in memory, multipart uploads included |
| Email | the real mailer Worker with a fake Cloudflare Email Service; tests read the messages and open the links |
| Razorpay | `api.razorpay.com` answered in-process; the browser's `checkout.js` is a fake whose "payment" is signed with the (fake) key secret; refunds are confirmed by a signed `refund.processed` webhook |
| Deploy hook | recorded, never called |
| Clock | tests move the server's time forward (24-hour refunds, 15-minute links, rate-limit windows) |

The browser maps every `*.feelingsbeautycare.in` host to the local server and resolves nothing else, so a journey can't reach the live site or the internet. Requests a test makes itself go through the page (`browserFetch` in `fixtures.mjs`), never `page.request` (that runs in Node and would bypass the mapping; the workflow also pins the known hosts to 127.0.0.1 as a safety net).

The build fetches its content snapshot from this server (`SNAPSHOT_URL`), exactly as a production build fetches it from the live site, so the landing pages are the seeded courses.

## Journeys

| File | Covers |
|---|---|
| `01-purchase` | buy on the course subdomain → receipt + receipt email with a sign-in link → lessons, signed video bytes from R2 → Mark as done → certificate → public verify page (also on a 390px phone); closing Razorpay's window charges nothing |
| `02-batches` | booking amount for a studio batch; a full batch refused at checkout from a stale page; two buyers racing for the last seat |
| `03-coupons` | wrong code explained; 10% off reaches Razorpay; 100% code enrolls free, opens the course, can't be used twice |
| `04-refunds` | admin refunds within 24 h, webhook, access ends, receipt says refunded; after 24 h not offered and refused by the API |
| `05-devices` | second phone by emailed link, the paying device signed out on first proof, 2-device limit, single-use and 15-minute links, unknown address gets the same page |
| `06-admin` | sign-in, new course with its web address, fee, module, lesson, video upload, publish (deploy hook, snapshot), student, payment, backup and download, sign out |
| `07-limits` | admin 5 tries per IP, daily lock for everyone, sign-in link limit, order limit |
| `08-mobile` | no sideways scroll on public and admin pages at 390px, checkout fits, tap sizes |

Every test also fails on a browser page error, a CSP violation, or a server error.

## Reading a failure

- `gh run view <run> --log-failed` shows the assertion.
- `gh run download <run> -n e2e-report` gives `playwright-report/index.html` (screenshots per test) and `test-results/e2e/<test>/trace.zip` (open with `npx playwright show-trace trace.zip` or trace.playwright.dev): every request, response header, DOM snapshot and console line.

## Bugs these journeys found

- **Every student form was refused in real browsers.** The student pages sent `Referrer-Policy: no-referrer`; with it browsers send `Origin: null` on the page's own form posts, and the CSRF check refused them: Mark as done, the certificate, `/signin`, `/auth/continue`, the account forms. Unit tests build requests by hand, so they never saw it. Now `same-origin` (still no Referer to other sites).
- **A batch could be overbooked silently.** Seats are checked when the order is created; two buyers who both started checkout for the last seat could both pay. The later payment still books (the money was taken) and is now flagged `order.batch_overbooked` for the admin, refundable after the 24-hour window.
