/**
 * Server-side pricing (plan 1.9): course or batch price, then coupon, then the amount in paise
 * (at least ₹1 unless an allow_free coupon makes it free). Signature frozen by W0, body by W2.
 *
 * Everything comes from D1. The browser sends a course slug, maybe a batch id and a coupon code;
 * it never sends a price, and nothing it sends is trusted beyond picking which rows to read.
 *
 * Rules:
 * - Only a published, not deleted course with a price is for sale (price 0 = a free course).
 * - online courses take no batch; in_person courses need an open batch of the course; hybrid
 *   courses may take one (a batch booking plus the recorded lessons) or none (recorded only).
 * - A batch with a seat limit and no seats left is "batch_full". A batch whose end date (or start
 *   date, without an end) has passed in India time can't be booked.
 * - The list price is the batch's price when it has one, else the course's.
 * - A coupon must be active, started, not expired, for this course (or every course), not used up,
 *   and not already redeemed by this student. Percent coupons round the discount down to the paisa.
 * - What is left is charged, at least MIN_CHARGE_PAISE. Only an allow_free coupon that takes the
 *   price to exactly 0 makes the order free (enroll without Razorpay).
 * - Booking amount: when the course has deposit_paise and a batch is booked, Razorpay charges the
 *   deposit (or the discounted price, if lower) and the balance is paid at the studio.
 */
import type { PaymentKind, Quote, QuoteFailure, Unix } from "../../src/shared/types.ts";
import { MIN_CHARGE_PAISE } from "../../src/shared/constants.ts";
import { statDay } from "./analytics.ts";
import type { Db } from "./db/d1.ts";

export interface QuoteInput {
  courseSlug: string;
  batchId?: number;
  couponCode?: string;
  /** For per-student coupon rules (a free coupon once per student). */
  studentId?: number;
  now: Unix;
}

interface CourseRow {
  id: number;
  format: "online" | "in_person" | "hybrid";
  price_paise: number | null;
  deposit_paise: number | null;
  status: string;
  deleted_at: number | null;
}

interface BatchRow {
  id: number;
  course_id: number;
  starts_on: string;
  ends_on: string | null;
  price_paise: number | null;
  seats: number | null;
  seats_taken: number;
  status: string;
}

export interface CouponRow {
  id: number;
  code: string;
  percent_off: number | null;
  amount_off_paise: number | null;
  course_id: number | null;
  max_uses: number | null;
  used_count: number;
  starts_at: number | null;
  expires_at: number | null;
  active: number;
  allow_free: number;
}

const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const COUPON_RE = /^[A-Z0-9_-]{3,32}$/;

const fail = (reason: QuoteFailure): Quote => ({ ok: false, reason });

/** A coupon code as stored (trimmed, uppercased), or null when it can't be one. */
export function normaliseCouponCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tidy = value.trim().toUpperCase();
  return COUPON_RE.test(tidy) ? tidy : null;
}

