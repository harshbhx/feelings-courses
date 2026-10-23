/**
 * The live payment endpoints on D1 (W2): POST /api/order, POST /api/verify, POST /api/coupon/quote
 * and POST /api/razorpay/webhook. The demo checkout (checkout.ts, course.ts prices, the fbc_enroll
 * cookie) keeps answering until the platform is set up:
 *
 * - /api/order takes this flow when D1 is bound AND the body names a course (`course`, the
 *   OrderRequest of src/shared/api.ts). The demo Checkout component sends no `course`.
 * - /api/verify takes this flow when D1 is bound AND D1 knows the Razorpay order id.
 *
 * Trust rules (plan 1.9):
 * - The price is computed on the server from D1 (pricing.ts quote()); the browser never sends one,
 *   and anything it sends besides course, batch, coupon and buyer details is ignored.
 * - A payment counts only after Razorpay's signature checks out with the key secret AND Razorpay's
 *   API confirms the payment against this order and amount. The webhook (signed with the webhook
 *   secret) does the same independently, so a buyer who closes the tab is still enrolled.
 * - fulfilOrder is idempotent: verify, the webhook, retries and replays enroll once.
 * - Live keys never sell a demo course; live keys need the legal pages confirmed.
 * - A student with an active enrollment can't start a second order for the same course.
 * - The buyer is found by EMAIL (owner decision, 23 Oct 2026); typing an address proves nothing,
 *   so a payment signs the paying device in only when claim.ts allows it, and the receipt and a
 *   sign-in link always go to the account's email (signin-links.ts).
 */
import type { CouponQuoteResponse, OrderResponse, VerifyResponse } from "../../src/shared/api.ts";
import type { PaymentMode, QuoteFailure } from "../../src/shared/types.ts";
import { MIN_CHARGE_PAISE } from "../../src/shared/constants.ts";
import { bump, statDay } from "./analytics.ts";
import { handleOrder, handleVerify, parseBuyer } from "./checkout.ts";
import { purchaseOpensAccount } from "./claim.ts";
import { ConfigError, config, razorpayMode, requireSecret } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import { maybeRunDaily } from "./daily.ts";
import { auditStatement, auditStatementWhen } from "./db/audit.ts";
import type { Db } from "./db/d1.ts";
import { DAY_SECONDS, unixNow } from "./db/d1.ts";
import { isUniqueViolation } from "./db/errors.ts";
import { getSetting } from "./db/settings.ts";
import { batch, changes, lastId } from "./db/tx.ts";
import { hasDb, type Env } from "./env.ts";
import { error, errorResponse, isJson, json, methodNotAllowed, readBody, readJson, redirect, sameOrigin } from "./http.ts";
import {
  fulfilOrderDb,
  getOrderByRazorpayId,
  getOrderRow,
  paymentKeys,
  processWebhookEventDb,
  toPayment,
  type PaymentKeys,
} from "./orders.ts";
import { normaliseCouponCode, quote } from "./pricing.ts";
import { contactSubject, ipSubject } from "./guard.ts";
import { hit } from "./ratelimit.ts";
import {
  RazorpayError,
  captureOrFetchPayment,
  createRazorpayOrder,
  fetchRazorpayPayment,
  verifyRazorpaySignature,
  verifyWebhookSignature,
} from "./razorpay.ts";
import { receiptPath } from "./receipts.ts";
import { issueLoginToken, readSession } from "./session.ts";
import { sendEnrolledEmail, sendReceiptEmail } from "./signin-links.ts";
import { NotImplementedError, type WaitUntil } from "./stub.ts";

const RZP_ORDER = /^order_[A-Za-z0-9]{1,40}$/;
const RZP_PAYMENT = /^pay_[A-Za-z0-9]{1,40}$/;
const SIGNATURE = /^[0-9a-f]{64}$/i;
const SLUG = /^[a-z0-9-]{2,40}$/;
const EVENT_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
/** Razorpay webhook bodies are a few KB; webhook_events.payload is capped at 100,000 characters. */
const MAX_WEBHOOK_BYTES = 100_000;
/** A verify call may hand out a sign-in link only this soon after the payment. */
const HANDOFF_WINDOW = 60 * 60;

type Payload = Record<string, unknown>;

// ---------------------------------------------------------------- routing between demo and live

