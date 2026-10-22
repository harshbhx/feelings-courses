/**
 * Shared data contracts of the course platform (W0 foundation).
 *
 * Imported by the Astro pages (build time and browser) and by the Pages Functions, so this file
 * holds types only (no runtime code, no imports from Workers or Astro). Field names are camelCase;
 * the D1 columns they come from are snake_case (migrations/0001_init.sql). Mapping happens in the
 * Functions' data-access code, never in the browser.
 *
 * Units, everywhere:
 * - money is `Paise` (integer paise, INR only);
 * - time is `Unix` (integer seconds, UTC);
 * - calendar days are "YYYY-MM-DD" strings (batches, daily stats).
 *
 * Changing a type here is a contract change: it needs a coordinator-approved PR (plan 7.0).
 * docs/platform/CONTRACTS.md lists which workstream produces and consumes each type.
 */

// ---------------------------------------------------------------- units and enums

/** Integer paise. ₹1 = 100. Never a float. */
export type Paise = number;
/** Integer unix seconds, UTC. */
export type Unix = number;
/** "YYYY-MM-DD". */
export type IsoDate = string;

export type AppEnv = "production" | "preview" | "development";
export type CourseFormat = "online" | "in_person" | "hybrid";
export type CourseStatus = "draft" | "published" | "archived";
export type DomainStatus = "none" | "pending" | "active";
/** Derived from the Razorpay key prefix (rzp_test_ / rzp_live_). Stored on every order and enrollment. */
export type PaymentMode = "test" | "live";
export type VideoProvider = "r2" | "youtube" | "stream" | "none";
export type BatchStatus = "open" | "closed" | "cancelled";
export type OrderStatus = "created" | "paid" | "failed" | "partially_refunded" | "refunded";
export type PaymentKind = "full" | "deposit";
export type EnrollmentSource = "payment" | "manual" | "coupon_free";
export type RefundStatus = "pending" | "processed" | "failed";
export type MediaKind = "video" | "image" | "captions" | "file";
export type MediaStatus = "uploading" | "ready" | "aborted" | "deleted";
export type LoginTokenPurpose = "handoff" | "admin_link";
/** Counters in daily_stats that bump() can increment. */
export type StatField = "views" | "checkouts_started" | "paid_orders" | "revenue_paise" | "refunds_paise";

// ---------------------------------------------------------------- course content (courses.details JSON)

export interface CourseFaq {
  q: string;
  a: string;
}

export interface CourseGlimpse {
  /** YouTube video id (11 characters). */
  youtubeId: string;
  label: string;
}

/** The `courses.details` JSON column. Validated by the admin API (W5) before it is stored. */
export interface CourseDetails {
  outcomes: string[];
  forWho: string[];
  faqs: CourseFaq[];
  glimpses: CourseGlimpse[];
  highlights: string[];
}

// ---------------------------------------------------------------- public snapshot (build time)

/** A lesson as the public site may show it: never a video reference. */
export interface PublicLesson {
  id: number;
  slug: string;
  title: string;
  minutes: number;
  freePreview: boolean;
  vertical: boolean;
  hasVideo: boolean;
}

export interface PublicModule {
  id: number;
  position: number;
  title: string;
  lessons: PublicLesson[];
}

export interface PublicBatch {
  id: number;
  title: string;
  startsOn: IsoDate;
  endsOn: IsoDate | null;
  scheduleText: string | null;
  /** null: the course price applies. */
  pricePaise: Paise | null;
  /** null: no seat limit. */
  seatsLeft: number | null;
}

