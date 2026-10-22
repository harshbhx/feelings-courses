# Platform contracts (W0 foundation)

The foundation's shared interfaces, and which workstream produces (P) or uses (U) each. Workstreams W1 to W7 code against these. A change goes through a coordinator-approved PR on W0's files (plan section 7.0). New tables or columns need a new migration, which only the coordinator adds.

W1 hosts and SEO · W2 payments · W3 students and learning · W4 media · W5 admin API · W6 admin UI · W7 legal, analytics, ops

## Owner decisions (plan section 10), built into the contracts

| Decision | Where it lives |
|---|---|
| **Subdomains chosen by the admin.** No course slug is hard-coded. | Slugs come only from D1 (`courses.slug`), checked by `isValidCourseSlug()`. The seed's slugs (`selfmakeup`, `diploma`, `crashcourse`, `combo`) are provisional; the admin can rename them until the domain is active. No code may branch on a specific slug. |
| **Academy courses: in-person batch booking AND recorded lessons**, set per course | `courses.format` (`online` / `in_person` / `hybrid`); the academy drafts are seeded as `hybrid`. Batches live in `batches`, lessons in `lessons`. |
| **Fees entered by the admin** | `price_paise NULL` on the drafts. The only price in code is the demo seed's, which is marked `is_demo`. |
| **Refunds: requests within 24 hours of purchase** | `REFUND_WINDOW_HOURS` and `REFUND_WINDOW_SECONDS` in `src/shared/constants.ts`; `OrderSummary.refundableUntil = paidAt + 24 h`. W7 writes the refund page from the constant; W2, W5 and W6 show and enforce the window. |
| **No GSTIN and no tax lines anywhere**; invoice numbering kept | `Receipt.kind` is always `"receipt"` and has no tax fields. `PublicBusiness` has no `gstin`. `BusinessSettings.gstin` is admin-only, stored for records, and **never rendered**. The `orders` tax columns stay NULL / 0. `invoice_counters` and `orders.invoice_no` stay. Checkout doesn't ask for the state. |
| **Access: 1 year** for recorded courses | `DEFAULT_ACCESS_DAYS = 365`; `access_days = 365` on every seeded course. |
| **2 devices per student** | `MAX_DEVICES_PER_STUDENT = 2` (shared), `MAX_SESSIONS_PER_STUDENT` (config.ts). The 3rd sign-in revokes the oldest session. |

## Ground rules

- **Units.** Money is integer paise (`Paise`). Time is integer unix seconds, UTC (`Unix`). Calendar days are `"YYYY-MM-DD"` (`IsoDate`). `daily_stats` days are India time (`statDay()`).
- **Imports.** Functions import with explicit `.ts` extensions. Browser and Functions code shares only `src/shared/*` (types, plus plain constants).
- **Data access.** Use `Db` (`functions/_lib/db/d1.ts`), never `D1Database`. `env.DB` fits `Db` as it is (a compile-time check in `env.ts`), and so does the test shim.
- **Binding rules.** Bind only string, number or null; booleans are 0/1. Writes that belong together go in one `batch()`.
- **Secrets.** Read secrets with `requireSecret(env, name)`, never `env.X` directly. Before the owner runs setup, they are missing.
- **Errors.** Throw `ValidationError`, `ConflictError`, `ConfigError` or `NotImplementedError`. Map them with `errorResponse()`. The response shape is `{ error, message, fields? }`.

## Types: `src/shared/types.ts`