/** POST /api/order: the D1 flow for an OrderRequest (has `course`), else the demo checkout. */
export async function routeOrder(request: Request, env: Env, ctx?: WaitUntil): Promise<Response> {
  if (request.method !== "POST" || !hasDb(env)) return handleOrder(request, env);
  const text = await readBody(request.clone());
  if (text === null) return handleOrder(request, env); // over 16 KB: answered 413 there
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* the demo handler answers bad JSON */
  }
  if (body && typeof body === "object" && !Array.isArray(body) && "course" in body) return handleLiveOrder(request, env, unixNow(), ctx);
  return handleOrder(request, env);
}

/** POST /api/verify: the D1 flow when D1 knows the Razorpay order, else the demo checkout. */
export async function routeVerify(request: Request, env: Env, ctx?: WaitUntil): Promise<Response> {
  if (request.method !== "POST" || !hasDb(env)) return handleVerify(request, env);
  const orderId = await peekRazorpayOrderId(request.clone());
  if (orderId && RZP_ORDER.test(orderId)) {
    try {
      if (await getOrderByRazorpayId(env.DB, orderId)) return handleLiveVerify(request, env, unixNow(), ctx);
    } catch (err) {
      return errorResponse(err);
    }
  }
  return handleVerify(request, env);
}

async function peekRazorpayOrderId(request: Request): Promise<string | null> {
  const text = await readBody(request, 16 * 1024);
  if (text === null) return null;
  const type = (request.headers.get("Content-Type") ?? "").toLowerCase();
  if (type.startsWith("application/x-www-form-urlencoded")) return new URLSearchParams(text).get("razorpay_order_id");
  try {
    const value = JSON.parse(text);
    return typeof value?.razorpay_order_id === "string" ? value.razorpay_order_id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- POST /api/coupon/quote

export async function handleCouponQuote(request: Request, env: Env, now = unixNow()): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!sameOrigin(request)) return error(403, "cross_origin", "This request must come from the course site.");
  if (!isJson(request)) return error(415, "unsupported_media_type", "Send JSON.");
  if (!hasDb(env)) return error(503, "platform_not_configured", "This part of the site isn't set up yet.");
  const db: Db = env.DB;
  try {
    const limited = await rateLimited(db, "coupon_quote_ip", ipSubject(request), now);
    if (limited) return limited;
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const { course, code, batchId } = body.value;
    if (typeof course !== "string" || !SLUG.test(course)) return json({ ok: false, reason: "course_not_found" } satisfies CouponQuoteResponse);
    if (!normaliseCouponCode(code)) return json({ ok: false, reason: "coupon_not_found" } satisfies CouponQuoteResponse);
    const chosenBatch = parseBatchId(batchId);
    if (chosenBatch === false) return json({ ok: false, reason: "batch_not_found" } satisfies CouponQuoteResponse);
    const q = await quote(db, { courseSlug: course, couponCode: code as string, batchId: chosenBatch ?? undefined, now });
    if (!q.ok) return json({ ok: false, reason: q.reason } satisfies CouponQuoteResponse);
    return json({
      ok: true,
      listPaise: q.listPaise,
      discountPaise: q.discountPaise,
      amountPaise: q.amountPaise,
      label: q.label,
      free: q.free,
    } satisfies CouponQuoteResponse);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------- POST /api/order

const QUOTE_ERRORS: Record<QuoteFailure, { status: number; code: string; message: string; field?: string }> = {
  course_not_found: { status: 404, code: "not_found", message: "This course isn't available." },
  course_not_for_sale: { status: 409, code: "course_not_for_sale", message: "This course isn't open for enrollment right now." },
  batch_not_found: { status: 400, code: "invalid_details", message: "Pick one of the open batches.", field: "batchId" },
  batch_full: { status: 409, code: "batch_full", message: "That batch is full. Please pick another one." },
  coupon_not_found: { status: 400, code: "invalid_coupon", message: "That coupon code doesn't exist.", field: "coupon" },
  coupon_inactive: { status: 400, code: "invalid_coupon", message: "That coupon is switched off.", field: "coupon" },
  coupon_not_started: { status: 400, code: "invalid_coupon", message: "That coupon isn't valid yet.", field: "coupon" },
  coupon_expired: { status: 400, code: "invalid_coupon", message: "That coupon has expired.", field: "coupon" },
  coupon_used_up: { status: 400, code: "invalid_coupon", message: "That coupon has been used up.", field: "coupon" },
  coupon_wrong_course: { status: 400, code: "invalid_coupon", message: "That coupon is for another course.", field: "coupon" },
  coupon_already_used: { status: 400, code: "invalid_coupon", message: "You have already used that coupon.", field: "coupon" },
};

function parseBatchId(value: unknown): number | null | false {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : false;
}

async function rateLimited(db: Db, rule: "order_ip" | "order_email" | "coupon_quote_ip", subject: string, now: number): Promise<Response | null> {
  const result = await hit(db, rule, subject, { now });
  if (result.allowed) return null;
  return error(
    429,
    "rate_limited",
    "Too many tries. Please wait a little and try again.",
    { retryAfter: result.retryAfter },
    { "Retry-After": String(result.retryAfter) },
  );
}

export async function handleLiveOrder(request: Request, env: Env, now = unixNow(), ctx?: WaitUntil): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!sameOrigin(request)) return error(403, "cross_origin", "This request must come from the course site.");
  if (!isJson(request)) return error(415, "unsupported_media_type", "Send JSON.");
  if (!hasDb(env)) return error(503, "platform_not_configured", "This part of the site isn't set up yet.");
  const db: Db = env.DB;
  try {
    const body = await readJson(request);
    if (!body.ok) return body.response;
    const input = body.value;

    // ---- input: course, batch, coupon, buyer, consent. Nothing else is read (no price, no mode).
    const fields: Record<string, string> = {};
    const course = typeof input.course === "string" ? input.course.trim().toLowerCase() : "";
    if (!SLUG.test(course)) return error(404, "not_found", "This course isn't available.");
    const batchId = parseBatchId(input.batchId);
    if (batchId === false) fields.batchId = "Pick one of the open batches.";
    let couponCode: string | undefined;
    if (input.coupon !== undefined && input.coupon !== null && String(input.coupon).trim() !== "") {
      const code = normaliseCouponCode(input.coupon);
      if (!code) fields.coupon = "That coupon code doesn't exist.";
      else couponCode = code;
    }
    const parsed = parseBuyer({ name: input.name, phone: input.phone, email: input.email });
    if (!parsed.ok) Object.assign(fields, parsed.errors);
    const buyer = parsed.ok ? parsed.buyer : {};
    if (parsed.ok && !buyer.name) fields.name = "Enter your name.";
    // The email is the account: the receipt and every sign-in link go there. The phone is optional.
    if (parsed.ok && !buyer.email) fields.email = "Enter your email. Your receipt and sign-in link go there.";
    if (input.consent !== true) fields.consent = "Please accept the terms and the privacy policy.";
    if (Object.keys(fields).length) return error(400, "invalid_details", "Please check your details.", { fields });

    const email = buyer.email!.toLowerCase();

    // ---- rate limits (per IP, and per email so one address can't be flooded with orders and mail)
    const byIp = await rateLimited(db, "order_ip", ipSubject(request), now);
    if (byIp) return byIp;
    const byEmail = await rateLimited(db, "order_email", await contactSubject(email), now);
    if (byEmail) return byEmail;

    // ---- the course as D1 has it (also gives a clean 404 before any student row is written)
    const courseRow = await db
      .prepare("SELECT id, title, is_demo FROM courses WHERE slug = ? AND deleted_at IS NULL")
      .bind(course)
      .first<{ id: number; title: string; is_demo: number }>();
    if (!courseRow) return error(404, "not_found", "This course isn't available.");

    // A cheap first pass of the quote (no student yet) so a bad coupon or a full batch doesn't
    // create a student row.
    const first = await quote(db, { courseSlug: course, batchId: batchId || undefined, couponCode, now });
    if (!first.ok) return quoteError(first.reason);

    // ---- payment keys, unless the order is free
    let keys: PaymentKeys | null = null;
    if (!first.free) {
      try {
        keys = paymentKeys(env);
      } catch (err) {
        if (err instanceof ConfigError) {
          return error(503, "payments_not_configured", "Online payments aren't set up yet. Please message us on WhatsApp to enroll.");
        }
        throw err;
      }
      if (keys.mode === "live" && courseRow.is_demo === 1) {
        return error(403, "live_keys_on_demo", "This is a demo course, so it can't take real payments.");
      }
      if (keys.mode === "live" && (await getSetting(db, "legal_confirmed")) !== true) {
        return error(503, "legal_not_confirmed", "Payments open once the terms and refund policy are published. Please message us on WhatsApp.");
      }
    }

    // ---- student (by email), then the per-student checks
    const studentId = await upsertStudent(db, { name: buyer.name!, email, phone: buyer.phone ?? null }, now);
    const liveMode: PaymentMode = keys?.mode ?? "live";
    if (await hasActiveEnrollment(db, studentId, courseRow.id, liveMode, now)) {
      return error(409, "already_enrolled", "You already have this course. Open it from your account, or message us on WhatsApp.");
    }
    const q = await quote(db, { courseSlug: course, batchId: batchId || undefined, couponCode, studentId, now });
    if (!q.ok) return quoteError(q.reason);

    if (q.free) return freeEnrollment(env, db, { studentId, courseId: courseRow.id, courseSlug: course, quote: q, now, ctx });

    // ---- paid: our order row first, then Razorpay's order, then link them
    if (q.amountPaise < MIN_CHARGE_PAISE) throw new Error("order: amount below the minimum charge");
    const inserted = await db
      .prepare(
        `INSERT INTO orders (mode, student_id, course_id, batch_id, payment_kind, list_price_paise, discount_paise, amount_paise,
           currency, coupon_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, 'created', ?, ?)`,
      )
      .bind(keys!.mode, studentId, q.courseId, q.batchId, q.paymentKind, q.listPaise, q.discountPaise, q.amountPaise, q.couponId, now, now)
      .run();
    const orderId = lastId(inserted);

    let rzpOrder;
    try {
      rzpOrder = await createRazorpayOrder(keys!, {
        amount: q.amountPaise,
        currency: "INR",
        receipt: `order_${orderId}`,
        notes: { order_id: String(orderId), course: course },
      });
    } catch (err) {
      console.error(`order: ${err instanceof Error ? err.message : "unknown error"} (order ${orderId})`);
      await markFailed(db, orderId, "Could not start the payment with Razorpay", now);
      return error(502, "razorpay_unavailable", "We couldn't reach the payment service. Please try again in a minute.");
    }
    if (rzpOrder.amount !== q.amountPaise || rzpOrder.currency !== "INR" || !RZP_ORDER.test(rzpOrder.id)) {
      console.error(`order: Razorpay order ${rzpOrder.id} doesn't match order ${orderId}`);
      await markFailed(db, orderId, "Razorpay created a different order", now);
      return error(502, "order_mismatch", "We couldn't start the payment. Please try again.");
    }
    await db
      .prepare("UPDATE orders SET razorpay_order_id = ?, updated_at = ? WHERE id = ? AND razorpay_order_id IS NULL")
      .bind(rzpOrder.id, now, orderId)
      .run();
    await countCheckout(db, q.courseId, keys!.mode, now);

    const business = await getSetting(db, "business");
    const response: OrderResponse = {
      mode: "razorpay",
      keyId: keys!.keyId,
      orderId: rzpOrder.id,
      amount: q.amountPaise,
      currency: "INR",
      name: business?.name ?? "Feelings Beauty Care",
      description: courseRow.title.slice(0, 250),
      prefill: { name: buyer.name, email, ...(buyer.phone ? { contact: buyer.phone } : {}) },
      testMode: keys!.mode === "test",
      ref: orderId,
    };
    return json(response);
  } catch (err) {
    return errorResponse(err);
  }
}

