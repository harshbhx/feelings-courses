/**
 * HTTP contracts: one request and one response type per endpoint of the plan's API list (section 4).
 *
 * Conventions every endpoint keeps:
 * - JSON in and out, `Cache-Control: no-store`.
 * - Errors are `ApiErrorBody` with an HTTP status >= 400.
 * - POST, PUT and DELETE check `Origin` (functions/_lib/http.ts sameOrigin) and require a JSON
 *   content type, except Razorpay's form callback to /api/verify and the webhook.
 * - Bodies are capped at 16 KB (http.ts readJson), except upload parts.
 *
 * `Endpoints` maps "METHOD /path" (path parameters written `:name`) to its types, so the browser's
 * api-client and the tests can be typed from one place. Types only: no runtime code here.
 */
import type {
  AdminBatch,
  AdminCoupon,
  AdminCouponInput,
  AdminCourse,
  AdminCourseInput,
  AdminOrder,
  AdminSettings,
  AdminStudent,
  AdminStudentRow,
  AuditRecord,
  BusinessSettings,
  Certificate,
  CertificateCheck,
  CourseFormat,
  EnrollmentBatch,
  EnrollmentSummary,
  IsoDate,
  LearnModule,
  MediaItem,
  MediaKind,
  OrderStatus,
  OrderSummary,
  Paise,
  PaymentMode,
  PlayInfo,
  PublishStatus,
  QuoteFailure,
  Receipt,
  Refund,
  SignedMedia,
  Snapshot,
  Stats,
  Student,
  StudentSession,
  Unix,
  UploadInit,
  UploadedPart,
  WebhookEventRow,
} from "./types.ts";

// ---------------------------------------------------------------- errors

/** Error codes the API answers with. Workstreams may add codes here through a contract PR. */
export type ApiErrorCode =
  // generic
  | "bad_request"
  | "invalid_json"
  | "invalid_details"
  | "too_large"
  | "cross_origin"
  | "unsupported_media_type"
  | "method_not_allowed"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "unauthorized"
  | "forbidden"
  | "not_implemented"
  | "server_error"
  | "platform_not_configured"
  // payments (W2)
  | "payments_not_configured"
  | "payments_misconfigured"
  | "live_keys_on_demo"
  | "test_keys_on_live"
  | "legal_not_confirmed"
  | "course_not_for_sale"
  | "batch_full"
  | "invalid_coupon"
  | "invalid_payment"
  | "signature_invalid"
  | "payment_not_confirmed"
  | "order_mismatch"
  | "razorpay_unavailable"
  | "already_enrolled"
  | "not_refundable"
  | "refund_window_closed"
  | "mode_mismatch"
  | "razorpay_refused"
  // students (W3)
  | "not_signed_in"
  | "not_enrolled"
  | "token_invalid"
  | "course_incomplete"
  | "no_certificate"
  // admin (W5)
  | "admin_locked"
  | "wrong_password"
  | "slug_locked"
  | "slug_taken"
  | "coupon_used"
  | "code_taken"
  | "student_exists"
  | "already_enrolled"
  | "in_use"
  // media (W4)
  | "upload_invalid"
  | "upload_too_large";

export interface ApiErrorBody {
  error: ApiErrorCode | (string & {});
  message: string;
  /** Per-field messages for form errors (400 invalid_details). */
  fields?: Record<string, string>;
  /** Seconds until a rate limit resets (429). */
  retryAfter?: number;
}

export type Ok = { ok: true };

// ---------------------------------------------------------------- public and checkout

export type SnapshotResponse = Snapshot;

export type PreviewResponse = SignedMedia;

export interface CouponQuoteRequest {
  /** Course slug. */
  course: string;
  code: string;
  batchId?: number;
}
export type CouponQuoteResponse =
  | { ok: true; listPaise: Paise; discountPaise: Paise; amountPaise: Paise; label: string | null; free: boolean }
  | { ok: false; reason: QuoteFailure };