| Type | What | P | U |
|---|---|---|---|
| `Paise`, `Unix`, `IsoDate`, enums (`CourseFormat`, `CourseStatus`, `DomainStatus`, `PaymentMode`, `VideoProvider`, `BatchStatus`, `OrderStatus`, `PaymentKind`, `EnrollmentSource`, `RefundStatus`, `MediaKind`, `MediaStatus`, `LoginTokenPurpose`, `StatField`, `AppEnv`) | Units, and enums that mirror the schema's CHECKs | W0 | all |
| `CourseDetails`, `CourseFaq`, `CourseGlimpse` | The `courses.details` JSON | W0 | W1, W5, W6 |
| `PublicLesson`, `PublicModule`, `PublicBatch`, `PublicCourse`, `PublicBusiness`, `PublicSettings`, `Snapshot` | Content of the build-time snapshot | W1 (`buildSnapshot`) | W1 pages, W2 checkout, W3 learn pages, W7 legal |
| `BuildInfo`, `DomainsManifest` | `dist/build.json`, `dist/domains.json` | W1 | W5 (publish status), W1 middleware |
| `BusinessSettings`, `SettingsMap`, `SettingKey` | Typed `settings` keys (`gstin` is admin-only, never displayed) | W0 | W2 (receipts, legal gate), W5, W7 |
| `Student`, `StudentSession`, `EnrollmentSummary`, `EnrollmentBatch` | Student account | W3 | W5, W6 |
| `LessonProgress`, `LearnLesson`, `LearnModule` | Course area | W3 | W3 UI |
| `Certificate`, `CertificateCheck` | Certificates | W3 | W5, W6 |
| `Watermark`, `SignedMedia`, `PlayInfo` | Signed video playback | W4 | W3 (play route), W4 player |
| `Quote`, `QuoteFailure` | Server pricing | W2 | W2 checkout |
| `RazorpayPayment`, `RazorpayRefund` | The Razorpay entity fields the app reads | W0 | W2, W3 (restore fallback) |
| `OrderSummary`, `Refund`, `Receipt`, `ReceiptLine` | Orders and receipts | W2 | W3 account, W5, W6 |
| `AdminCourse`, `AdminCourseInput`, `AdminModule`, `AdminLesson`, `AdminBatch` | Course editor | W5 | W6 |
| `AdminCoupon`, `AdminCouponInput` | Coupons | W5 | W6 |
| `AdminStudentRow`, `AdminStudent`, `AdminOrder`, `WebhookEventRow` | Students and payments admin | W5 | W6 |
| `MediaItem`, `UploadInit`, `UploadedPart` | Uploads | W4 | W4 UI, W6 |
| `AdminSettings`, `DailyStat`, `Stats`, `PublishStatus`, `AuditRecord` | Settings, dashboard, publish, audit | W5 / W7 (stats) | W6 |
| `CheckoutProps` | Props of `<Checkout>` | W2 | W1 (mounts it) |

## HTTP: `src/shared/api.ts`

- One request type and one response type per endpoint in plan section 4, for example `OrderRequest` / `OrderResponse` or `AdminRefundRequest` / `AdminRefundResponse`.
- `Endpoints` maps `"METHOD /path"` (path parameters written `:name`) to `{ req, res }`. `RequestOf<K>` and `ResponseOf<K>` read from it.
- `ApiErrorBody` and `ApiErrorCode` list the known error codes. Add new ones through a contract PR.
- Who implements each endpoint is the **W** column of plan section 4.

## Constants: `src/shared/constants.ts`

| Name | What | U |
|---|---|---|
| `DEFAULT_HUB_HOST`, `DEFAULT_APEX_DOMAIN` | Fallback hosts | W1, `config()` |
| `RESERVED_LABELS`, `COURSE_SLUG_RE`, `isValidCourseSlug()` | Course slugs, which are also subdomains | W1, W5, W6 |
| `LESSON_SLUG_RE`, `RESERVED_LESSON_SLUGS` | Lesson slugs | W3, W5, W6 |
| `LEGAL_PAGES` | `/terms` and the like on course hosts | W1, W7 |
| `MIN_CHARGE_PAISE` | ₹1 minimum | W2 |
| `REFUND_WINDOW_HOURS`, `REFUND_WINDOW_SECONDS` | 24-hour refund window | W2, W5, W6, W7 |
| `DEFAULT_ACCESS_DAYS` | 365 | W2 (enrollment expiry), W5, W6 |
| `MAX_DEVICES_PER_STUDENT` | 2 | W3, W7 (terms) |