/** A published course, as the build renders its landing page. */
export interface PublicCourse {
  id: number;
  /** Also the subdomain label (<slug>.feelingsbeautycare.in) and the /c/<slug>/ path. */
  slug: string;
  title: string;
  subtitle: string | null;
  /** Plain text with line breaks. Never HTML or Markdown. */
  description: string | null;
  teacher: string;
  format: CourseFormat;
  /** Published courses always have a price (0 = free). */
  pricePaise: Paise;
  compareAtPaise: Paise | null;
  depositPaise: Paise | null;
  level: string | null;
  language: string | null;
  durationText: string | null;
  accessDays: number | null;
  certificateTitle: string | null;
  details: CourseDetails;
  /** Absolute or root-relative URL (/media/i/<key>), or null. */
  coverUrl: string | null;
  ogImageUrl: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  /** Example content: ribbon, noindex, and live payments refused. */
  isDemo: boolean;
  domainActive: boolean;
  /** https://<slug>.feelingsbeautycare.in/ once the domain is active, else the hub's /c/<slug>/. */
  canonicalUrl: string;
  modules: PublicModule[];
  /** Open batches only, soonest first. Empty for online courses. */
  batches: PublicBatch[];
}

export interface PublicBusiness {
  /** Trading name, "Feelings Beauty Care". */
  name: string;
  legalName: string;
  /** One line, as printed on receipts. */
  address: string;
  /** GST state code, two digits ("24" = Gujarat). */
  stateCode: string;
  gstin: string | null;
  /** E.164, "+918000661578". */
  phone: string;
  /** wa.me number, digits only, "918000661578". */
  whatsapp: string;
}

export interface PublicSettings {
  business: PublicBusiness;
  /** The owner confirmed the legal pages (go-live gate). */
  legalConfirmed: boolean;
  /** The site runs on Razorpay test keys: show the test-mode ribbon. */
  testMode: boolean;
}

/** GET /api/public/snapshot, and src/generated/snapshot.json at build time. */
export interface Snapshot {
  contentVersion: number;
  generatedAt: Unix;
  courses: PublicCourse[];
  settings: PublicSettings;
}

/** dist/build.json, polled by the admin after a publish. */
export interface BuildInfo {
  contentVersion: number;
  /** Unix seconds. */
  builtAt: Unix;
  /** Git commit (CF_PAGES_COMMIT_SHA), or null for local builds. */
  commit: string | null;
  /** Where the content came from: the live D1 snapshot, or the seed built from src/data/course.ts. */
  snapshotSource: "live" | "seed" | "url";
}

/** dist/domains.json: course slugs whose subdomain is active (read by the hub's /c/<slug>/ redirect). */
export interface DomainsManifest {
  active: string[];
}

// ---------------------------------------------------------------- settings (D1 `settings`, JSON values)

/** settings.business. Business facts printed on receipts and invoices. */
export interface BusinessSettings extends PublicBusiness {
  /** SAC code for the service. 999293 (commercial training and coaching): confirm with the accountant. */
  sac: string;
  /** GST rate in basis points (1800 = 18%). */
  gstRateBp: number;
  /** true: prices already include GST. */
  pricesIncludeTax: boolean;
}

/** Every key of the `settings` table and the type of its JSON value. */
export interface SettingsMap {
  business: BusinessSettings;
  legal_confirmed: boolean;
  /** Overrides env.ADMIN_PASSWORD_HASH once the admin changes the password. */
  admin_password_hash: string;
  /** Bumped on every content change (publish, unpublish, edit of a published course). */
  content_version: number;
  /** content_version of the last build that was requested. */
  published_version: number;
  last_rebuild_at: Unix;
  last_backup_at: Unix;
  last_cleanup_at: Unix;
}
export type SettingKey = keyof SettingsMap;

// ---------------------------------------------------------------- students, sessions, enrollments

export interface Student {
  id: number;
  name: string | null;
  /** E.164. null only after an erase, or when the student signed up with email. */
  phone: string | null;
  email: string | null;
  stateCode: string | null;
  createdAt: Unix;
}

/** One signed-in device, for /account "Devices". */
export interface StudentSession {
  id: number;
  createdAt: Unix;
  lastSeenAt: Unix;
  expiresAt: Unix;
  userAgent: string | null;
  /** The session making this request. */
  current: boolean;
}

export interface EnrollmentBatch {
  id: number;
  title: string;
  startsOn: IsoDate;
  endsOn: IsoDate | null;
  scheduleText: string | null;
}