export interface OrderRequest {
  /** Course slug. */
  course: string;
  batchId?: number;
  coupon?: string;
  name: string;
  /**
   * The account (owner decision, 23 Oct 2026): the student is found by it, and the receipt and
   * every sign-in link go to it. Typing it proves nothing (functions/_lib/claim.ts).
   */
  email: string;
  /** Optional contact number (Razorpay's prefill, WhatsApp help). Never finds or opens an account. */
  phone?: string;
  /** Optional state code. Not asked by checkout: no tax is shown (owner decision, plan 10.5). */
  state?: string;
  /** The terms and privacy checkbox. Must be true. */
  consent: true;
}
export interface RazorpayPrefill {
  name?: string;
  contact?: string;
  email?: string;
}
export type OrderResponse =
  | {
      mode: "razorpay";
      keyId: string;
      orderId: string;
      amount: Paise;
      currency: "INR";
      name: string;
      description: string;
      prefill: RazorpayPrefill;
      /** Razorpay test keys: show "Test mode: no real money is charged". */
      testMode: boolean;
      /** Our order id (orders.id). */
      ref: number;
    }
  | { mode: "free"; redirect: string };

/** JSON body. Razorpay's callback_url flow posts the same fields as a form and gets a 303. */
export interface VerifyRequest {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}
/**
 * `redirect` is https://<HUB>/auth/continue?t=… (W3's handoff, which lands on the receipt) when
 * the payment may sign this device in (claim.ts: a new account whose email was never proven);
 * otherwise the receipt itself. `receipt` is the on-screen receipt, https://<HUB>/receipt/<orderId>?k=….
 * The receipt and a sign-in link are also emailed to the account's address.
 */
export type VerifyResponse = { ok: true; redirect: string; receipt?: string };

export interface TrackRequest {
  /** courses.id, 0 for hub pages. */
  c: number;
  e: "view";
}

export type CertificateCheckResponse = CertificateCheck;

// ---------------------------------------------------------------- students

/** POST /api/auth/email-link: a one-time sign-in link by email (15 minutes). */
export interface EmailLinkRequest {
  email: string;
  /** Where to land after sign-in: a same-site path (default /account). */
  next?: string;
}
/** 202 for every well-formed address, whether or not it has an account (no enumeration). */
export type EmailLinkResponse = { ok: true };

export interface SignoutRequest {
  all?: boolean;
}

export interface MeResponse {
  student: Student;
  enrollments: EnrollmentSummary[];
}
/** The student changes their name only; the email (their sign-in) and phone change through the admin. */
export interface MeUpdateRequest {
  name?: string;
}
export type MeUpdateResponse = Student;
export type MySessionsResponse = StudentSession[];
export type MyOrdersResponse = OrderSummary[];
export type MyReceiptResponse = Receipt;

export interface LearnCourseResponse {
  course: {
    id: number;
    slug: string;
    title: string;
    format: CourseFormat;
    certificateTitle: string | null;
    accessDays: number | null;
  };
  enrollment: EnrollmentSummary;
  batch: EnrollmentBatch | null;
  modules: LearnModule[];
  certificate: Certificate | null;
  /** Every lesson has completed_at. */
  complete: boolean;
}

export type PlayResponse = PlayInfo;

export interface ProgressRequest {
  lessonId: number;
  positionSeconds: number;
  completed?: boolean;
}
export interface ProgressResponse {
  lessonId: number;
  completedAt: Unix | null;
  courseComplete: boolean;
}

export interface CertificateRequest {
  nameOnCertificate: string;
}
export type CertificateResponse = Certificate;

// ---------------------------------------------------------------- admin

export interface AdminLoginRequest {
  password: string;
}
export interface AdminPasswordRequest {
  current: string;
  /** 14 characters or more. */
  next: string;
}
export interface AdminMeResponse {
  ok: true;
  expiresAt: Unix;
  appEnv: AdminSettings["appEnv"];
  paymentMode: AdminSettings["paymentMode"];
  /** The hub's host and the course hosts' domain, as the router sees them (config(env), W8). */
  hubHost: string;
  apexDomain: string;
}

export type AdminCoursesResponse = AdminCourse[];
export type AdminCourseRequest = AdminCourseInput;
export type AdminCourseResponse = AdminCourse;

