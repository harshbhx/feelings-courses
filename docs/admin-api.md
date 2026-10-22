# Admin API (W5)

The JSON API behind the admin at `https://courses.feelingsbeautycare.in/admin`. W6 builds the admin UI on it. Types are in `src/shared/api.ts` (`Endpoints`, request and response types) and `src/shared/types.ts` (`Admin*`); the browser calls it with `call()` from `src/lib/api-client.ts`.

Code: `functions/_lib/admin/` (logic, one module per area; `routes.ts` has every handler), `functions/api/admin/` (thin route files and `_middleware.ts`), `functions/_lib/rebuild.ts` (deploy hook). Tests: `tests/w5/`.

## Conventions

| | |
|---|---|
| Host | Production answers only on the hub host (`HUB_HOST`). Other hosts get 404. Preview and development answer on any host. A missing `APP_ENV` counts as production, so set `APP_ENV=development` in `.dev.vars` for `npm run dev:full`. |
| Auth | Every route except `POST /api/admin/login` needs the admin session cookie. Without it: **401 `unauthorized`** (and the dead cookie is cleared). On 401, show the sign-in form. |
| Writes | `POST`, `PUT` and `DELETE` must send `Origin` equal to the site's origin (browsers do this for `fetch`), else **403 `cross_origin`**. A body must be `Content-Type: application/json`, else **415**. `call()` does both. Exception: W4's upload parts under `/api/admin/uploads/` are binary. |
| Bodies | JSON objects, at most 16 KB. Course create/edit allows 128 KB and the outline 512 KB (the schema's long texts). Over the cap: **413 `too_large`**. Not an object: **400 `invalid_json`**. |
| Responses | JSON with `Cache-Control: no-store`, `X-Frame-Options: DENY`, `X-Robots-Tag: noindex`. Creates answer **201**, deletes and other writes with nothing to return **204**. |
| Errors | `{ error, message, fields? , retryAfter? }` (`ApiErrorBody`). `message` is written for the owner and can be shown as is. **400 `invalid_details`** has `fields: { <field>: message }`; nested fields use paths such as `details.faqs[2].a` or `modules[0].lessons[3].slug`. |
| Ids | Path ids are positive integers. Anything else, or a missing or deleted record: **404 `not_found`**. |
| Units | Money in integer paise (`₹1 = 100`). Times in unix seconds (UTC). Calendar days `"YYYY-MM-DD"`, India time where filters take them. |
| Partial edits | `PUT` on a course, batch or coupon changes only the fields you send; `null` clears an optional field. Unknown keys are ignored, so sending back a whole object is fine. |
| Audit | Every write adds an `audit_log` row (`actor: "admin"`), in the same D1 batch as the change. See `GET /api/admin/audit`. |
| Not set up | Before the owner runs setup (no D1 binding, or missing `APP_SECRET` / `ADMIN_PASSWORD_HASH`): **503 `platform_not_configured`**. |
| Other workstreams | Routes that call another workstream's code answer **501 `not_implemented`** until that workstream is merged (marked W2, W3, W7 below). |

## Session

### `POST /api/admin/login` — `{ password }` → `{ ok: true }` + `Set-Cookie`

- The password is the one `npm run setup` generated (in `setup.local.out.txt`), or the one set later with `POST /api/admin/password`.
- **401 `wrong_password`**.
- **429 `rate_limited`**: more than 5 tries from one IP in 15 minutes (counted before the password is checked). `retryAfter` and `Retry-After` give the seconds to wait.
- **429 `admin_locked`**: more than 20 wrong passwords in a day from anywhere locks sign-in for everyone for an hour; each further wrong password renews the lock. Already signed-in sessions keep working. Show "Sign-in is locked for a while" with `retryAfter`.
- Cookie `__Host-fbc_admin`: HttpOnly, Secure, SameSite=Strict, host-only, `Path=/`. The UI never reads it.
- A session ends after **12 hours without a request**, or **7 days** at most.

### `POST /api/admin/logout` → 204, cookie cleared

### `GET /api/admin/me` → `AdminMeResponse`

`{ ok: true, expiresAt, appEnv, paymentMode }`. `expiresAt` is when the session ends if unused (it slides with every request). `paymentMode` is `"test"`, `"live"` or `"not_configured"`: show a test-mode badge for `"test"`.

### `POST /api/admin/password` — `{ current, next }` → `{ ok: true }` + new `Set-Cookie`

- `next`: 14 to 200 characters, no leading or trailing space, at least 6 different characters, different from `current`.
- Ends **every** admin session, including other devices, and signs this browser in again with the new cookie.
- Same 401 / 429 answers as login. The new password is stored stretched (PBKDF2) in `settings` and overrides the setup secret from then on (`AdminSettings.passwordChanged`).

## Courses

`AdminCourse` is every column plus `modules` (with `lessons`), `batches`, `lessonCount`, `enrollmentCount` and `slugLocked`. Deleted courses never appear.

### `GET /api/admin/courses` → `AdminCourse[]` (catalog order: `sortOrder`, then id)

### `GET /api/admin/courses/:id` → `AdminCourse`

### `POST /api/admin/courses` — `AdminCourseInput` → 201 `AdminCourse`

Creates a **draft**. Required: `slug`, `title`. Defaults: `format: "online"`, `teacher: "Urmi Mengar"`, `accessDays: 365`, `isDemo: false`, `sortOrder: 0`, empty `details`.

| Field | Rule |
|---|---|
| `slug` | The course's subdomain (`<slug>.feelingsbeautycare.in`) and `/c/<slug>`. Lowercased. 2 to 40 of `a-z 0-9`, single inner hyphens. Not a reserved name (`www`, `admin`, `courses`, `academy`, …: `RESERVED_LABELS`). Taken: **409 `slug_taken`**. |
| `title` | 1 to 120. `subtitle` up to 300. `description` up to 20,000, plain text, line breaks kept. `teacher` 1 to 80. |
| `format` | `online` (recorded lessons), `in_person` (batch booking) or `hybrid` (both). |
| `pricePaise` | `null` (no fee yet, draft only), `0` (free) or 100 to 100,000,000. |
| `compareAtPaise` | `null`, or higher than `pricePaise` (the "was" price). |
| `depositPaise` | `null`, or a booking amount of at least ₹1 and below `pricePaise`; not for `online`. |
| `accessDays` | `null` (no expiry) or 1 to 3650. The owner's default is 365. |
| `level` 60, `language` 80, `durationText` 60, `certificateTitle` 200, `seoTitle` 70, `seoDescription` 170 | Optional text, maximum lengths. |
| `coverKey`, `ogImageKey` | `null`, or the R2 key of an **uploaded, finished image** (W4's `media` row, `status: "ready"`). Else 400 "Upload the image first". |
| `details` | `{ outcomes, forWho, highlights }`: up to 20 strings of up to 200; `faqs`: up to 30 `{ q (300), a (3000, multi-line) }`; `glimpses`: up to 20 `{ youtubeId (11 chars), label (120) }`. Missing lists become `[]`. |
| `isDemo` | Example content: ribbon, noindex, live payments refused. |
| `sortOrder` | Integer, catalog order. |

### `PUT /api/admin/courses/:id` — partial `AdminCourseInput` → `AdminCourse`

- Same rules. Fields left out keep their value.
- `slug` can't change once the subdomain is active: **409 `slug_locked`**. A new slug resets `domainStatus` to `none` (the new subdomain needs its own check).
- A published course must keep a fee.
- Editing a **published** course marks the live pages out of date (`content_version` + 1). The change shows on the site after a publish (see Publishing).

### `DELETE /api/admin/courses/:id` → 204

Only a draft or archived course with **no orders and no enrollments**, and no active subdomain; otherwise **409 `in_use`** ("Archive it instead"). The row is kept with `deletedAt` (business rows are never hard deleted), its slug is renamed so the subdomain is free again, and coupons limited to it are turned off.

### `PUT /api/admin/courses/:id/outline` — `AdminOutlineRequest` → `AdminCourse`

The whole outline in one request: the order of `modules` and of each module's `lessons` is the order shown. One D1 transaction.

- Send `id` for existing modules and lessons (they keep their id, so progress and uploads stay attached); omit it for new ones. Moving a lesson to another module is just listing it there.
- Modules and lessons **left out are deleted**, and students' progress on deleted lessons goes with them. Ask before removing lessons from a course with students.
- Lesson rules: `slug` lowercase words with hyphens, unique in the course, not `certificate`, `logout` or `index`; `title` 1 to 160; `minutes` 0 to 600; `videoProvider` `none` / `r2` / `youtube` (`stream` is not available); `videoRef` `null` for `none`, an 11-character id for `youtube`, the R2 key of an uploaded, finished **video** for `r2`; `captionsKey` an uploaded captions file or `null`; `durationSeconds` 0 to 86,400 or `null`; `notes` up to 20,000; `vertical`, `freePreview` booleans.
- At most 50 modules and 300 lessons.
- An `id` from another course: 400 on that field.

### `POST /api/admin/courses/:id/publish` → `AdminPublishResponse`

`{ course, rebuild: { queued, nextAllowedAt, reason? } }`.

- Needs a fee (`fields.pricePaise`), a valid slug, and content: an `online` course at least one lesson (`fields.modules`), `in_person` an open batch (`fields.batches`), `hybrid` either.
- Publishing a course that is already published is "publish my edits": it only asks for a rebuild.
- See Publishing for `rebuild`.

### `POST /api/admin/courses/:id/unpublish` → `AdminPublishResponse`

Published → draft (off the site; students keep their access). Only a published course: else **409**. Already a draft: 200, nothing changes.

### `POST /api/admin/courses/:id/archive` → `AdminPublishResponse`

→ archived: off the catalog, students keep access, can't be bought. `publish` brings it back.

### `POST /api/admin/courses/:id/domain/check` → `AdminDomainCheckResponse`

`{ host, status, probe }`. Fetches `https://<slug>.feelingsbeautycare.in/` (5 s, no redirects followed).

- A 2xx or 3xx answer marks the domain **active**, which locks the slug.
- Anything else marks it **pending** (`probe` is the HTTP status, `"timeout"` or `"unreachable"`).
- An active domain never goes back on a failed check (a blip must not unlock a live address).

Show the owner the steps to add the subdomain in the Cloudflare Pages dashboard, then this button.

## Batches (in-person and hybrid courses)

`AdminBatch`: `{ id, courseId, title, startsOn, endsOn, scheduleText, pricePaise, seats, seatsTaken, status, createdAt, updatedAt }`.

### `GET /api/admin/courses/:id/batches` → `AdminBatch[]` (by start date)

### `POST /api/admin/courses/:id/batches` — `AdminBatchRequest` → 201 `AdminBatch`

- Only for `in_person` and `hybrid` courses (else 400 `fields.format`).
- `title` 1 to 120; `startsOn` a real date; `endsOn` a date not before `startsOn`, or `null`; `scheduleText` up to 300 ("Sat–Sun, 11 am to 4 pm"); `pricePaise` `null` (the course fee) or ₹1+; `seats` `null` (no limit) or 1 to 10,000; `status` `open` (default), `closed` or `cancelled`.

### `PUT /api/admin/batches/:id` — partial `AdminBatchRequest` → `AdminBatch`

`seats` can't go below `seatsTaken`.

### `DELETE /api/admin/batches/:id` → 204

Only a batch nobody booked; else **409 `in_use`** (close or cancel it instead).

Batch changes on a published course mark the live pages out of date.

## Students

### `GET /api/admin/students?q=&course=&page=` → `Page<AdminStudentRow>`

- 25 a page, newest first.
- `q` searches name, email and phone. Digits match the phone however it is typed: `98250 12345` finds `+919825012345`. `%` and `_` are literal.
- `course` keeps students enrolled in that course.
- Phones are **masked** in the list (`+91 ••••• •3210`).
- `paidPaise` is paid minus refunded. Once payments are live, test-mode payments don't count.

### `GET /api/admin/students.csv?q=&course=` → CSV download

Same filters, up to 20,000 rows. Full phone numbers (the owner's own record), amounts in rupees, India time. Logged in the audit log (`student.export`).

### `GET /api/admin/students/:id` → `AdminStudent`

Full contact details, `enrollments` (with `active`), `orders`, signed-in `sessions` (devices), `certificates`.

### `POST /api/admin/students` — `AdminAddStudentRequest` → 201 `AdminStudent`

Adds someone who paid at the studio, for example.

- `name` 1 to 80. `phone`: 10-digit Indian mobile (with or without +91, 0, spaces) or `+<country><number>`. `email` optional.
- A phone or email that already exists: **409 `student_exists`** (the message has the id).
- With `courseId` (and `batchId`, `expiresAt`), access is granted at once, as below.

### `POST /api/admin/students/:id/enrollments` — `AdminGrantRequest` → 201 `EnrollmentSummary`

Gives access by hand (`source: "manual"`, `mode: "live"`: real access, not a test payment).

- `expiresAt` **omitted**: the course's `accessDays` from now (365 by default). `null`: no expiry. A number: must be in the future.
- `batchId`: must belong to the course and not be cancelled. Full: **409 `batch_full`** (add seats first). Takes a seat.
- Already active: **409 `already_enrolled`**. A revoked or expired enrollment is reopened (same id).

### `DELETE /api/admin/enrollments/:id` → 204

Ends access now and frees the batch seat. Repeating it is harmless.

### `POST /api/admin/students/:id/access-link` → `AdminAccessLinkResponse` (W3)

`{ url, whatsappUrl, expiresAt }`: a one-time sign-in link (24 hours, single use) for a student on a new phone. There is no email service: open `whatsappUrl` (a prefilled `wa.me` message to the student) so the owner sends it herself. **501 until W3 is merged.**

### `POST /api/admin/students/:id/signout-all` → 204

Ends every signed-in device of the student.

### `POST /api/admin/students/:id/erase` — `{ confirm: true }` → `AdminStudent`

DPDP erase. It can't be undone, so the body must be `{ "confirm": true }` (else 400). Ask the owner to type the student's name first.

- Removed: name, phone, email and state; the contact Razorpay collected on the orders; sessions and sign-in links; access (enrollments revoked, batch seats freed).
- Certificates are withdrawn and their name replaced.
- Kept: orders with amounts and invoice numbers (business records).
- Repeating it returns the erased student.

### `POST /api/admin/students/:id/certificate` — `{ courseId, name }` → 201 `Certificate` (W3)

Issues or reissues a certificate (`name` 2 to 80, as printed). **501 until W3 is merged.**

## Payments

`AdminOrder` = `OrderSummary` + student (masked phone), batch, list price, discount, coupon, Razorpay ids, method, failure reason and `refunds`. `refundableUntil` = `paidAt` + 24 hours (the owner's refund window). No GSTIN and no tax lines anywhere (owner decision).

### `GET /api/admin/orders?status=&course=&from=&to=&page=` → `Page<AdminOrder>`

- 25 a page, newest first.
- `status`: `created`, `paid`, `failed`, `partially_refunded` or `refunded`.
- `from` and `to` are India-time days, inclusive, on the order's creation time.

### `GET /api/admin/orders.csv?status=&course=&from=&to=` → CSV download

Up to 20,000 rows: order, invoice no, created and paid (IST), status, mode, course, batch, student, phone, list price, discount, coupon, amount, refunded (rupees), method, Razorpay ids. Audited (`order.export`).

### `GET /api/admin/orders/:id` → `AdminOrder`

### `POST /api/admin/orders/:id/refund` — `{ amountPaise?, reason, revoke }` → 201 `Refund` (W2)

- `amountPaise` omitted: the rest of the amount (a full refund). Else ₹1 or more.
- `reason` 1 to 300.
- `revoke`: whether access ends with the refund.
- W2 enforces the **24-hour window**: **409 `refund_window_closed`**. Also **409 `not_refundable`** (not paid) and **409 `mode_mismatch`** (a test order on live keys, or the other way round).
- The refund starts `pending`; Razorpay's webhook settles it.
- **501 until W2 is merged.**

### `POST /api/admin/orders/:id/sync` → `AdminOrder` (W2)

Re-reads the payment and refunds from Razorpay. **501 until W2 is merged.**

### `GET /api/admin/webhooks?pending=1` → `WebhookEventRow[]`

The latest 200 Razorpay webhook events (`pending=1`: unprocessed only). Payloads stay in D1.

### `POST /api/admin/webhooks/:id/replay` → `{ ok: true }` (W2)

Processes a stored event again. **501 until W2 is merged.**

## Coupons

### `GET /api/admin/coupons` → `AdminCoupon[]` (active first, newest first)

### `GET /api/admin/coupons/:id` → `AdminCoupon`

### `POST /api/admin/coupons` — `AdminCouponInput` → 201 `AdminCoupon`

- `code`: 3 to 32 of `A-Z 0-9 _ -`, stored uppercase. Taken: **409 `code_taken`**.
- Exactly one of `percentOff` (1 to 100) and `amountOffPaise` (₹1+).
- `courseId`: `null` for any course.
- `maxUses`: `null` (no limit) or 1+.
- `startsAt` / `expiresAt`: unix times or `null`; the end must be after the start.
- `active` (default true).
- `allowFree` (default false): a 100% coupon may enroll without a payment. Without it, checkout never charges less than ₹1.

### `PUT /api/admin/coupons/:id` — partial → `AdminCoupon`

- Sending only `percentOff` or only `amountOffPaise` switches the kind (the other one is cleared).
- `maxUses` can't go below `usedCount`.
- A used coupon's code can't change: **409 `coupon_used`**.

### `DELETE /api/admin/coupons/:id` → 204

Only if never used; else **409 `coupon_used`**: turn it off with `PUT { active: false }`.

## Settings

### `GET /api/admin/settings` → `AdminSettings`

`business` (with `gstin`), `legalConfirmed`, `paymentMode`, `appEnv`, `lastBackupAt`, `lastRebuildAt`, `contentVersion`, `publishedVersion`, `passwordChanged`.

**`business.gstin` is for the owner's records only. Never show it outside this settings form** (owner decision: no GSTIN on receipts, pages or invoices).

### `PUT /api/admin/settings` — `{ business?, legalConfirmed? }` → `AdminSettings`

- `business`: the whole object. `name` 80, `legalName` 120, `address` 300, `stateCode` two digits (`"24"` Gujarat), `phone` (as for students), `whatsapp` (defaults to the phone; stored as digits for `wa.me`), `gstin` `null` or a valid 15-character GSTIN (uppercased).
- A business change marks the live pages out of date.
- The audit log records **which** fields changed, never the GSTIN's value.
- `legalConfirmed: true` is the owner's confirmation of the legal pages (W2's live-payments gate).

## Publishing

Course pages are static: they are rebuilt from D1 by the Pages deploy hook (~2 minutes). Prices, enrollments, progress and video are always live from D1.

### `GET /api/admin/publish/status` → `PublishStatus`

| `state` | Meaning | UI |
|---|---|---|
| `up_to_date` | The live build shows the latest content. | "Live" |
| `building` | A build for the latest content was requested in the last 15 minutes. | "Updating the site…" (poll every 20 s) |
| `queued` | Saved changes aren't on the live site yet. | "Publish changes" button |
| `unknown` | The live `build.json` can't be read (local dev, or before W1's build.json). | Neutral |

`contentVersion` goes up with every change that touches the public site. `publishedVersion` is the version of the last build requested. `liveVersion` comes from the running deployment's `build.json`. `nextAllowedAt`: when another build may be requested (null: now).

### `POST /api/admin/publish` → `PublishStatus & { rebuild }`

Asks for a rebuild of the whole site, for example after editing a published course.

`rebuild` is `{ queued, nextAllowedAt, reason? }`. When `queued` is false, `reason` says why:

- `debounced`: a build was requested under 2 minutes ago. Retry at `nextAllowedAt`.
- `no_hook`: no deploy hook is set (preview, or before setup). The change is saved; production builds pick it up on the next deploy.
- `hook_failed`: Cloudflare refused the call. Retry now.

## Stats and audit

### `GET /api/admin/stats?from=&to=&course=` → `Stats`

Daily counters (views, checkouts started, paid orders, revenue, refunds) per India-time day, summed over courses unless `course` is given (`0` = hub pages). Default: the last 30 days; at most 400 days. W7 counts them.

### `GET /api/admin/audit?entity=&entityId=&before=&page=` → `AuditRecord[]`

Newest first, 50 at a time.

- `entity`: `course`, `batch`, `enrollment`, `student`, `order`, `coupon`, `settings`, `site`, `admin` or `webhook`. `entityId` needs `entity`.
- Page with `before=<id of the last row shown>` (stable while new rows arrive), or with `page`.

Actions written by W5:

- `admin.login`, `admin.login_failed`, `admin.logout`, `admin.password_change`
- `course.create|update|delete|publish|unpublish|archive|outline|domain`
- `batch.create|update|delete`
- `student.add|export|signout_all|erase|access_link`
- `enrollment.grant|revoke`
- `certificate.issue`
- `order.export`
- `coupon.create|update|delete`
- `settings.update`
- `site.rebuild`
- `webhook.replay`

## Not in W5

- Uploads and the media library (`/api/admin/uploads`, `/api/admin/media`): W4.
- Backups (`GET /api/admin/backup`, `POST /api/admin/backup/run`): W7's `backup.ts`; the routes are wired at integration.
- `POST /api/admin/dev/seed` (preview-only fake data): not built.

## Security notes

- Passwords are compared in constant time. A password changed in the admin is stretched with PBKDF2-SHA256 (100,000 iterations, random salt, peppered with `APP_SECRET`). The setup password is a 20-character random string keyed with `APP_SECRET`.
- Only the SHA-256 of the session token is stored (`admin_sessions.token_hash`).
- CSRF: SameSite=Strict cookie, plus the Origin check, plus JSON-only bodies.
- The deploy hook URL must be `https://api.cloudflare.com/…`; the domain probe only fetches `<stored slug>.<apex domain>`.
- CSV exports defuse spreadsheet formulas (cells starting with `= + - @` get a leading `'`).
- Every SQL statement binds its values; column names in dynamic `UPDATE`s come from fixed lists in code.