## Browser: `src/lib/api-client.ts`

`api<T>(path, init)`, `call(key, params, body)` (typed from `Endpoints`), `fillPath()` and `ApiError` (`status`, `code`, `fields`, `retryAfter`, `offline`). Used by W2, W3, W4 and W6 client code.

## Build-time content

| File | What | U |
|---|---|---|
| `src/data/snapshot.ts` | `snapshot`, `courses`, `getCourse(slug)`, `snapshotSource`. Reads `src/generated/snapshot.json` (gitignored), else the seed. | W1, W3 pages |
| `src/data/seed-snapshot.ts` | `seedSnapshot()`, `seedCourse()`, `seedSettings()`, `SEED_COURSE_SLUG` (`selfmakeup`). Built from `course.ts`, `lessons.ts` and `site.ts`, with the same ids as the D1 seed. | W1, tests |
| `scripts/snapshot.mjs` | Fetches the live snapshot before the build. Plan 1.1 edge cases: a 404 or an HTML fallback falls back to the seed; a 5xx, an unreachable host or bad JSON fails the build. `SNAPSHOT_SOURCE=seed` and `SNAPSHOT_URL` override it. | build |

**W1:** while D1 isn't bound, `GET /api/public/snapshot` must answer **404**. A 5xx would fail every production build.

## Database: `migrations/`

| File | What |
|---|---|
| `0001_init.sql` | The schema from plan section 2, exactly. |
| `0002_seed.sql` | **DEMO** `selfmakeup` course (`is_demo = 1`, published, ids 1 / modules 1–3 / lessons 1–9). The academy drafts `diploma`, `crashcourse` and `combo` are `hybrid`, with `price_paise NULL` and `access_days = 365` (ids 2–4, modules 4–6, lessons 10–26). All four slugs are provisional. Settings: `business`, `legal_confirmed = false`, `content_version = 1`. |

Tables, and the workstream that writes them (others only read):

