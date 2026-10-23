# Operations runbook (W7)

For the owner and whoever helps run the site. Everything here is a Cloudflare dashboard click, a `wrangler` command on a laptop, or an admin screen; nothing needs a server.

## Daily job

`functions/_lib/daily.ts` runs at most once a day, triggered by an admin page visit or a Razorpay webhook (Pages has no cron). It claims the run with one conditional write, so two requests never run it twice, and then (after the response is sent):

- deletes expired rate-limit rows, sessions and login tokens (expired or revoked more than 30 / 7 days ago), and expired admin sessions;
- aborts video uploads left unfinished for a day (frees their parts in R2) and marks them `aborted`;
- writes the daily backup to R2 and prunes old ones (BACKUPS.md).

Each run leaves an audit log entry: `daily.run` with the counts, or `daily.failed` with the step that failed. A failed step doesn't stop the others and isn't retried until the next day.

## Rate limits and abuse protection

| Where | What | Code |
|---|---|---|
| Every request | Odd methods (TRACE, WebDAV…) 405, URLs over 2,048 characters 414, NUL bytes 400, declared bodies over 256 KB 413 (upload parts 11 MB, the webhook 1 MB), before any database work | `functions/_lib/abuse.ts`, first step of `functions/_middleware.ts` |
| Endpoints | Fixed-window limits in D1 (`RATE_LIMITS` in `config.ts`): admin login 5 / 15 min per IP and 20 / day overall, sign-in links 10 / 15 min per IP and 3 / 15 min and 10 / day per email, orders 10 / 10 min per IP and 20 / day per email, coupon quotes 20 / 10 min, page views 60 / min, certificate checks 30 / min | `functions/_lib/guard.ts` `enforceRateLimits()` over W0's `ratelimit.ts` |
| Subjects | IPv4 as is; IPv6 per /64 (one home or phone), so rotating addresses doesn't reset a limit; phones and emails hashed before they're stored | `ipSubject()`, `contactSubject()` |
| On a D1 error | Limits fail open (checkout keeps working) except where a guess is worse than an outage: pass `onError: "closed"` (admin login) | `enforceRateLimits()` |
| Page views | `POST /api/t` is same-origin JSON only; bots, unknown or unpublished courses and floods are ignored without telling the caller | `functions/api/t.ts` |
| Hosts | Course hosts serve only their landing page, checkout APIs and assets; anything else goes to the hub or 404s | `functions/_lib/hosts.ts`, docs/platform/HOSTS.md |
| Headers | HSTS, nosniff, Referrer-Policy, Permissions-Policy and X-Frame-Options on every response, a hashed CSP on static pages, DENY plus noindex on private areas | `hosts.ts` `finish()`, `scripts/csp.mjs` |

A 429 answers `{ "error": "rate_limited", "message", "retryAfter" }` with a `Retry-After` header; the browser client (`src/lib/api-client.ts`) shows the wait.

**Under attack** (lots of 429s in the logs, D1 usage climbing): Cloudflare dashboard → the `feelingsbeautycare.in` zone → Security → turn on "Under Attack" mode for the course hosts, or add a WAF rate-limiting rule for `/api/*` (one rule is free). Both are reversible with one click.

## Logs

Workers & Pages → `feelings-courses` → Functions → Real-time logs (or `npx wrangler pages deployment tail`). Every server error is logged as one line with a prefix: `server:`, `config:`, `migrate:`, `daily:`, `ratelimit:`, `track:`. No secret or personal detail is ever logged.

## Secrets and keys

| Secret | Rotate how | Effect |
|---|---|---|
| Admin password | Admin → Settings → change password (stored as a hash in D1, overrides `ADMIN_PASSWORD_HASH`) | other admin sessions end (W5) |
| `APP_SECRET` | delete `setup.local.out.json`, run `npm run setup` | signed video links and the admin password hash change: everyone watching gets a new link on the next play; set the admin password again from `setup.local.out.txt` |
| Razorpay key secret | Razorpay → regenerate the key, put it in `setup.local.json`, `npm run setup` | none for students |
| Razorpay webhook secret | delete its line in `setup.local.out.json`, `npm run setup`, paste the new secret in Razorpay's webhook | none |

After any variable change, redeploy (Pages → Deployments → Retry the latest) so Functions pick it up.

## Checks after a deploy

- `node scripts/smoke-hosts.mjs [slug …]`: hosts, redirects, security headers, legal pages (read-only).
- `node scripts/check-dist.mjs` runs in CI after the build: CSP present, routes file sane, canonicals, JSON-LD, no GSTIN on any public page. `--live` adds: no test key and no demo ribbon anywhere.

## Incidents

1. **Payments failing**: check Razorpay's status page, then the logs for `config:` lines (a missing secret answers 503 `platform_not_configured`).
2. **Wrong content after a publish**: the admin's publish status compares `build.json`'s `contentVersion` with the database; a failed build leaves the previous deployment live. Retry the deploy from the Pages dashboard.
3. **Data damaged**: stop editing, take an offline export (`node scripts/backup-d1.mjs`), then restore (BACKUPS.md).
4. **A leaked secret**: rotate it (table above), then check the audit log (admin → Audit) for anything done with it.
