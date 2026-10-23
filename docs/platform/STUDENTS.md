# Students and learning (W3)

How a student signs in, stays signed in, opens their courses, saves progress and gets a certificate. Code: `functions/_lib/session.ts`, `restore.ts`, `learn.ts`, `students.ts`, `certificates.ts`, `access-link.ts`, `student-api.ts` and the pages in `functions/_lib/pages/`. Tests: `tests/w3/` (D1 shim, fake Razorpay, no real keys).

## Sign-in

There are no passwords and no email. A student gets a session in three ways:

1. **At payment.** W2's verify (and a free enrollment) calls `issueLoginToken(db, studentId, "handoff", path)` and redirects to `https://<hub>/auth/continue?t=…`. The handoff token lasts 10 minutes, works once, and signs in at once.
   - **Only for a first purchase** (`functions/_lib/claim.ts`, security review F1). Nobody checks that the buyer owns the phone number, so a payment or free enrollment hands off only when the student had no other live enrollment before it. Otherwise verify answers with the receipt link, and a free enrollment with `https://<hub>/signin?next=…` (a signed-in device goes straight on).
2. **Restore on a new device** (`/signin`, or `POST /api/auth/restore`). The student types:
   - the phone number or email they paid with;
   - the Razorpay payment ID from their receipt (`pay_…`).
   Both must belong to one paid order in D1. The contact is compared with the student's phone and email and with what they typed into Razorpay's form.
   - **First purchase only** (same rule as the handoff): when the account had a live enrollment before this order, the answer is `use_first_payment` (409): sign in with the first purchase's payment ID, or ask for a WhatsApp link. Only someone holding a paid order for that contact sees it.
   - **Fallback:** for a captured payment D1 hasn't recorded yet (the browser closed before verify and the webhook is late), Razorpay's record is fetched with the server's keys. It must be captured, for the order's exact amount and mode, and is then fulfilled through W2's `fulfilOrder`.
3. **A one-time WhatsApp link from Urmi.** W5's `POST /api/admin/students/:id/access-link` calls `createAccessLink()`. It returns the link and a prefilled `wa.me` message for the admin to send.
   - The link lasts 24 hours and works once. A newer link replaces the student's unused older ones.
   - Opening it shows a **Continue** button first, because WhatsApp's link preview opens links and would otherwise use the token up.

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

- **Restore rate limits** are counted before any lookup:
  - per IP: 5 per 15 minutes;
  - per contact and per payment ID: 5 per day each, hashed so no contact detail sits in `rate_limits`.
- **No enumeration.** An unknown payment, a wrong contact, a refunded order and an erased student all give the same answer. A course that doesn't exist and one the student doesn't have give the same 404. Another student's session id looks like a missing one.
- **Constant-time compares.** Contacts are hashed and compared with `timingSafeEqual`, always against 4 slots. Tokens are looked up by their SHA-256 through a unique index; raw tokens are never stored or logged.
- **CSRF.** JSON writes need `Content-Type: application/json` and a same-origin `Origin`. Form posts need a same-origin `Origin`, or a `Sec-Fetch-Site` that isn't cross-site. This includes `/signin`, to stop login CSRF. Cookies are SameSite=Lax.
- **Rendered pages:**
  - every value is escaped (`html```);
  - the CSP allows no inline script or style;
  - `no-store`, `noindex`, `frame-ancestors 'none'`, and `Referrer-Policy: no-referrer`, so tokens and course paths never leak in a Referer.
- **Redirects** after sign-in accept same-site paths only (`safeRedirectPath`: no `//`, `/\`, schemes or control characters).
- **Audit log:** `student.restore`, `student.handoff_signin`, `student.link_signin`, `student.access_link`, `certificate.issue` and `student.update_profile`. No contact details are logged.

## Left for integration

- **W2:** `GET /api/me/orders/:id` should return W2's `buildReceipt()`, and `/account` should link each payment to its receipt (`receiptPath`). The restore fallback's success path needs W2's `fulfilOrder`; on this branch it is still the stub, so the fallback answers "no_match".
- **W4:** `playLesson` and the `/media/v` route, which checks the session tag (`tokenHash.slice(0, 16)`) with `readSession`.
- **W5:** the admin endpoint for the access link (calls `createAccessLink`), "sign out everywhere" (`revokeAllSessions`) and certificate issue/revoke (`issueCertificate`).
- **W1:**
  - course hosts should send `/signin`, `/account`, `/auth`, `/learn` and `/verify` to the hub (its `PRIVATE_PREFIXES` covers all but `/verify`, which is public);
  - `public/_routes.json` may exclude `/app/*` (static files).
- **W7:** the terms should say "2 devices" and "1 year of access" (constants in `src/shared/constants.ts`).
- Once the platform is live, `ENROLL_SECRET` and `functions/_lib/enrollment.ts` (the demo cookie) can be removed.