| Table | Writer |
|---|---|
| `settings` | W5 (admin), W2 (invoice/legal reads), W7 (`last_backup_at`, `last_cleanup_at`) |
| `courses`, `batches`, `modules`, `lessons` | W5 (`batches.seats_taken`: W2 fulfil) |
| `media` | W4 |
| `students` | W2 (upsert at order), W3 (profile), W5 (manual add, erase) |
| `coupons` | W5 (`used_count`: W2 fulfil) |
| `orders`, `refunds`, `invoice_counters`, `coupon_redemptions`, `webhook_events` | W2 |
| `enrollments` | W2 (payment), W5 (manual and revoke), W3 (`completed_at`) |
| `lesson_progress`, `certificates`, `sessions`, `login_tokens` | W3 (`certificates` also through W5 via `issueCertificate`) |
| `admin_sessions` | W5 |
| `rate_limits` | every rate-limited endpoint, through `ratelimit.ts`; W7 cleans up |
| `daily_stats` | W7 `bump()`, called by W2 and W7 |
| `audit_log` | everyone, through `db/audit.ts` |
| `d1_migrations` | `migrate.ts` only (wrangler's own format) |

## Functions library: `functions/_lib/`

### Final helpers (W0, frozen)

| Module | Exports | U |
|---|---|---|
| `env.ts` | `Env` (DB, MEDIA, ASSETS, APP_ENV?, HUB_HOST?, APEX_DOMAIN?, secrets?), `hasDb()`, `Context` | all |
| `config.ts` | `config(env)`, which returns `AppConfig { appEnv, hubHost, apexDomain, hubOrigin, paymentMode }` (missing `APP_ENV` counts as `production`); `razorpayMode()`, `requireSecret()`, `ConfigError`; constants for cookies, TTLs, `RATE_LIMITS`, upload sizes and `REBUILD_DEBOUNCE` | all |
| `crypto.ts` | `sha256Hex`, `hmacSha256Hex`, `timingSafeEqual`, `randomHex`, `randomToken`, `randomDigits`, `randomCrockford`, `CROCKFORD` | W2, W3, W4, W5 |
| `http.ts` | `json`, `error`, `methodNotAllowed`, `redirect` (303, multiple cookies, security headers), `sameOrigin`, `isJson`, `readBody`, `readJson`, `readForm` (16 KB default), `SECURITY_HEADERS`, `securityHeaders()`, `clientIp()`, `errorResponse()` | all endpoints |
| `ratelimit.ts` | `hit(db, rule, subject)`, which returns `{ allowed, count, limit, resetAt, retryAfter }`; `peek()`, `bucketKey()`, `cleanupRateLimits()` | W2, W3, W5, W7 |
| `migrate.ts` | `applyMigrations(db, migrations?)`, `ensureMigrated(db)` (once per isolate), `resetMigrationState()`, `Migration` | `_middleware.ts`, tests |
| `db/d1.ts` | `Db`, `DbStatement`, `DbResult`, `DbValue`, `unixNow()`, `DAY_SECONDS` | all |
| `db/errors.ts` | `ValidationError`, `ConflictError`, `isUniqueViolation`, `isCheckViolation`, `isForeignKeyViolation` | all |
| `db/validate.ts` | Input validators: `id`, `int`, `paise`, `text`, `slug`, `phone`, `email`, `couponCode`, `razorpayId`, `flag`, `oneOf`, `page`, `likePattern`, … | all |
| `db/audit.ts` | `auditStatement`, `auditStatementWhen`, `writeAudit`, `listAuditLog` | all writers |
| `db/tx.ts` | `batch` (skips empty slots), `changes`, `lastId`, `placeholders`, `chunked`, `whenExists`, `stmt`, `MAX_BOUND_PARAMS` | W2 (fulfil), W5 |
| `db/settings.ts` | `getSetting`, `getSettings`, `setSetting`, `setSettingStatement`, `bumpContentVersionStatement` | W2, W5, W7 |
| `analytics.ts` `statDay()` | India-time day for `daily_stats` | W2, W7 |
| `stub.ts` | `NotImplementedError`, `notImplemented()`, `WaitUntil` | stubs |

### Stubs: signatures frozen by W0, bodies by the owner shown

| Module | Signature | Owner | Called by |
|---|---|---|---|
| `hosts.ts` | `hostRouting(context, next)`. Passes through today. | W1 | `_middleware.ts` |
| `snapshot.ts` | `buildSnapshot(env): Promise<Snapshot>` | W1 | `/api/public/snapshot` |
| `session.ts` | `createSession(db, studentId, request) → { cookie }`; `readSession(env, request) → SessionRef \| null`; `issueLoginToken(db, studentId, purpose, redirectPath) → raw token`; `requireEnrollment(env, request, courseSlug) → EnrollmentRef \| null` | W3 | W2 (handoff), W4, W5 (access link) |
| `certificates.ts` | `issueCertificate(env, { studentId, courseId, name }) → Certificate` | W3 | W3, W5 |
| `orders.ts` | `fulfilOrder(env, { orderId, payment }) → FulfilResult`; `refundOrder(env, orderId, { amountPaise?, reason, revoke }) → Refund`; `syncOrder(env, orderId) → AdminOrder`; `processWebhookEvent(env, eventId)` | W2 | W2, W3 (restore), W5 |
| `pricing.ts` | `quote(db, { courseSlug, batchId?, couponCode?, studentId?, now }) → Quote` | W2 | W2 |
| `media.ts` | `signMediaUrl(env, { kind: "v" \| "c", lessonId, sessionTag, ttl? }) → string` | W4 | W4, W3 |
| `play.ts` | `playLesson(env, enrollment, lessonId) → PlayInfo \| null` | W4 | W3's play route |
| `analytics.ts` | `bump(db, day, courseId, field, by?) → DbStatement` (to use inside a batch) | W7 | W2, W7 |
| `daily.ts` | `maybeRunDaily(env, ctx)` | W7 | W5 middleware, W2 webhook |
| `rebuild.ts` | `requestRebuild(env, ctx) → { queued, nextAllowedAt }` | W5 | W5 |

### W4 additions (media)

| Module | Exports | U |
|---|---|---|
| `media.ts` | `signMediaUrl()` (filled; optional `now`), `verifyMediaLink()`, `sessionTokenHash()`, `mediaUrlExpiry()` | W3 (via `playLesson`) |
| `play.ts` | `playLesson()` (filled; optional `now`), `previewLesson()` | W3 play route, `/api/public/preview/:lessonId` |
| `media-serve.ts` | `serveLessonMedia()`, `serveImage()` for `/media/v`, `/media/c`, `/media/i` | route files |
| `media-rules.ts` | `MEDIA_RULES`, `planUpload()`, `sniffMismatch()`, `MEDIA_KEY_RE` | uploads |
| `uploads.ts` | `startUpload`, `uploadPart`, `completeUpload`, `deleteMedia`, `listMedia`, `mediaImagePath`, `toMediaItem` | admin routes, W5/W6 |
| `src/lib/media-upload.ts` | `uploadMedia(file, options)`, `cancelUpload()` (resumable, browser) | W6 |

**Contract for W5:** the admin media endpoints answer 401 unless `context.data.admin` is an object. W5's `functions/api/admin/_middleware.ts` sets it after checking the admin cookie. Details: `docs/platform/MEDIA.md`.

## Middleware: `functions/_middleware.ts`

The order is `migrate (only if DB bound) → hostRouting (W1) → siteMiddleware (learn gate, W3) → next`. W0 wrote the composition; W1 owns the file from now on. A failed migration is logged and the site keeps serving.

## Tests: `tests/`

- `npm test` embeds migrations, then runs every `tests/**/*.test.mjs` with type stripping. `tests/helpers/register.mjs` makes extensionless imports resolve. It then runs the two existing suites in `scripts/`.
- Each workstream owns `tests/<workstream>/`. W0 owns `tests/db/`, `tests/foundation/` and `tests/helpers/`.

| Helper | Exports |
|---|---|
| `helpers/d1.mjs` | `createTestDb({ migrate?, only? })`, `TestD1` (D1-shaped; `.get()` and `.rows()` for assertions, `.log` of SQL), `loadMigrations` |
| `helpers/r2.mjs` | `FakeR2` / `createFakeR2({ minPartSize? })`: put, get with range or onlyIf (object or Headers), head, delete, list, multipart |
| `helpers/razorpay.mjs` | `fakeRazorpay(t, routes)` returning `{ calls }`; `paymentEntity`, `orderEntity`, `refundEntity`, `signPayment`, `webhook` |
| `helpers/http.mjs` | `SITE`, `req`, `postJson`, `postForm`, `context` (a Pages context with `nextCalls` and `waitUntilPromises`), `fakeAssets`, `cookiesFrom`, `readJson` |

## Scripts and CI

- `package.json` holds every script and devDependency; nobody else edits it.
  - `build` and `build:fast` run `prepare:content` (embed migrations, then snapshot) first.
  - `typecheck` runs `tsc -p functions`.
  - `dev:full` runs `wrangler pages dev` with `--d1 DB --r2 MEDIA`.
  - `setup` and `go-live` run `scripts/setup.mjs`, which W7 writes.
- `.github/workflows/ci.yml` runs `npm ci`, `npm run check`, `tsc -p functions`, `npm test` and `build:fast` (seed). It then runs `scripts/check-dist.mjs` once W7 adds it.
- `.gitignore` covers `setup.local.*`, `.dev.vars`, `src/generated/` and `functions/_generated/`.