/** PUT /api/admin/courses/:id/outline. Existing rows keep their ids (omit `id` for new ones). */
export interface AdminOutlineRequest {
  modules: {
    id?: number;
    title: string;
    lessons: {
      id?: number;
      slug: string;
      title: string;
      minutes: number;
      videoProvider: AdminCourse["modules"][number]["lessons"][number]["videoProvider"];
      videoRef: string | null;
      vertical: boolean;
      captionsKey: string | null;
      durationSeconds: number | null;
      notes: string | null;
      freePreview: boolean;
    }[];
  }[];
}

/**
 * What a deploy-hook request did. `reason` (W5) says why nothing was queued: "debounced" (a build
 * was requested under 120 s ago: try again at nextAllowedAt), "no_hook" (DEPLOY_HOOK_URL isn't
 * set, as on preview) or "hook_failed" (Cloudflare didn't accept the call: retry now).
 */
export interface AdminRebuild {
  queued: boolean;
  nextAllowedAt: Unix;
  reason?: "debounced" | "no_hook" | "hook_failed";
}

export interface AdminPublishResponse {
  course: AdminCourse;
  rebuild: AdminRebuild;
}

/** POST /api/admin/publish: the publish status after asking for a rebuild of the whole site. */
export type AdminSitePublishResponse = PublishStatus & { rebuild: AdminRebuild };

/** POST /api/admin/students/:id/erase. Erasing can't be undone, so the body must confirm it. */
export interface AdminEraseRequest {
  confirm: true;
}

export interface AdminDomainCheckResponse {
  host: string;
  status: AdminCourse["domainStatus"];
  /** What the probe saw: HTTP status, or "timeout" / "unreachable". */
  probe: number | "timeout" | "unreachable";
}

export type AdminBatchRequest = Pick<
  AdminBatch,
  "title" | "startsOn" | "endsOn" | "scheduleText" | "pricePaise" | "seats" | "status"
>;
export type AdminBatchResponse = AdminBatch;

export interface AdminStudentsQuery {
  q?: string;
  course?: number;
  page?: number;
}
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
export type AdminStudentsResponse = Page<AdminStudentRow>;
export type AdminStudentResponse = AdminStudent;

export interface AdminAddStudentRequest {
  name: string;
  /** How the student signs in. */
  email: string;
  phone?: string;
  /** Enroll right away (source 'manual'). */
  courseId?: number;
  batchId?: number;
  expiresAt?: Unix | null;
}

export interface AdminGrantRequest {
  courseId: number;
  batchId?: number;
  /** null: no expiry; omitted: the course's access_days. */
  expiresAt?: Unix | null;
}

/** PUT /api/admin/students/:id: correct the contact details. A new email ends unused sign-in links. */
export interface AdminUpdateStudentRequest {
  name?: string;
  email?: string;
  /** null or "" removes it. */
  phone?: string | null;
}

export interface AdminAccessLinkResponse {
  /** https://<HUB>/auth/continue?t=… (24 h, single use) */
  url: string;
  /** https://wa.me/<phone>?text=… (no number when the student has none: WhatsApp asks whom to send it to) */
  whatsappUrl: string;
  expiresAt: Unix;
  /** The link was emailed to the student. */
  emailed: boolean;
  /** Where it went (null: no email on file). */
  email: string | null;
}

export interface AdminIssueCertificateRequest {
  courseId: number;
  name: string;
}

export interface AdminOrdersQuery {
  status?: OrderStatus;
  course?: number;
  from?: IsoDate;
  to?: IsoDate;
  page?: number;
}
export type AdminOrdersResponse = Page<AdminOrder>;
export type AdminOrderResponse = AdminOrder;

export interface AdminRefundRequest {
  /** Omitted: the remaining amount (a full refund). */
  amountPaise?: Paise;
  reason: string;
  revoke: boolean;
}
export type AdminRefundResponse = Refund;

export type AdminWebhooksResponse = WebhookEventRow[];

export type AdminCouponsResponse = AdminCoupon[];
export type AdminCouponRequest = AdminCouponInput;
export type AdminCouponResponse = AdminCoupon;

export interface AdminUploadRequest {
  kind: MediaKind;
  lessonId?: number;
  filename: string;
  size: number;
  contentType: string;
}
export type AdminUploadResponse = UploadInit;
export type AdminUploadPartResponse = { etag: string };
export interface AdminUploadCompleteRequest {
  parts: UploadedPart[];
}
export type AdminUploadCompleteResponse = MediaItem;
export type AdminMediaResponse = MediaItem[];