/** "₹2,999" or "₹2,999.50", Indian digit grouping. */
export function formatRupees(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const rest = Math.abs(paise) % 100;
  const grouped = rupees.toLocaleString("en-IN");
  return `${paise < 0 ? "-" : ""}₹${grouped}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

/** The discount a coupon gives on `listPaise` (never more than the list price). */
export function couponDiscount(coupon: Pick<CouponRow, "percent_off" | "amount_off_paise">, listPaise: number): number {
  if (coupon.percent_off !== null) return Math.min(listPaise, Math.floor((listPaise * coupon.percent_off) / 100));
  return Math.min(listPaise, coupon.amount_off_paise ?? 0);
}

export function couponLabel(coupon: Pick<CouponRow, "percent_off" | "amount_off_paise">): string {
  return coupon.percent_off !== null ? `${coupon.percent_off}% off` : `${formatRupees(coupon.amount_off_paise ?? 0)} off`;
}

/** Why a coupon can't be used right now (before the per-student check), or null when it can. */
export function couponProblem(coupon: CouponRow, courseId: number, now: Unix): QuoteFailure | null {
  if (coupon.active !== 1) return "coupon_inactive";
  if (coupon.starts_at !== null && now < coupon.starts_at) return "coupon_not_started";
  if (coupon.expires_at !== null && now >= coupon.expires_at) return "coupon_expired";
  if (coupon.course_id !== null && coupon.course_id !== courseId) return "coupon_wrong_course";
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) return "coupon_used_up";
  return null;
}

export async function quote(db: Db, input: QuoteInput): Promise<Quote> {
  const slug = typeof input.courseSlug === "string" ? input.courseSlug.trim().toLowerCase() : "";
  if (!SLUG_RE.test(slug)) return fail("course_not_found");
  if (!Number.isSafeInteger(input.now)) throw new TypeError("quote: now must be unix seconds");
  const now = input.now;

  const course = await db
    .prepare("SELECT id, format, price_paise, deposit_paise, status, deleted_at FROM courses WHERE slug = ?")
    .bind(slug)
    .first<CourseRow>();
  if (!course || course.deleted_at !== null) return fail("course_not_found");
  if (course.status !== "published" || course.price_paise === null) return fail("course_not_for_sale");

  // ---- batch
  let batch: BatchRow | null = null;
  const wantsBatch = input.batchId !== undefined && input.batchId !== null;
  if (wantsBatch) {
    if (course.format === "online") return fail("batch_not_found");
    if (!Number.isSafeInteger(input.batchId) || (input.batchId as number) < 1) return fail("batch_not_found");
    batch = await db
      .prepare(
        "SELECT id, course_id, starts_on, ends_on, price_paise, seats, seats_taken, status FROM batches WHERE id = ? AND course_id = ?",
      )
      .bind(input.batchId as number, course.id)
      .first<BatchRow>();
    if (!batch || batch.status !== "open") return fail("batch_not_found");
    const today = statDay(now);
    if ((batch.ends_on ?? batch.starts_on) < today) return fail("batch_not_found");
    if (batch.seats !== null && batch.seats_taken >= batch.seats) return fail("batch_full");
  } else if (course.format === "in_person") {
    return fail("batch_not_found");
  }

  const listPaise = batch?.price_paise ?? course.price_paise;

  // ---- coupon
  let coupon: CouponRow | null = null;
  if (input.couponCode !== undefined && input.couponCode !== null && String(input.couponCode).trim() !== "") {
    const code = normaliseCouponCode(input.couponCode);
    if (!code) return fail("coupon_not_found");
    coupon = await db
      .prepare(
        "SELECT id, code, percent_off, amount_off_paise, course_id, max_uses, used_count, starts_at, expires_at, active, allow_free FROM coupons WHERE code = ?",
      )
      .bind(code)
      .first<CouponRow>();
    if (!coupon) return fail("coupon_not_found");
    const problem = couponProblem(coupon, course.id, now);
    if (problem) return fail(problem);
    if (input.studentId !== undefined) {
      const used = await db
        .prepare("SELECT 1 AS used FROM coupon_redemptions WHERE coupon_id = ? AND student_id = ? LIMIT 1")
        .bind(coupon.id, input.studentId)
        .first<{ used: number }>();
      if (used) return fail("coupon_already_used");
    }
  }

  // ---- amount
  let discountPaise = coupon ? couponDiscount(coupon, listPaise) : 0;
  let net = listPaise - discountPaise;
  let free = false;
  if (listPaise === 0) {
    // A free course: a coupon has nothing to take off, so it isn't recorded.
    coupon = null;
    discountPaise = 0;
    net = 0;
    free = true;
  } else if (net === 0 && coupon?.allow_free === 1) {
    free = true;
  } else if (net < MIN_CHARGE_PAISE) {
    // Razorpay can't charge less than ₹1, and only an allow_free coupon may make a course free.
    net = MIN_CHARGE_PAISE;
    discountPaise = listPaise - net;
  }

  let paymentKind: PaymentKind = "full";
  let amountPaise = net;
  if (!free && batch && course.deposit_paise !== null && course.deposit_paise < net) {
    paymentKind = "deposit";
    amountPaise = course.deposit_paise;
  }

  return {
    ok: true,
    courseId: course.id,
    batchId: batch?.id ?? null,
    couponId: coupon ? coupon.id : null,
    paymentKind,
    listPaise,
    discountPaise,
    amountPaise: free ? 0 : amountPaise,
    free,
    label: coupon ? couponLabel(coupon) : null,
  };
}