export interface EnrollmentSummary {
  id: number;
  courseId: number;
  courseSlug: string;
  courseTitle: string;
  format: CourseFormat;
  batch: EnrollmentBatch | null;
  source: EnrollmentSource;
  mode: PaymentMode;
  startsAt: Unix;
  expiresAt: Unix | null;
  revokedAt: Unix | null;
  completedAt: Unix | null;
  /** Not revoked, not expired, and (in live mode) not a test-mode payment. */
  active: boolean;
  completedLessons: number;
  totalLessons: number;
}

// ---------------------------------------------------------------- learning

export interface LessonProgress {
  lessonId: number;
  positionSeconds: number;
  completedAt: Unix | null;
}

export interface LearnLesson extends PublicLesson {
  durationSeconds: number | null;
  /** Plain text notes under the video. */
  notes: string | null;
  progress: LessonProgress | null;
}

export interface LearnModule {
  id: number;
  position: number;
  title: string;
  lessons: LearnLesson[];
}

export interface Certificate {
  /** 10 Crockford base32 characters. */
  code: string;
  courseId: number;
  courseTitle: string;
  nameOnCertificate: string;
  /** Wording from courses.certificate_title at issue time. */
  title: string;
  issuedAt: Unix;
  revokedAt: Unix | null;
  /** https://courses.feelingsbeautycare.in/verify/<code> */
  verifyUrl: string;
}

/** GET /api/certificates/:code. Only what the public may see. */
export interface CertificateCheck {
  valid: boolean;
  name: string | null;
  course: string | null;
  /** "YYYY-MM-DD", or null when not found. */
  issuedOn: IsoDate | null;
  revoked: boolean;
}

/** Shown over the video, aria-hidden. */
export interface Watermark {
  name: string;
  /** "+91 ••••• •1578" style. */
  phoneMasked: string | null;
}

/** A signed media URL and when it stops working. */
export interface SignedMedia {
  /** Root-relative: /media/v/<lessonId>?e=&s=&sig= */
  src: string;
  captions: string | null;
  expiresAt: Unix;
}

export interface PlayInfo extends SignedMedia {
  /** Seconds to resume from. */
  resumeAt: number;
  watermark: Watermark;
}

// ---------------------------------------------------------------- pricing and orders

export type QuoteFailure =
  | "course_not_found"
  | "course_not_for_sale"
  | "batch_not_found"
  | "batch_full"
  | "coupon_not_found"
  | "coupon_inactive"
  | "coupon_not_started"
  | "coupon_expired"
  | "coupon_used_up"
  | "coupon_wrong_course"
  | "coupon_already_used";

/** The server's price for one order (functions/_lib/pricing.ts quote()). */
export type Quote =
  | {
      ok: true;
      courseId: number;
      batchId: number | null;
      couponId: number | null;
      paymentKind: PaymentKind;
      listPaise: Paise;
      discountPaise: Paise;
      /** What Razorpay charges. At least 100 unless `free`. */
      amountPaise: Paise;
      /** A 100% coupon with allow_free: no payment, enroll directly. */
      free: boolean;
      /** "20% off", "₹500 off". null without a coupon. */
      label: string | null;
    }
  | { ok: false; reason: QuoteFailure };

/** Razorpay's payment entity, the fields this app reads (GET /v1/payments/:id, webhooks). */
export interface RazorpayPayment {
  id: string;
  entity?: "payment";
  amount: Paise;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  order_id: string | null;
  method?: string | null;
  email?: string | null;
  contact?: string | null;
  notes?: Record<string, string> | unknown[];
  error_description?: string | null;
  created_at?: Unix;
}

export interface RazorpayRefund {
  id: string;
  entity?: "refund";
  payment_id: string;
  amount: Paise;
  currency?: string;
  status: "pending" | "processed" | "failed";
  notes?: Record<string, string> | unknown[];
  created_at?: Unix;
}