function quoteError(reason: QuoteFailure): Response {
  const e = QUOTE_ERRORS[reason];
  return error(e.status, e.code, e.message, e.field ? { fields: { [e.field]: e.message } } : {});
}

async function markFailed(db: Db, orderId: number, reason: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE orders SET status = 'failed', failure_reason = ?, failed_at = ?, updated_at = ? WHERE id = ? AND status = 'created'")
    .bind(reason, now, now, orderId)
    .run();
}

/** checkouts_started, through W7's bump() once it exists (live mode only, so tests don't count). */
async function countCheckout(db: Db, courseId: number, mode: PaymentMode, now: number): Promise<void> {
  if (mode !== "live") return;
  try {
    await bump(db, statDay(now), courseId, "checkouts_started").run();
  } catch (err) {
    if (!(err instanceof NotImplementedError)) console.error(`stats: ${err instanceof Error ? err.message : "unknown error"}`);
  }
}

/**
 * Finds the student by email, or creates one (owner decision, 23 Oct 2026: the email is the
 * account). Typing an address proves nothing, so an existing account is never changed by a
 * checkout: only an empty name is filled in. The phone is an optional contact detail: it is stored
 * on a NEW account only, only when no other student has it (students.phone is unique), and it is
 * never used to find an account.
 */
