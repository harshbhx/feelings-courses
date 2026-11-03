# Email (sign-in links and receipts)

Owner decision, 23 Oct 2026: a student is identified by their email and signs in with a link sent to it, and email goes out through **Cloudflare's own Email Sending**, so there is no extra paid provider. This replaces the earlier "no email service" decision. The same pattern runs the salon app (`harshbhx/feelings-staff`, ADR-09), which sends from `staff@feelingsbeautycare.in`.

## What is sent

| Email | When | Contains | Code |
|---|---|---|---|
| Sign-in link | the student asks at `/signin` (or `POST /api/auth/email-link`) and the address has an account | a link that works once, for 15 minutes | `signin-links.ts requestSignInLink` |
| Payment received | an order is marked paid (by verify or the webhook, once) | course, amount, receipt number, payment ID, the receipt link, a 15-minute sign-in link | `sendReceiptEmail` |
| You're enrolled | a free enrollment | a 15-minute sign-in link | `sendEnrolledEmail` |
| Admin sign-in link | Urmi presses "Email a sign-in link" | a link that works once, for 24 hours | `access-link.ts createAccessLink` |

Templates: `functions/_lib/email-templates.ts` (plain text first, simple escaped HTML, no images, no tracking, no GSTIN or tax lines). No marketing email is ever sent.

## How it is sent

Pages Functions can't hold a `send_email` binding (Cloudflare's Pages-vs-Workers table: Email Workers ✅ Workers, ❌ Pages). So:

```
Pages Function ──(service binding MAILER, Authorization: Bearer MAILER_KEY)──▶ Worker fbc-courses-mailer ──(send_email binding EMAIL)──▶ Cloudflare Email Service
```

- `functions/_lib/email.ts sendEmail(env, message)` posts `{ to, subject, text, html }` to `MAILER`. It never throws: a failure is logged by kind (never the address, subject, link or token) and returns `false`, so a payment or a sign-in request never fails because of email.
- `workers/mailer/index.js` (plain JavaScript, no build) checks the key in constant time, accepts exactly one recipient and a one-line subject, and sends **from the fixed sender** (`EMAIL_FROM`), whatever the caller asks. Its `send_email` binding is locked with `allowed_sender_addresses: [EMAIL_FROM]`, so even the Worker can't send as anyone else.
- The Worker has no route and setup turns its `workers.dev` and preview URLs off: only the Pages project can call it. The shared key is a second lock in case a route is ever added by mistake.

## Providers (`EMAIL_PROVIDER`)

| Value | Where | What happens |
|---|---|---|
| `cloudflare` | production and previews (set by setup) | sent through the mailer Worker |
| `outbox` | local dev, tests | kept in memory (`outbox` in `email.ts`), one line logged; with `APP_ENV=development` the text (with the link) is logged too. **Refused in production.** |
| (missing) | | `cloudflare` when `MAILER` is bound, else `outbox` outside production, else **off** |

When mail is off (production before setup), no sign-in link is made at all, and `/signin` still answers the same way.

Tests use `tests/helpers/mailer.mjs`: a `MAILER` binding that runs the **real** Worker with a fake `send_email` binding, so the whole path is tested without network or real mail.

## Setup (owner)

`npm run setup` does the Cloudflare part ([docs/owner/SETUP.md](../owner/SETUP.md)): it uploads the Worker with its bindings and the generated `MAILER_KEY`, turns its public URLs off, and binds it to both Pages environments with `EMAIL_PROVIDER=cloudflare`. Before that, in the dashboard ([OWNER-GUIDE.md](../owner/OWNER-GUIDE.md), "Email"):

1. **Workers Paid plan** on the account (Email Sending to any address needs it; 3,000 emails a month are included).
2. **Onboard the domain** `feelingsbeautycare.in`: Compute → Email Service → Email Sending → Onboard Domain. Cloudflare adds SPF, DKIM and DMARC records on a `cf-bounce` sub-domain; Email Routing's MX records are untouched. If the salon app already onboarded it **in the same Cloudflare account**, nothing to do.
3. **Replies:** the sender is `courses@feelingsbeautycare.in` (setting `email.from`). Add an Email Routing rule so mail to it reaches a real inbox (Email Routing → Routing rules → `courses@` → the owner's inbox).
4. The API token needs **Workers Scripts: Edit** as well.

Check after deploying: ask for a sign-in link at `/signin` with an address that has an account, and see it arrive (and not in spam). The audit log shows `student.email_link` with `sent: true` or `false`; the Worker's logs show Email Service error codes such as `E_SENDER_NOT_VERIFIED` or `E_DAILY_LIMIT_EXCEEDED`.

## Limits to know

- New accounts start with a conservative daily sending quota that grows with good sending; Cloudflare's [limits page](https://developers.cloudflare.com/email-service/platform/limits/).
- Our own limits per address: 3 sign-in links per 15 minutes and 10 a day; per IP 10 per 15 minutes (`RATE_LIMITS` in `config.ts`). Orders: 20 a day per address.
- Email Sending is in public beta. If it misbehaves, the admin can still copy a sign-in link and share it on WhatsApp.
