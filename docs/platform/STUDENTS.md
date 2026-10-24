# Students and learning (W3)

How a student signs in, stays signed in, opens their courses, saves progress and gets a certificate. Code: `functions/_lib/session.ts`, `claim.ts`, `signin-links.ts`, `email.ts`, `learn.ts`, `students.ts`, `certificates.ts`, `access-link.ts`, `student-api.ts` and the pages in `functions/_lib/pages/`. Tests: `tests/w3/` and `tests/security/` (D1 shim, fake Razorpay, a fake Email Service behind the real mailer Worker, no real keys).

## Sign-in (email identity, owner decision 23 Oct 2026)

A student **is their email address**. There are no passwords, and the phone number is only an optional contact detail: it never finds, links or opens an account. Email goes out through Cloudflare's own Email Sending (no paid provider): `functions/_lib/email.ts`, the mailer Worker in `workers/mailer/`, and [EMAIL.md](EMAIL.md).

A student gets a session in three ways:

1. **At payment, on the paying device, for a new account only.** W2's verify (and a free enrollment) calls `issueLoginToken(db, studentId, "handoff", path)` and redirects to `https://<hub>/auth/continue?t=…`. The handoff token lasts 10 minutes, works once, and signs in at once.
   - Typing an email at checkout proves nothing, so the handoff happens only when `claim.ts purchaseOpensAccount()` allows it: the account's email has **never been proven** (no row in `email_verifications` for its current address) **and** the account holds nothing from before this purchase (no other enrollment in any state, and the purchase isn't a renewal of an older enrollment row).
   - Otherwise verify answers with the on-screen receipt, a free enrollment with `https://<hub>/signin?sent=1` ("check your email"), and a device that is already signed in as that student goes straight to the receipt.
   - Either way the account's email gets the receipt and a fresh sign-in link (`sendReceiptEmail` / `sendEnrolledEmail` in `signin-links.ts`), once per order: whichever of verify and the webhook marked it paid sends it.
2. **An emailed link** (`/signin`, or `POST /api/auth/email-link { email, next? }`). The student types their email; when it belongs to an account, a link is emailed to it.
   - The link is `https://<hub>/auth/continue?t=<43 characters>`: 256 random bits, only the SHA-256 stored (`login_tokens`, purpose `admin_link`), **single use, 15 minutes** (`EMAIL_LINK_TTL`), and a newer link replaces the student's unused older ones.
   - Opening it shows a **Continue** button first: mail scanners (Outlook Safe Links, Gmail's previews) fetch links and would otherwise use the token up. Continue signs this device in and lands on `next` (same-site paths only).
   - **Same answer for every address** (no enumeration), and the lookup, the link and the send run after the answer (`waitUntil`), so the response time doesn't tell either.
   - Receipt and enrollment emails carry the same kind of link (15 minutes). An expired or used link opens the sign-in form with "That sign-in link has expired or was already used".
3. **A link from Urmi.** W5's `POST /api/admin/students/:id/access-link` calls `createAccessLink()`: 24 hours, single use, **emailed to the student** at once; the admin also gets the link to copy and a prefilled `wa.me` message to share it on WhatsApp (for a student who can't reach their inbox).

**Proof of the email.** Opening an emailed or admin link (Continue) is the proof: `markEmailVerified()` records the address in `email_verifications`. **The first proof of an address signs out every session from before it, once** (`revokeAllSessions`): a handoff session someone got by paying with an address that isn't theirs ends the moment the real owner opens a link. After that, no purchase can hand off a session for that account again.

**Changing the email.** Only the admin changes it ("Edit details", `PUT /api/admin/students/:id`): the student's unused links end, and the new address needs its own proof. A student can change their name on `/account`, not their email or phone.

**Accounts from before email identity** (phone only, no email): they can't be found by anything typed. The admin adds their email with "Edit details" and sends a link.

## Sessions and devices (owner decision: 2 devices)

- Cookie `__Host-fbc_s`: 32 random bytes. D1 stores only the SHA-256 hash, so a database leak signs nobody in. HttpOnly, Secure, SameSite=Lax, hub only.
- Sessions last 180 days, sliding (refreshed at most daily).
- **At most 2 live sessions per student.** The 3rd sign-in revokes the least recently created one.
  - Signing in again on a device that already has a session replaces that session, so it doesn't push out the other device.
- `/account` lists the devices, with a sign-out button per device and "sign out every other device".
- An erased student's sessions and tokens stop working at once.

## Access (owner decision: 1 year)