export async function upsertStudent(db: Db, buyer: { name: string; email: string; phone: string | null }, now: number): Promise<number> {
  const email = buyer.email.trim().toLowerCase();
  const existing = await db.prepare("SELECT id FROM students WHERE email = ? AND erased_at IS NULL").bind(email).first<{ id: number }>();
  if (existing) {
    await db.prepare("UPDATE students SET name = COALESCE(name, ?), updated_at = ? WHERE id = ?").bind(buyer.name, now, existing.id).run();
    return existing.id;
  }
  const insert = (phone: string | null) =>
    db
      .prepare(
        "INSERT INTO students (name, phone, email, created_at, updated_at) " +
          "SELECT ?, CASE WHEN ? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM students WHERE phone = ?) THEN ? END, ?, ?, ?",
      )
      .bind(buyer.name, phone, phone, phone, email, now, now)
      .run();
  try {
    return lastId(await insert(buyer.phone));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Two first orders from one email at once: read the winner. Or the phone was taken a moment ago: leave it off.
    const row = await db.prepare("SELECT id FROM students WHERE email = ? AND erased_at IS NULL").bind(email).first<{ id: number }>();
    if (row) return row.id;
    return lastId(await insert(null));
  }
}

/** An enrollment that still gives access (a test-mode one doesn't count once payments are live). */
export async function hasActiveEnrollment(db: Db, studentId: number, courseId: number, mode: PaymentMode, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS active FROM enrollments
       WHERE student_id = ? AND course_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
         AND NOT (mode = 'test' AND ? = 'live')`,
    )
    .bind(studentId, courseId, now, mode)
    .first();
  return Boolean(row);
}

/**
 * A free order: an allow_free coupon at 100%, or a course priced 0. No Razorpay, no orders row
 * (orders.amount_paise is at least ₹1). One batch: the redemption first (only while the coupon has
 * uses left; the unique index allows one free redemption per student and course), then the
 * enrollment and seat only if that redemption exists.
 */
async function freeEnrollment(
  env: Env,
  db: Db,
  input: {
    studentId: number;
    courseId: number;
    courseSlug: string;
    quote: Extract<Awaited<ReturnType<typeof quote>>, { ok: true }>;
    now: number;
    ctx?: WaitUntil;
  },
): Promise<Response> {
  const { studentId, courseId, quote: q, now } = input;
  const course = await db
    .prepare("SELECT access_days, format FROM courses WHERE id = ?")
    .bind(courseId)
    .first<{ access_days: number | null; format: string }>();
  const expiresAt = course?.access_days ? now + course.access_days * DAY_SECONDS : null;
  const couponId = q.couponId;
  const source = couponId !== null ? "coupon_free" : "manual";
  const proof =
    couponId !== null
      ? {
          sql: "EXISTS (SELECT 1 FROM coupon_redemptions WHERE coupon_id = ? AND student_id = ? AND course_id = ? AND order_id IS NULL AND created_at = ?)",
          params: [couponId, studentId, courseId, now],
        }
      : { sql: "1 = 1", params: [] };

  try {
    await batch(db, [
      couponId !== null &&
        db
          .prepare(
            `INSERT INTO coupon_redemptions (coupon_id, student_id, course_id, order_id, discount_paise, created_at)
             SELECT ?, ?, ?, NULL, ?, ?
             WHERE EXISTS (SELECT 1 FROM coupons WHERE id = ? AND active = 1 AND (max_uses IS NULL OR used_count < max_uses))`,
          )
          .bind(couponId, studentId, courseId, q.discountPaise, now, couponId),
      couponId !== null &&
        db.prepare(`UPDATE coupons SET used_count = used_count + 1, updated_at = ? WHERE id = ? AND ${proof.sql}`).bind(now, couponId, ...proof.params),
      db
        .prepare(
          `INSERT INTO enrollments (student_id, course_id, batch_id, source, mode, order_id, starts_at, expires_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, 'live', NULL, ?, ?, ?, ? WHERE ${proof.sql}
           ON CONFLICT (student_id, course_id) DO UPDATE SET
             batch_id = excluded.batch_id, source = excluded.source, mode = 'live', order_id = NULL,
             starts_at = excluded.starts_at, expires_at = excluded.expires_at, revoked_at = NULL, updated_at = excluded.updated_at
           WHERE enrollments.revoked_at IS NOT NULL
              OR (enrollments.expires_at IS NOT NULL AND enrollments.expires_at <= excluded.starts_at)
              OR enrollments.mode = 'test'`,
        )
        .bind(studentId, courseId, q.batchId, source, now, expiresAt, now, now, ...proof.params),
      q.batchId !== null &&
        db
          .prepare(`UPDATE batches SET seats_taken = seats_taken + 1, updated_at = ? WHERE id = ? AND ${proof.sql}`)
          .bind(now, q.batchId, ...proof.params),
      couponId !== null
        ? auditStatementWhen(
            db,
            { actor: `student:${studentId}`, action: "enrollment.free", entity: "course", entityId: courseId, data: { coupon: couponId }, now },
            proof,
          )
        : auditStatement(db, { actor: `student:${studentId}`, action: "enrollment.free", entity: "course", entityId: courseId, now }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return quoteError("coupon_already_used");
    throw err;
  }
  if (!(await hasActiveEnrollment(db, studentId, courseId, "live", now))) return quoteError("coupon_used_up");
  // Recorded lessons open the course area; a studio-only booking has none, so it lands on the account.
  const target = course?.format === "in_person" ? "/account" : `/learn/${input.courseSlug}`;
  // Typing an address proves nothing: the enrollment opens the account on this device only when
  // the account holds nothing else and its email was never proven (claim.ts). Otherwise the
  // owner of the address opens it from the email.
  const opens = await purchaseOpensAccount(db, studentId, { orderId: null, courseId, since: now });
  const handoff = opens ? await handoffUrl(env, db, studentId, target) : null;
  // The account's email gets "you're enrolled" and a sign-in link in every case.
  const mail = sendEnrolledEmail(env, studentId, courseId, now);
  if (input.ctx) input.ctx.waitUntil(mail);
  else await mail;
  const checkEmail = `${config(env).hubOrigin}/signin?sent=1`;
  return json({ mode: "free", redirect: handoff ?? (opens ? "/thank-you" : checkEmail) } satisfies OrderResponse);
}

// ---------------------------------------------------------------- POST /api/verify

/** A sign-in link to the hub (W3's handoff token), or null until W3 implements it. */
async function handoffUrl(env: Env, db: Db, studentId: number, path: string): Promise<string | null> {
  try {
    const token = await issueLoginToken(db, studentId, "handoff", path);
    return `${config(env).hubOrigin}/auth/continue?t=${encodeURIComponent(token)}`;
  } catch (err) {
    if (err instanceof NotImplementedError) return null;
    console.error(`handoff: ${err instanceof Error ? err.message : "unknown error"}`);
    return null;
  }
}

/** Absolute receipt link on the hub, or null when APP_SECRET isn't set yet. */
async function receiptUrl(env: Env, orderId: number): Promise<string | null> {
  try {
    return `${config(env).hubOrigin}${await receiptPath(env, orderId)}`;
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

type Confirmation =
  | { ok: true; redirect: string; receipt: string | null }
  | { ok: false; status: number; code: string; message: string };

export async function handleLiveVerify(request: Request, env: Env, now = unixNow(), ctx?: WaitUntil): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!hasDb(env)) return error(503, "platform_not_configured", "This part of the site isn't set up yet.");
  const contentType = (request.headers.get("Content-Type") ?? "").toLowerCase();
  const form = contentType.startsWith("application/x-www-form-urlencoded");
  try {
    let ids: Payload;
    if (form) {
      // Razorpay's callback_url flow (in-app browsers): a cross-site form post, then a redirect.
      // It needs no Origin check: nothing happens without a valid signature.
      const text = await readBody(request);
      if (text === null) return redirect(request, "/payment-failed");
      ids = Object.fromEntries(new URLSearchParams(text));
    } else {
      if (!sameOrigin(request)) return error(403, "cross_origin", "This request must come from the course site.");
      const body = await readJson(request);
      if (!body.ok) return body.response;
      ids = body.value;
    }
    const result = await confirmPayment(env, env.DB, ids, now, request, ctx);
    if (form) return redirect(request, result.ok ? result.redirect : "/payment-failed");
    if (!result.ok) return error(result.status, result.code, result.message);
    return json({ ok: true, redirect: result.redirect, ...(result.receipt ? { receipt: result.receipt } : {}) } satisfies VerifyResponse);
  } catch (err) {
    if (form) {
      console.error(`verify: ${err instanceof Error ? err.message : "unknown error"}`);
      return redirect(request, "/payment-failed");
    }
    return errorResponse(err);
  }
}

/** Signature first (offline, cheap), then Razorpay's record of the payment, then fulfilment. */
async function confirmPayment(env: Env, db: Db, ids: Payload, now: number, request: Request, ctx?: WaitUntil): Promise<Confirmation> {
  const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = ids;
  if (
    typeof orderId !== "string" || !RZP_ORDER.test(orderId) ||
    typeof paymentId !== "string" || !RZP_PAYMENT.test(paymentId) ||
    typeof signature !== "string" || !SIGNATURE.test(signature)
  ) {
    return { ok: false, status: 400, code: "invalid_payment", message: "The payment details are incomplete." };
  }
  const keys = paymentKeys(env);
  if (!(await verifyRazorpaySignature(orderId, paymentId, signature, keys.keySecret))) {
    console.error(`verify: bad signature for ${orderId} / ${paymentId}`);
    return { ok: false, status: 400, code: "signature_invalid", message: "We couldn't verify this payment." };
  }
  const order = await getOrderByRazorpayId(db, orderId);
  if (!order) return { ok: false, status: 400, code: "order_mismatch", message: "We couldn't find this order." };
  if (order.mode !== keys.mode) {
    return { ok: false, status: 409, code: "payment_not_confirmed", message: "This payment was made in another payment mode." };
  }

  let payment;
  try {
    payment = await fetchRazorpayPayment(keys, paymentId);
    if (payment.status === "authorized" && payment.order_id === orderId && payment.amount === order.amount_paise) {
      payment = await captureOrFetchPayment(keys, paymentId, order.amount_paise, order.currency);
    }
  } catch (err) {
    console.error(`verify: ${err instanceof Error ? err.message : "unknown error"}`);
    const status = err instanceof RazorpayError && err.status === 0 ? 504 : 502;
    return {
      ok: false,
      status,
      code: "razorpay_unavailable",
      message: "Your payment went through, but we couldn't confirm it yet. It will be confirmed in a few minutes; message us on WhatsApp if your course doesn't open.",
    };
  }
  if (payment.id !== paymentId) {
    return { ok: false, status: 400, code: "payment_not_confirmed", message: "This payment isn't complete for this course." };
  }

  const result = await fulfilOrderDb(db, { orderId: order.id, payment: toPayment(payment), actor: `student:${order.student_id}`, now });
  if (!result.ok) {
    console.error(`verify: order ${order.id} not fulfilled (${result.reason})`);
    if (result.reason === "refunded") {
      return { ok: false, status: 409, code: "payment_not_confirmed", message: "This payment was refunded." };
    }
    return { ok: false, status: 400, code: "payment_not_confirmed", message: "This payment isn't complete for this course." };
  }

  const fresh = await getOrderRow(db, order.id);
  const receipt = await receiptUrl(env, order.id);
  const receiptRelative = receipt ? receipt.slice(config(env).hubOrigin.length) : null;
  // A sign-in link only right after the payment: an old (order, payment, signature) triple seen
  // later must not become a way into the student's account.
  const recent = fresh?.paid_at !== null && fresh?.paid_at !== undefined && now - fresh.paid_at <= HANDOFF_WINDOW;
  // Typing an email at checkout proves nothing, so a payment signs this device in only when the
  // account holds nothing else and its email was never proven (claim.ts). Otherwise the receipt
  // shows on screen, and the owner of the address opens the course from the email.
  const opens =
    recent && (await purchaseOpensAccount(db, result.studentId, { orderId: order.id, courseId: order.course_id, since: order.created_at }));
  const handoff = opens ? await handoffUrl(env, db, result.studentId, receiptRelative ?? "/account") : null;

  // The receipt and a sign-in link go to the account's email, once per order: whichever of
  // verify and the webhook marked the order paid sends them.
  if (!result.alreadyPaid) {
    const mail = sendReceiptEmail(env, order.id, now);
    if (ctx) ctx.waitUntil(mail);
    else await mail;
  }

  if (handoff) return { ok: true, redirect: handoff, receipt };
  // Already signed in as this student on this device (checkout on the hub): straight to the receipt.
  const session = await readSession(env, request, now);
  if (session?.studentId === result.studentId) return { ok: true, redirect: receipt ?? "/account", receipt };
  return { ok: true, redirect: receipt ?? `${config(env).hubOrigin}/signin?sent=1`, receipt };
}

// ---------------------------------------------------------------- POST /api/razorpay/webhook

/**
 * Razorpay's webhook. Checked with X-Razorpay-Signature (HMAC of the raw body with the webhook
 * secret), stored once per event id (X-Razorpay-Event-Id), then processed. A duplicate delivery of
 * a processed event answers 200 at once. A processing error answers 500, so Razorpay retries, and
 * the event stays in the admin's webhook log for a replay.
 */
export async function handleWebhook(request: Request, env: Env, ctx?: WaitUntil, now = unixNow()): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed();
  if (!hasDb(env)) return error(503, "platform_not_configured", "This part of the site isn't set up yet.");
  const db: Db = env.DB;
  let secret: string;
  try {
    secret = requireSecret(env, "RAZORPAY_WEBHOOK_SECRET", 12);
  } catch (err) {
    return errorResponse(err);
  }
  const raw = await readBody(request, MAX_WEBHOOK_BYTES);
  if (raw === null) return error(413, "too_large", "That request is too large.");
  const signature = request.headers.get("X-Razorpay-Signature") ?? "";
  if (!(await verifyWebhookSignature(raw, signature, secret))) {
    console.error("webhook: bad signature");
    return error(400, "signature_invalid", "Bad signature.");
  }

  let event: Payload;
  try {
    event = JSON.parse(raw);
  } catch {
    return error(400, "invalid_json", "The body must be JSON.");
  }
  const type = typeof event?.event === "string" ? event.event : "";
  if (!/^[a-z_]+\.[a-z_.]+$/.test(type) || type.length > 60) return error(400, "bad_request", "No event type.");
  const header = request.headers.get("X-Razorpay-Event-Id") ?? "";
  const eventId = EVENT_ID.test(header) ? header : `body_${await sha256Hex(raw)}`;
  const mode: PaymentMode = razorpayMode(env.RAZORPAY_KEY_ID) ?? "test";

  try {
    await db
      .prepare(
        "INSERT INTO webhook_events (event_id, type, mode, payload, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING",
      )
      .bind(eventId, type, mode, raw, now)
      .run();
    const stored = await db
      .prepare("SELECT processed_at FROM webhook_events WHERE event_id = ?")
      .bind(eventId)
      .first<{ processed_at: number | null }>();
    if (stored?.processed_at !== null && stored?.processed_at !== undefined) return json({ ok: true });

    let keys: PaymentKeys | null = null;
    try {
      keys = paymentKeys(env);
    } catch {
      keys = null;
    }
    const outcome = await processWebhookEventDb(db, keys, eventId, now);
    if (outcome.paidOrderId !== null) {
      const mail = sendReceiptEmail(env, outcome.paidOrderId, now);
      if (ctx) ctx.waitUntil(mail);
      else await mail;
    }
  } catch (err) {
    console.error(`webhook: ${type} ${eventId}: ${err instanceof Error ? err.message : "unknown error"}`);
    return error(500, "server_error", "Not processed. Please retry.");
  } finally {
    if (ctx) {
      // The lazy daily job (W7) piggybacks on webhook traffic. Never let it fail the webhook.
      try {
        await maybeRunDaily(env, ctx);
      } catch (err) {
        if (!(err instanceof NotImplementedError)) console.error(`daily: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }
  }
  return json({ ok: true });
}