export interface OrderSummary {
  id: number;
  courseId: number;
  courseSlug: string;
  courseTitle: string;
  status: OrderStatus;
  mode: PaymentMode;
  paymentKind: PaymentKind;
  amountPaise: Paise;
  refundedPaise: Paise;
  razorpayPaymentId: string | null;
  invoiceNo: string | null;
  createdAt: Unix;
  paidAt: Unix | null;
}

export interface Refund {
  id: number;
  orderId: number;
  razorpayRefundId: string | null;
  amountPaise: Paise;
  status: RefundStatus;
  reason: string | null;
  revokeAccess: boolean;
  createdAt: Unix;
  updatedAt: Unix;
}

export interface ReceiptLine {
  label: string;
  amountPaise: Paise;
}

/** GET /api/me/orders/:id. "Payment receipt" without a GSTIN, "Tax invoice" with one. */
export interface Receipt {
  kind: "receipt" | "tax_invoice";
  order: OrderSummary;
  business: BusinessSettings;
  buyer: { name: string | null; phone: string | null; email: string | null; stateCode: string | null };
  method: string | null;
  couponCode: string | null;
  listPaise: Paise;
  discountPaise: Paise;
  /** Only for a tax invoice; otherwise null and the tax fields are 0. */
  taxablePaise: Paise | null;
  cgstPaise: Paise;
  sgstPaise: Paise;
  igstPaise: Paise;
  /** "Gujarat (24)". Only for a tax invoice. */
  placeOfSupply: string | null;
  lines: ReceiptLine[];
  refunds: Refund[];
}

// ---------------------------------------------------------------- admin

export interface AdminLesson {
  id: number;
  moduleId: number;
  position: number;
  slug: string;
  title: string;
  minutes: number;
  videoProvider: VideoProvider;
  /** R2 key, YouTube id or Stream id. Admin only, never in the snapshot. */
  videoRef: string | null;
  vertical: boolean;
  captionsKey: string | null;
  durationSeconds: number | null;
  notes: string | null;
  freePreview: boolean;
}

export interface AdminModule {
  id: number;
  position: number;
  title: string;
  lessons: AdminLesson[];
}

export interface AdminBatch {
  id: number;
  courseId: number;
  title: string;
  startsOn: IsoDate;
  endsOn: IsoDate | null;
  scheduleText: string | null;
  pricePaise: Paise | null;
  seats: number | null;
  seatsTaken: number;
  status: BatchStatus;
  createdAt: Unix;
  updatedAt: Unix;
}

/** Every column of a course, drafts included. */
export interface AdminCourse {
  id: number;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  teacher: string;
  format: CourseFormat;
  /** null while a draft has no price yet. */
  pricePaise: Paise | null;
  compareAtPaise: Paise | null;
  depositPaise: Paise | null;
  level: string | null;
  language: string | null;
  durationText: string | null;
  accessDays: number | null;
  certificateTitle: string | null;
  details: CourseDetails;
  coverKey: string | null;
  ogImageKey: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  isDemo: boolean;
  status: CourseStatus;
  domainStatus: DomainStatus;
  /** The slug can no longer change (its domain is active). */
  slugLocked: boolean;
  sortOrder: number;
  publishedAt: Unix | null;
  createdAt: Unix;
  updatedAt: Unix;
  deletedAt: Unix | null;
  modules: AdminModule[];
  batches: AdminBatch[];
  /** Counts for the course list. */
  lessonCount: number;
  enrollmentCount: number;
}

/** The editable fields of a course (POST / PUT /api/admin/courses). Outline and batches have their own endpoints. */
export type AdminCourseInput = Pick<
  AdminCourse,
  | "slug"
  | "title"
  | "subtitle"
  | "description"
  | "teacher"
  | "format"
  | "pricePaise"
  | "compareAtPaise"
  | "depositPaise"
  | "level"
  | "language"
  | "durationText"
  | "accessDays"
  | "certificateTitle"
  | "details"
  | "coverKey"
  | "ogImageKey"
  | "seoTitle"
  | "seoDescription"
  | "isDemo"
  | "sortOrder"
>;

