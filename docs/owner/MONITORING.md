# Monitoring and alerts (free Cloudflare features only)

Goal: hear about a broken build, a payment problem or a free-plan limit before a student does, without paying for anything and without adding trackers to the site (the privacy policy promises none).

Paid-only features left out on purpose: Health Checks and Load Balancing monitors (Pro plan and up), Logpush, Workers Logs retention on Pages.

## 1. Turn these on once (15 minutes, Harsh)

| What | Where | Why |
|---|---|---|
| **Pages deployment failed** | Cloudflare → **Notifications** → **Add** → product **Pages** → **Project updates** → project `feelings-courses`, environment **Production**, event **Deployment failed** → email to Harsh and Urmi | A failed "Publish changes" build. The old site stays up, but new content isn't live. Free on all plans. |
| **D1 free-plan limit** | nothing to set: Cloudflare emails the account owner when the daily limit is reached | Since 1 Sep 2026, D1 queries on the free plan **fail** for the rest of the day (until 05:30 IST) once the account passes 5 million rows read or 100,000 rows written that day. Checkout and the course area stop working until then. See section 3. |
| **Cloudflare incidents** | www.cloudflarestatus.com → **Subscribe to updates** → email; pick Pages, D1, R2 and the Mumbai/Chennai locations | Tells you when it's Cloudflare's problem, not ours. |
| **Razorpay webhook failures** | Razorpay → **Account & Settings** → **Webhooks** → the webhook → alert email set to Harsh's address | Razorpay emails when deliveries keep failing and disables the webhook after repeated failures. Without the webhook, refunds don't close access until someone presses **Re-check with Razorpay**. |

## 2. Look once a week (5 minutes)

All free dashboards, nothing to install:

1. **Admin dashboard** (Urmi, daily when selling): payments today, pending refunds, the last backup time. A backup older than 2 days means the daily job didn't run (it runs when the admin is opened or a payment arrives).
2. **Workers & Pages** → `feelings-courses` → **Metrics** → Functions: requests and errors. Errors should be near zero; a jump after a deploy → [ROLLBACK.md](ROLLBACK.md) section 1.
3. **Storage & Databases** → **D1** → `fbc-courses` → **Metrics**: rows read and written per day. Compare with section 3.
4. **R2 object storage** → **Overview**: storage used (free up to 10 GB) and operations.
5. `feelingsbeautycare.in` → **Analytics & Logs** → **HTTP Traffic**: filter by host (`courses.…` or a course subdomain) and status `5xx`. This is Cloudflare's own count, no script on the site.
6. **Workers & Pages** → `feelings-courses` → **Functions** → **Real-time logs** (or `npx wrangler pages deployment tail`) only while chasing a problem. Every server error is one line with a prefix (`server:`, `config:`, `migrate:`, `daily:`, `ratelimit:`, `track:`); none contains a secret or personal detail.

## 3. The free-plan numbers that matter

| Resource | Free per day / month | What uses it here | Rough headroom |
|---|---|---|---|
| Pages Functions requests | 100,000 / day (shared with Workers) | every page that runs code: checkout, course area, admin, video range requests, page-view pings; not the static pages and assets | thousands of students a day |
| D1 rows written | 100,000 / day | each page view ping upserts a daily counter and a rate-limit row (3 to 4 rows with their indexes); each order, sign-in, lesson progress save and admin edit writes a few rows | roughly 25,000 to 30,000 page views a day before the limit; an Instagram post that goes viral can reach it |
| D1 rows read | 5,000,000 / day | admin screens, checkout, course area | ample |
| D1 storage | 5 GB | the whole database | years |
| R2 storage | 10 GB-month | videos (most of it), images, daily dumps | about 3 to 5 hours of 1080p video (more at 720p); check before uploading more |
| R2 operations | 1 M writes, 10 M reads / month | uploads in 10 MB parts; every video range request is a read | ample |
| Pages builds | 500 / month | each "Publish changes" and each merge to `main` | ~15 a day |
| Custom domains | 100 per project | one per course address | ample |

When D1 gets near its daily limit (the Metrics page shows it), the cheapest fix is the Workers Paid plan (US$5 a month, which lifts all three D1 limits by orders of magnitude). Decide that before a big launch rather than during it.

## 4. Optional, later: a free uptime ping

Not set up (it creates a new Worker, which this repo doesn't own). If wanted: a separate Worker on the free plan with a Cron Trigger every 10 minutes that fetches `https://courses.feelingsbeautycare.in/api/public/snapshot` (it reads D1, so it fails when the database does) and, on a non-200 answer, sends an email through Cloudflare Email Routing's `send_email` binding to a verified address. Free on the Workers Free plan (cron triggers and Email Routing are included). Each ping reads a few hundred D1 rows, far inside the free 5 million a day.

## 5. What the site already watches by itself

- The daily job writes `daily.run` or `daily.failed` (with the failed step) to admin → Activity.
- The admin's publish chip compares what's built with what's saved.
- `node scripts/smoke-hosts.mjs <slugs>` after any domain or deploy change: hosts, redirects, security headers, legal pages (read only).
- `node scripts/check-dist.mjs --live` on a live build: no test key and no demo ribbon anywhere.