`enrollmentActive()` in `session.ts` decides access:
- the enrollment is not revoked (a refund revokes it);
- it has started and has not expired (`expires_at`, set by W2 from the course's `access_days`, 365 by default; W5 can set another date or none);
- it is not a test-mode enrollment while the site runs on live keys;
- the course is not deleted.

`requireEnrollment()` (for W4's playback) and every course-area page and endpoint use it. An expired student sees "Your access ended on …" with a WhatsApp link, never the lessons.

## The course area

With D1 bound, `/learn/**` is rendered live from D1 by `pages/learn.ts`, through the same gate as before (`functions/learn/_gate.ts`, which also catches odd spellings like `/%6cearn`). Without D1 the demo's static pages and its `fbc_enroll` cookie work exactly as before. Signing in clears that cookie.

| Path | What |
|---|---|
| `/learn` | → `/account` |
| `/learn/<course>` | progress, "Continue", modules and lessons, batch, certificate card |
| `/learn/<course>/<lesson>` | W4's signed video (a calm placeholder until W4 lands), notes as text, "Mark as done", previous and next |
| `/learn/<course>/certificate` | ask for the certificate, or correct the name on it |
| `/learn/logout` | POST signs this device out; GET only shows the button |
| `/account` | courses, devices, payments, name |
| `/signin`, `/auth/continue` | sign-in |
| `/verify`, `/verify/<code>` | public certificate check and printable certificate |

The pages work without JavaScript (plain forms). `/app/learn.js` adds resume-where-you-left-off and saves the position (`PUT /api/learn/progress`) every 15 seconds while playing. Watching to the end ticks the lesson. Styles are in `/app/app.css`.

When every lesson is done, the enrollment's `completed_at` is set once and never cleared.

## Certificates

- Only for a course with `certificate_title` (the wording is never invented), after every lesson is done.
- The student chooses the name to print (2 to 80 characters). A correction keeps the same code, so a printed or shared link keeps working.
- A revoked certificate can't be reissued by the student.
- Code: 10 Crockford base32 characters (about 50 bits).
- `/verify/<code>` is the printable certificate and the public proof in one page. It is rendered live, so a withdrawn certificate stops showing at once.
  - It shows the name, course, wording, teacher and date only.
  - Typed codes are normalised: case, hyphens, I and L read as 1, O as 0.

## Security

The threat model and the tests are in [SECURITY-REVIEW.md](../SECURITY-REVIEW.md), "Email identity", and `tests/security/email-auth.test.mjs`.

- **Sign-in link rate limits** are counted before any lookup, and every try counts (refused ones too):
  - per IP (IPv6 per /64): 10 per 15 minutes (`signin_ip`);
  - per address, hashed so no address sits in `rate_limits`: 3 per 15 minutes and 10 a day (`signin_email`, `signin_email_day`), from any IP. An address with no account is limited exactly the same way.
- **No enumeration.** An unknown address, an erased student and a real account give the same page and the same 202. A course that doesn't exist and one the student doesn't have give the same 404. Another student's session id looks like a missing one.
- **Tokens.** 32 random bytes; only SHA-256 in D1, looked up through a unique index (the raw token is never compared, stored or logged); single use through one guarded `UPDATE … RETURNING`; expiry checked in the same statement. Erasing a student deletes their tokens and their email proof.
- **No mail, no link.** Without a mailer (production before setup) no sign-in link is made at all: a link nobody receives is only a risk.
- **CSRF.** JSON writes need `Content-Type: application/json` and a same-origin `Origin`. Form posts need a same-origin `Origin`, or a `Sec-Fetch-Site` that isn't cross-site. This includes `/signin` and `/auth/continue`, to stop login CSRF. Cookies are SameSite=Lax.
- **Rendered pages:**
  - every value is escaped (`html```), in emails too;
  - the CSP allows no inline script or style;
  - `no-store`, `noindex`, `frame-ancestors 'none'`, and `Referrer-Policy: same-origin`, so tokens and course paths never leak in a Referer to another site. Not `no-referrer`: with it, browsers send `Origin: null` on the pages' own form posts, and the CSRF check above refuses them (the e2e journeys caught this).
- **Redirects** after sign-in accept same-site paths only (`safeRedirectPath`: no `//`, `/\`, schemes or control characters).
- **Receipts** show the buyer's name only: no phone, no email.
- **Audit log:** `student.email_link` (`sent` true/false), `student.handoff_signin`, `student.link_signin` (`firstProof` on the first proof), `student.access_link` (`emailed`), `order.receipt_email`, `student.update_details` (which fields changed, never the values), `certificate.issue` and `student.update_profile`. No email address, phone number or token is ever logged.

## Left for integration

- **W2:** `GET /api/me/orders/:id` should return W2's `buildReceipt()`, and `/account` should link each payment to its receipt (`receiptPath`). (The phone + payment ID restore and its Razorpay fallback are gone since email identity: a payment the browser never reported is recorded by the webhook, which also sends the receipt email.)
- **W4:** `playLesson` and the `/media/v` route, which checks the session tag (`tokenHash.slice(0, 16)`) with `readSession`.
- **W5:** the admin endpoint for the access link (calls `createAccessLink`, which emails it), "sign out everywhere" (`revokeAllSessions`), "Edit details" (`PUT /api/admin/students/:id`) and certificate issue/revoke (`issueCertificate`).
- **W1:**
  - course hosts should send `/signin`, `/account`, `/auth`, `/learn` and `/verify` to the hub (its `PRIVATE_PREFIXES` covers all but `/verify`, which is public);
  - `public/_routes.json` may exclude `/app/*` (static files).
- **W7:** the terms should say "2 devices" and "1 year of access" (constants in `src/shared/constants.ts`).
- Once the platform is live, `ENROLL_SECRET` and `functions/_lib/enrollment.ts` (the demo cookie) can be removed.