export type AdminSettingsResponse = AdminSettings;
export interface AdminSettingsRequest {
  business?: BusinessSettings;
  legalConfirmed?: boolean;
}

export interface AdminStatsQuery {
  from?: IsoDate;
  to?: IsoDate;
  course?: number;
}
export type AdminStatsResponse = Stats;

export type AdminPublishStatusResponse = PublishStatus;

export interface AdminBackupRunResponse {
  ok: true;
  key: string;
  at: Unix;
}

export interface AdminAuditQuery {
  entity?: string;
  /** Needs `entity`. */
  entityId?: string;
  /** Cursor: entries with a smaller id (stable while new entries arrive). Overrides `page`. */
  before?: number;
  page?: number;
}
export type AdminAuditResponse = AuditRecord[];

export interface AdminDevSeedResponse {
  ok: true;
  students: number;
  orders: number;
  coupons: number;
}

// ---------------------------------------------------------------- the endpoint map

interface E<Req, Res> {
  req: Req;
  res: Res;
}
type None = undefined;

/**
 * Every endpoint, "METHOD /path". `req` is the JSON body (or the query object for GETs that take
 * one); `res` is the 2xx JSON body (`None` for 204 / redirects).
 */
export interface Endpoints {
  // public and checkout
  "GET /api/public/snapshot": E<None, SnapshotResponse>;
  "GET /api/public/preview/:lessonId": E<None, PreviewResponse>;
  "POST /api/coupon/quote": E<CouponQuoteRequest, CouponQuoteResponse>;
  "POST /api/order": E<OrderRequest, OrderResponse>;
  "POST /api/verify": E<VerifyRequest, VerifyResponse>;
  "POST /api/razorpay/webhook": E<unknown, Ok>;
  "POST /api/t": E<TrackRequest, None>;
  "GET /api/certificates/:code": E<None, CertificateCheckResponse>;
  /** The on-screen receipt page (HTML). `k` is the HMAC key from the verify response's link. */
  "GET /receipt/:id": E<{ k: string }, string>;
  // students
  "POST /api/auth/email-link": E<EmailLinkRequest, EmailLinkResponse>;
  "GET /auth/continue": E<{ t: string }, None>;
  "POST /api/auth/signout": E<SignoutRequest, None>;
  "GET /api/me": E<None, MeResponse>;
  "PUT /api/me": E<MeUpdateRequest, MeUpdateResponse>;
  "GET /api/me/sessions": E<None, MySessionsResponse>;
  "DELETE /api/me/sessions/:id": E<None, None>;
  "GET /api/me/orders": E<None, MyOrdersResponse>;
  "GET /api/me/orders/:id": E<None, MyReceiptResponse>;
  "GET /api/learn/:slug": E<None, LearnCourseResponse>;
  "GET /api/learn/:slug/lessons/:lessonId/play": E<None, PlayResponse>;
  "PUT /api/learn/progress": E<ProgressRequest, ProgressResponse>;
  "POST /api/learn/:slug/certificate": E<CertificateRequest, CertificateResponse>;
  // admin: session
  "POST /api/admin/login": E<AdminLoginRequest, Ok>;
  "POST /api/admin/logout": E<None, None>;
  "POST /api/admin/password": E<AdminPasswordRequest, Ok>;
  "GET /api/admin/me": E<None, AdminMeResponse>;
  // admin: courses
  "GET /api/admin/courses": E<None, AdminCoursesResponse>;
  "POST /api/admin/courses": E<AdminCourseRequest, AdminCourseResponse>;
  "GET /api/admin/courses/:id": E<None, AdminCourseResponse>;
  "PUT /api/admin/courses/:id": E<AdminCourseRequest, AdminCourseResponse>;
  "DELETE /api/admin/courses/:id": E<None, None>;
  "PUT /api/admin/courses/:id/outline": E<AdminOutlineRequest, AdminCourseResponse>;
  "POST /api/admin/courses/:id/publish": E<None, AdminPublishResponse>;
  "POST /api/admin/courses/:id/unpublish": E<None, AdminPublishResponse>;
  "POST /api/admin/courses/:id/archive": E<None, AdminPublishResponse>;
  "POST /api/admin/courses/:id/domain/check": E<None, AdminDomainCheckResponse>;
  "GET /api/admin/courses/:id/batches": E<None, AdminBatch[]>;
  "POST /api/admin/courses/:id/batches": E<AdminBatchRequest, AdminBatchResponse>;
  "PUT /api/admin/batches/:id": E<AdminBatchRequest, AdminBatchResponse>;
  "DELETE /api/admin/batches/:id": E<None, None>;
  // admin: students
  "GET /api/admin/students": E<AdminStudentsQuery, AdminStudentsResponse>;
  "GET /api/admin/students/:id": E<None, AdminStudentResponse>;
  "PUT /api/admin/students/:id": E<AdminUpdateStudentRequest, AdminStudentResponse>;
  "POST /api/admin/students": E<AdminAddStudentRequest, AdminStudentResponse>;
  "POST /api/admin/students/:id/enrollments": E<AdminGrantRequest, EnrollmentSummary>;
  "DELETE /api/admin/enrollments/:id": E<None, None>;
  "POST /api/admin/students/:id/access-link": E<None, AdminAccessLinkResponse>;
  "POST /api/admin/students/:id/signout-all": E<None, None>;
  "POST /api/admin/students/:id/erase": E<AdminEraseRequest, AdminStudentResponse>;
  "POST /api/admin/students/:id/certificate": E<AdminIssueCertificateRequest, Certificate>;
  "GET /api/admin/students.csv": E<AdminStudentsQuery, string>;
  // admin: payments
  "GET /api/admin/orders": E<AdminOrdersQuery, AdminOrdersResponse>;
  "GET /api/admin/orders/:id": E<None, AdminOrderResponse>;
  /** The payments export (W5): same filters as the list, no paging. */
  "GET /api/admin/orders.csv": E<Omit<AdminOrdersQuery, "page">, string>;
  "POST /api/admin/orders/:id/refund": E<AdminRefundRequest, AdminRefundResponse>;
  "POST /api/admin/orders/:id/sync": E<None, AdminOrderResponse>;
  "GET /api/admin/webhooks": E<{ pending?: 1 }, AdminWebhooksResponse>;
  "POST /api/admin/webhooks/:id/replay": E<None, Ok>;
  // admin: coupons
  "GET /api/admin/coupons": E<None, AdminCouponsResponse>;
  "POST /api/admin/coupons": E<AdminCouponRequest, AdminCouponResponse>;
  "PUT /api/admin/coupons/:id": E<AdminCouponRequest, AdminCouponResponse>;
  "DELETE /api/admin/coupons/:id": E<None, None>;
  // admin: media (W4)
  "POST /api/admin/uploads": E<AdminUploadRequest, AdminUploadResponse>;
  "PUT /api/admin/uploads/:id/parts/:n": E<ArrayBuffer, AdminUploadPartResponse>;
  "POST /api/admin/uploads/:id/complete": E<AdminUploadCompleteRequest, AdminUploadCompleteResponse>;
  "DELETE /api/admin/uploads/:id": E<None, None>;
  "GET /api/admin/media": E<None, AdminMediaResponse>;
  // admin: settings, stats, publish, backup, audit
  "GET /api/admin/settings": E<None, AdminSettingsResponse>;
  "PUT /api/admin/settings": E<AdminSettingsRequest, AdminSettingsResponse>;
  "GET /api/admin/stats": E<AdminStatsQuery, AdminStatsResponse>;
  "POST /api/admin/publish": E<None, AdminSitePublishResponse>;
  "GET /api/admin/publish/status": E<None, AdminPublishStatusResponse>;
  "GET /api/admin/backup": E<None, Blob>;
  "POST /api/admin/backup/run": E<None, AdminBackupRunResponse>;
  "GET /api/admin/audit": E<AdminAuditQuery, AdminAuditResponse>;
  "POST /api/admin/dev/seed": E<None, AdminDevSeedResponse>;
}

export type EndpointKey = keyof Endpoints;
export type RequestOf<K extends EndpointKey> = Endpoints[K]["req"];
export type ResponseOf<K extends EndpointKey> = Endpoints[K]["res"];

/** Mode helper for UIs: the shape of a payment mode badge. */
export type PaymentModeLabel = PaymentMode | "not_configured";