export interface AdminCoupon {
  id: number;
  code: string;
  percentOff: number | null;
  amountOffPaise: Paise | null;
  /** null: any course. */
  courseId: number | null;
  maxUses: number | null;
  usedCount: number;
  startsAt: Unix | null;
  expiresAt: Unix | null;
  active: boolean;
  allowFree: boolean;
  createdAt: Unix;
  updatedAt: Unix;
}

export type AdminCouponInput = Pick<
  AdminCoupon,
  "code" | "percentOff" | "amountOffPaise" | "courseId" | "maxUses" | "startsAt" | "expiresAt" | "active" | "allowFree"
>;

/** A row of the students list. Phone masked unless the detail view is open. */
export interface AdminStudentRow {
  id: number;
  name: string | null;
  phoneMasked: string | null;
  email: string | null;
  enrollments: number;
  paidPaise: Paise;
  lastSeenAt: Unix | null;
  createdAt: Unix;
  erased: boolean;
}

export interface AdminStudent extends Student {
  erasedAt: Unix | null;
  enrollments: EnrollmentSummary[];
  orders: OrderSummary[];
  sessions: StudentSession[];
  certificates: Certificate[];
}

export interface AdminOrder extends OrderSummary {
  studentId: number;
  studentName: string | null;
  studentPhoneMasked: string | null;
  batchId: number | null;
  listPricePaise: Paise;
  discountPaise: Paise;
  couponId: number | null;
  couponCode: string | null;
  razorpayOrderId: string | null;
  method: string | null;
  failureReason: string | null;
  refunds: Refund[];
}

export interface WebhookEventRow {
  eventId: string;
  type: string;
  mode: PaymentMode;
  receivedAt: Unix;
  processedAt: Unix | null;
  error: string | null;
}

export interface MediaItem {
  id: number;
  key: string;
  kind: MediaKind;
  contentType: string;
  sizeBytes: number;
  originalName: string | null;
  status: MediaStatus;
  lessonId: number | null;
  /** Public URL for images (/media/i/<key>); null for videos and captions. */
  publicUrl: string | null;
  createdAt: Unix;
}

/** POST /api/admin/uploads. */
export interface UploadInit {
  /** media.id */
  id: number;
  uploadId: string;
  key: string;
  /** Bytes per part (10 MiB). */
  partSize: number;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface AdminSettings {
  business: BusinessSettings;
  legalConfirmed: boolean;
  /** From the Razorpay key prefix; read-only in the admin. */
  paymentMode: PaymentMode | "not_configured";
  appEnv: AppEnv;
  lastBackupAt: Unix | null;
  lastRebuildAt: Unix | null;
  contentVersion: number;
  publishedVersion: number;
  /** The admin password was changed in the admin (settings overrides the secret). */
  passwordChanged: boolean;
}

export interface DailyStat {
  day: IsoDate;
  courseId: number;
  views: number;
  checkoutsStarted: number;
  paidOrders: number;
  revenuePaise: Paise;
  refundsPaise: Paise;
}

export interface Stats {
  from: IsoDate;
  to: IsoDate;
  courseId: number | null;
  series: DailyStat[];
  totals: Omit<DailyStat, "day" | "courseId">;
}

export interface PublishStatus {
  contentVersion: number;
  publishedVersion: number;
  /** contentVersion of the live build.json, or null when it can't be read. */
  liveVersion: number | null;
  lastRebuildAt: Unix | null;
  /** When the next deploy-hook call is allowed (debounced 120 s). */
  nextAllowedAt: Unix | null;
  state: "up_to_date" | "queued" | "building" | "unknown";
}

export interface AuditRecord {
  id: number;
  actor: string;
  action: string;
  entity: string;
  entityId: string | null;
  data: unknown;
  createdAt: Unix;
}

// ---------------------------------------------------------------- component props shared across workstreams

/** Props of W2's <Checkout> component, mounted by W1's course landing page. */
export interface CheckoutProps {
  course: PublicCourse;
  settings: PublicSettings;
}
