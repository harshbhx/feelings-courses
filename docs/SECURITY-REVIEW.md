# Security review: integration branch (W0 to W7 + admin UI)

Adversarial review of the whole platform on `feat/integration-w0-w7`, 23 Oct 2026. Every finding has an exploit-style test in `tests/security/review.test.mjs` (or names the existing test that already plays the attack). The tests run the real handlers against the D1 shim and a fake Razorpay, so no real keys are involved.

**Update, 23 Oct 2026 (email identity).** The owner replaced phone identity with email: a student is their email address and signs in with a single-use link sent to it (Cloudflare Email Sending). That closes F4 (squatting is now handled by email proof) and F7 (no phone + payment ID restore), and changes F1, F6 and F8. The design and its threat model are in [Email identity](#email-identity-23-oct-2026) below; its tests are in `tests/security/email-auth.test.mjs`.

Severity: **High** means account or money impact for real users. **Medium** means a protection that can be bypassed. **Low** means limited impact or one that needs an unusual position. **Info** means a hardening note.

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | Takeover of an existing student's account with only their phone number (free course, or any paid course) | High | **Fixed** (now by email proof, see Email identity) |
| F2 | Per-IP rate limits keyed on the full IPv6 address: rotating inside one /64 resets them (restore, order, coupon quote, certificate check, admin login) | Medium | **Fixed** |
| F3 | Webhook replay under a new `X-Razorpay-Event-Id` (the header isn't signed) | Low | Not exploitable: processing is idempotent (test added) |
| F4 | Phone squatting: whoever first buys with a number holds that account | Medium | **Closed** by email identity (E2) |
| F5 | Dependencies: `astro` 5.18.2 and `sharp` 0.34.5 have published advisories | Medium (build time) | **Needs decision** (major upgrades) |
| F6 | `POST /api/order` says "already_enrolled" for an email that owns the course (membership oracle) | Low | Accepted, rate limited |
| F7 | A receipt link plus the buyer's phone number restores a session | Low | **Gone**: no phone or payment-ID sign-in any more |
| F8 | Login CSRF: a cross-site form to `/api/verify`, or a handoff link, signs a visitor into the sender's account | Low | Accepted |
| F9 | 20 wrong admin passwords a day lock new admin sign-ins for an hour (DoS by design) | Low | Accepted |
| F10 | A limited coupon (`max_uses`) can be overused by orders paid at the same time | Low | Accepted |
| F11 | Lessons can be ticked done without watching, then a certificate claimed | Low | Accepted (client-side progress) |
| F12 | Full CSP on course-host landing pages served through `env.ASSETS.fetch` is unverified | Info | **Check on a preview** |
| F13 | HSTS without `includeSubDomains` and `preload` | Info | Owner decision (affects the main site too) |

## Findings

### F1: account takeover with a phone number (High, fixed)

**Attack.** Checkout finds the student by phone number (`payments.ts upsertStudent`), and nothing proves that the buyer owns the number: no OTP, by the owner's choice of no SMS or email service. Mallory, who knows Asha's number:

1. enrolls in any free course (or with a 100% coupon) with Asha's number, and receives `/auth/continue?t=…`, a handoff link signed in as **Asha**. Cost: nothing.
2. Or buys the cheapest course with Asha's number and her own card. Verify hands her a sign-in link to Asha's account. `/signin` with Mallory's own `pay_…` ID and Asha's number also works. She can then refund within 24 hours and keep the session.

Either way she gets every course in Asha's account, Asha's name, email and receipts, the certificate form, and the device list. With the 2-device limit she can also sign Asha out.

**Fix.** `functions/_lib/claim.ts purchaseOpensAccount()`: proof of a purchase (handoff after verify, a free enrollment, restore with a payment ID, including the Razorpay fallback) opens the account only when the student had no other enrollment that still gives access before that purchase started. Otherwise:
- verify redirects to the receipt (no handoff);
- a free enrollment redirects to `https://<hub>/signin?next=…`;
- restore answers `use_first_payment` (409).

A returning customer on a device that is already signed in sees no change. On a new device, they sign in with the payment ID of their first purchase or ask Urmi for a WhatsApp link (`access-link`). Expired and revoked enrollments don't count, so a customer whose year ran out isn't locked out.

**Tests** (rewritten for email identity): `F1: a free course taken with someone else's email…`, `F1: paying for a cheap course with the victim's email…` (verify, the receipt, `/api/auth/email-link`), and `F1 regression: a brand-new email…`; more in `tests/security/email-auth.test.mjs`. The existing `tests/w2/checkout.test.mjs` handoff tests still pass for a first purchase.

**Since email identity** the rule is E2 below (proof of the email, nothing else in the account), and a link is the only way back in on a new device.

### F2: IPv6 rotation past per-IP limits (Medium, fixed)

**Attack.** `restore_ip`, `order_ip`, `coupon_quote_ip`, `certificate_ip` and `admin_login_ip` were counted per `CF-Connecting-IP`. One IPv6 phone or home holds a /64 (2^64 addresses), so every guess could come from a new address. That allowed coupon-code guessing, `already_enrolled` probing (F6) and admin password guessing up to the global lock.

**Fix.** Every per-IP limit now uses `guard.ts ipSubject()` (IPv4 as is, IPv6 cut to its /64), which already existed for `/api/t`. Audit rows still record the full address.

**Tests.** `F2: rotating IPv6 addresses inside one /64…` (sign-in link requests, since email identity), `F2: coupon guessing…`, `F2: admin password guessing…`. The per-IP limits are now `signin_ip`, `order_ip`, `coupon_quote_ip`, `certificate_ip` and `admin_login_ip`.

### F3: webhook replay with a fresh event id (Low, not exploitable)

Razorpay signs the body but not `X-Razorpay-Event-Id`. A captured, signed body re-sent with a new id is stored as a new event and processed again. Every handler is idempotent:
- `fulfilOrder` is guarded by "still unpaid";
- refunds are keyed by `rfnd_…` and guarded by "not processed yet";
- `payment.failed` only touches `created` orders.

A replayed `payment.captured` after a refund doesn't bring access back. The test `F3: a signed webhook replayed…` proves both. Getting a signed body also needs the webhook secret or a copy of Razorpay's traffic. No change made.

### F4: phone squatting (Medium, closed by email identity)

**Closed, 23 Oct 2026:** the phone no longer identifies anyone; email squatting is handled by the first email proof (E3 below). The original finding:

F1's rule protects existing customers. It can't protect a number that has never bought anything: whoever uses it first owns that account, and later purchases by the real owner land in it. A real owner whose purchase lands there gets the receipt, not a session, and has to contact Urmi. Only verifying the number closes this. Options:
- a WhatsApp or SMS OTP at checkout (needs a provider, which the owner declined);
- trusting Razorpay's verified contact (Razorpay doesn't verify it either);
- Urmi checking such cases by hand. The admin can see two different names or emails on one student's orders.

### F5: dependency advisories (Medium, build time; needs decision)

`npm audit --package-lock-only`, 23 Oct 2026:
- `astro` 5.18.2: several XSS advisories (spread attribute names, slot names, `define:vars`, view-transition values), a Host-header SSRF in prerendered error pages, and an RCE in AVIF image optimisation. Fixed only in 7.x.
- `sharp` 0.34.5: libvips, libheif and librsvg CVEs. Fixed in 0.35.5.
- `esbuild` (dev server on Windows only).

**Exposure here is small.** The site is static output and Astro never runs at request time. No page uses `define:vars`, spread props from data, or slot names from data. `sharp` only processes images committed to the repo; admin uploads go straight to R2 and are never decoded. The build does read admin-written text from the snapshot, which Astro escapes as normal text.

Both fixes are major upgrades, and CLAUDE.md pins Astro 5.18.2 to match the main site. Recommended: upgrade both sites together in a separate PR with a full CI build.

### F6: "already_enrolled" as a membership oracle (Low, accepted)

`POST /api/order` with a phone number that already owns the course answers 409 `already_enrolled`, before any payment. It tells a prober that the number is a customer of that course. It is limited per IP (now per /64, F2) and per phone (`order_phone`, 20 a day). Hiding it would mean letting people pay twice and refunding them. Accepted.

### F7: receipt link plus phone restores a session (Low, gone)

**Gone, 23 Oct 2026:** there is no phone + payment ID sign-in any more. The original finding:

The receipt page (a capability link that buyers share on WhatsApp) shows the `pay_…` ID, which is exactly what restore asks for, together with the phone number. Someone who has the link and knows the buyer's number can sign in, within the 2-device limit. Restore by payment ID is the owner's chosen recovery path, and F1 now limits it to the account's first purchase. Suggestion for the receipt copy: "Don't post this link in groups".

### F8: login CSRF (Low, accepted)

`/api/verify` accepts Razorpay's cross-site form post (in-app browsers) without an Origin check. Nothing happens there without a valid signature. A handoff link also signs in on GET. An attacker can therefore sign a victim's browser into the attacker's own account, within an hour of the attacker's payment. The victim would see the attacker's courses, not the other way round. Accepted.

### F9: admin lockout DoS (Low, accepted)

`admin_login_global` (20 wrong passwords a day, from anywhere) locks new admin sign-ins for an hour, and each further wrong password extends it. Signed-in admin sessions keep working. This trades availability for brute-force resistance on purpose.

### F10: coupon `max_uses` overuse under a race (Low, accepted)

The limit is checked when the order is created. Two orders started before either is paid both keep their discount, and `used_count` may end above `max_uses`. Refusing at fulfilment would mean taking money and then failing the purchase. Free coupons are checked atomically and can't overrun.

### F11: certificates without watching (Low, accepted)

Progress comes from the browser (`PUT /api/learn/progress`), so a student can tick every lesson and claim a certificate. A certificate says the course was completed as recorded, which is not proof that every lesson was watched.

### F12: CSP on course hosts (Info, check on a preview)

`hosts.ts` serves the course landing page on `<slug>.feelingsbeautycare.in` through `env.ASSETS.fetch(/c/<slug>)`. Cloudflare documents that `_headers` rules don't apply to responses made by Functions. If the asset binding's response doesn't carry the `_headers` CSP either, `finish()` adds only the baseline policy (no script restrictions). Check it once a course subdomain exists, with `node scripts/smoke-hosts.mjs` (pre-go-live checklist step 8 in `docs/INTEGRATION.md`) or:

```
curl -sI https://<slug>.feelingsbeautycare.in/ | grep -i content-security-policy
```

If only the baseline shows, have the build write the full policy into a JSON file that `hosts.ts` can attach.

### F13: HSTS scope (Info)

`Strict-Transport-Security: max-age=31536000` without `includeSubDomains`. Course subdomains each send their own header, so they are covered after the first visit. Adding `includeSubDomains; preload` belongs on the apex (the main site) and is a decision for both repos.

## Checked and found sound

- **Admin authz:** every file under `functions/api/admin/` sits behind `_middleware.ts`. Without a session the answer is 401. A write without this site's exact Origin is 403, including from a sibling subdomain, which counts as same-site for SameSite cookies. The admin answers only on the hub host in production. Test: `admin: every route under /api/admin refuses…` enumerates the route files.
- **Student authz and IDOR:**
  - every `/api/me/*` and `/api/learn/*` handler scopes by `session.studentId`;
  - a receipt, device or enrollment of another student gives the same 404 as a missing one (test `IDOR: …`);
  - receipt links are HMAC capabilities (`receipt:v1:<id>`, 128 bits) and a key never opens another order;
  - certificate codes are 50-bit Crockford and rate limited.
- **Sessions and cookies:**
  - student cookie `__Host-fbc_s`: HttpOnly, Secure, SameSite=Lax, 32 random bytes, only the SHA-256 stored;
  - admin cookie `__Host-fbc_admin`: SameSite=Strict, idle and absolute expiry, all sessions revoked on a password change;
  - the 2-device limit is enforced in one batch, and a re-sign-in on the same device replaces its old session;
  - login tokens are single use (guarded `UPDATE … RETURNING`).
- **CSRF:**
  - student and checkout JSON writes need a JSON content type plus a same-origin Origin when one is sent;
  - server-rendered form posts check Origin, then `Sec-Fetch-Site`;
  - the admin requires an exact Origin on every write.
- **Payments:**
  - prices come from D1 only;
  - verify checks the HMAC signature, then Razorpay's record (order id, amount, currency, captured);
  - fulfilment is one guarded batch (no double enrollment, coupon or invoice number);
  - refunds reserve the amount atomically, enforce 24 hours on the server, and reconcile by `rfnd_…` id;
  - webhook signatures are checked over the raw body before anything is stored.
- **Media:**
  - signed URLs bind lesson, expiry (2 h at most) and the session tag;
  - every request re-checks the cookie's hash and, in D1, the session and enrollment (60 s cache);
  - free previews are limited to published courses;
  - images are served only for finished `images/` uploads (JPEG, PNG or WebP, sniffed);
  - CORP and hotlink checks apply (tests in `tests/w4/`).
- **SQL injection:** every D1 query uses bound parameters. Dynamic SQL only joins fixed column lists and fixed `WHERE` fragments. Backup table names come from a constant list.
- **XSS:**
  - Function-rendered pages escape every interpolation (`html```), and the receipt page escapes field by field;
  - the admin UI writes text with `textContent` only;
  - JSON-LD and the admin data block escape `<`;
  - Function pages carry `default-src 'none'; script-src 'self'`, and the receipt allows one hashed script;
  - CSV exports neutralise formula cells.
- **Open redirects:** `next` and the paths in login tokens go through `safeRedirectPath`, which allows same-site paths only and rejects `//` and `/\`.
- **Secrets:**
  - read only through `requireSecret()`; none are sent to the browser, and only the Razorpay Key ID reaches checkout;
  - the admin password is either an HMAC, or PBKDF2 peppered with APP_SECRET;
  - no secrets in the repo: `rzp_live_…` values in tests are fakes, and the committed test Key ID is public and owner-approved;
  - backups leave out sessions, tokens and rate-limit rows.
- **Logging:** logs hold error messages, Razorpay ids and order ids, never phone numbers, emails, tokens or secrets. The audit log keeps booleans for profile changes, not the values.

## How to run the tests

```
node --experimental-strip-types --no-warnings --import ./tests/helpers/register.mjs --test tests/security/review.test.mjs tests/security/email-auth.test.mjs
npm test   # the whole suite
```

CI runs them with the rest of `tests/**/*.test.mjs`.

## Email identity (23 Oct 2026)

Owner decisions: no phone identity (the phone is an optional contact field only, never a login factor and never used to find an account); a student is their email; sign-in by an emailed single-use link; email through Cloudflare's own Email Sending. Code: `functions/_lib/claim.ts`, `signin-links.ts`, `email.ts`, `session.ts`, `pages/auth.ts`, `workers/mailer/index.js`; migration `0003_email_identity.sql` (table `email_verifications`). Tests: `tests/security/email-auth.test.mjs` and the rewritten F1/F2 tests in `review.test.mjs`.

### Threat model in six lines

1. **Assets:** a student's courses, progress, certificates, name and receipts; a session cookie is the only key to them.
2. **Proof:** only opening a link sent to the address (or one the admin made) proves the account; typing an email at checkout proves nothing.
3. **A purchase signs the paying device in only** when the account's email was never proven and the account holds nothing else; the first proof of an address signs out every older session once.
4. **Links:** 256-bit, stored hashed, single use, 15 minutes, newest only, Continue button against mail scanners, same-site redirects only.
5. **Enumeration and abuse:** one answer for every address, the lookup and send after the answer, limits per address (3 / 15 min, 10 / day) and per IP /64 (10 / 15 min) counted before any lookup.
6. **Out of scope / accepted:** someone with access to the student's mailbox owns the account (as with every magic-link login); an address mistyped at checkout reaches whoever owns it (the typo check helps, the admin fixes it).

### Rules and why

- **E1: account found by email, never changed by a checkout.** `upsertStudent()` finds the student by email. An existing account's name, phone and email are never changed by a buyer (only an empty name is filled). A phone is stored on a new account only when no other student has it, and nothing ever looks an account up by phone. Test: `takeover: the phone number never finds an account…`.
- **E2: the handoff rule (replaces F1's first-purchase rule).** `purchaseOpensAccount()` is true only when the account's current email has no proof AND the account has no other enrollment in any state AND its own enrollment row didn't exist before the purchase (a renewal keeps progress and the certificate). Expired and refunded courses count now, because the real owner can always sign in by email: there is nobody to lock out. Tests: `takeover: an account whose email was proven…`, `takeover: an unproven account with ANY earlier enrollment…`, F1 in `review.test.mjs`.
- **E3: email squatting closed.** Mallory may buy first with an address that isn't hers and get a handoff on her device (a new, empty account she paid for). When the owner of the address later opens any emailed link, `markEmailVerified()` records the first proof and `revokeAllSessions()` signs Mallory out; from then on no purchase hands off for that account. Window left: between the owner's own purchase and their first click, Mallory's session sees the owner's new course. Test: `email squatting: …`.
- **E4: links.** `requestSignInLink()` issues `login_tokens` rows (purpose `admin_link`, 15 minutes) for existing accounts only; a newer link marks older unused ones used; `consumeLoginToken()` is one guarded `UPDATE … RETURNING` (racing tabs: one wins); GET only shows Continue. Tests: `a link works once, for 15 minutes…`, `tokens: 256 random bits…`.
- **E5: no enumeration.** `/signin` and `/api/auth/email-link` answer the same page or 202 for every address; the lookup, the token and the send run in `waitUntil`, so the response doesn't wait for them (tested with a deliberately slow lookup). Limits are counted before the lookup, so an unknown address is limited exactly like a real one. Tests: `enumeration: …`, `rate limits: …`, F2.
- **E6: receipts.** The on-screen receipt shows the buyer's name only (no phone, no email). Someone who pays with another person's address sees that person's name on the receipt (accepted, Low: it costs a real payment). The receipt email goes to the account's address, never to the payer.
- **E7: the mailer can't be abused.** The Worker is reachable only through the Pages project's service binding (no route, no `workers.dev`), checks a 256-bit shared key in constant time, sends to exactly one recipient with a one-line subject, and always from the one sender its binding allows. Test: `the mailer Worker: …`.
- **E8: no mail, no link; mail never breaks money.** Without a mailer no link is made; a mailer that is down or refusing never fails a payment or a sign-in request (logged as `sent: false`). Tests: `providers: …`, `a broken mailer never breaks a payment…`.
- **E9: admin changes.** "Edit details" with a new email ends the student's unused links and needs a new proof; erase deletes the proof and the links. Test: `admin changes the email: …`.

### Changed findings

- **F1** stays fixed under the new rule (E2). **F4** is closed by E3. **F7** is gone (no payment-ID restore).
- **F6** now leaks whether an *email* owns a course (409 before payment). Same reasoning: limited per IP and per address (`order_email`, 20 a day).
- **F8** (login CSRF) is unchanged for the handoff; emailed links need a same-site Continue post.

