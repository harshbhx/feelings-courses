/**
 * Order fulfilment, refunds and webhook processing (plan 1.9). Signatures frozen by W0, bodies by W2.
 *
 * fulfilOrder is ONE D1 batch. Every statement in it is guarded by "this order is still unpaid"
 * (status created or failed), and the LAST statement is the one that marks the order paid. So the
 * batch that pays the order applies everything (enrollment, coupon redemption, batch seat, invoice
 * number, stats, audit) and any racing batch (verify and webhook arriving together, a retry, a
 * replay) finds the order paid and changes nothing. D1 runs a batch as one transaction, so there is
 * no state in between.
 *
 * Refunds use the same pattern on the `refunds` row: everything is guarded by "this refund isn't
 * processed yet", and the last statement marks it processed.
 *
 * Owner decisions built in:
 * - refunds only within REFUND_WINDOW_SECONDS (24 h) of payment;
 * - invoice numbers are consecutive per financial year (India, April to March) and are given only
 *   to live-mode payments, so test payments never leave gaps in the real series; never shown with
 *   a GSTIN or tax lines;
 * - access_days (365 by default) from the moment of payment.
 */
import type {
  AdminOrder,
  OrderStatus,
  OrderSummary,
  PaymentKind,
  PaymentMode,
  RazorpayPayment,
  Refund,
  RefundStatus,
} from "../../src/shared/types.ts";
import { REFUND_WINDOW_SECONDS } from "../../src/shared/constants.ts";
import { statDay } from "./analytics.ts";
import { ConfigError, razorpayMode, requireSecret } from "./config.ts";
import { auditStatementWhen } from "./db/audit.ts";
import type { Db, DbStatement, DbValue } from "./db/d1.ts";
import { DAY_SECONDS, unixNow } from "./db/d1.ts";
import { ConflictError, ValidationError } from "./db/errors.ts";
import { batch, changes, lastId, whenExists } from "./db/tx.ts";
import type { Env } from "./env.ts";
import {
  RazorpayError,
  captureOrFetchPayment,
  createRazorpayRefund,
  fetchRazorpayOrderPayments,
  fetchRazorpayRefunds,
} from "./razorpay.ts";
import type { RazorpayKeys, RazorpayPayment as ApiPayment, RazorpayRefundEntity } from "./razorpay.ts";

export type FulfilResult =
  | { ok: true; alreadyPaid: boolean; studentId: number; courseId: number; enrollmentId: number }
  | { ok: false; reason: "order_not_found" | "amount_mismatch" | "order_mismatch" | "not_captured" | "refunded" };

// ---------------------------------------------------------------- keys and small helpers

export interface PaymentKeys extends RazorpayKeys {
  mode: PaymentMode;
}

/** The Razorpay keys and their mode. ConfigError (503 platform_not_configured) when missing or malformed. */
export function paymentKeys(env: Partial<Env>): PaymentKeys {
  const keyId = requireSecret(env, "RAZORPAY_KEY_ID", 10);
  const keySecret = requireSecret(env, "RAZORPAY_KEY_SECRET", 10);
  const mode = razorpayMode(keyId);
  if (!mode) throw new ConfigError("RAZORPAY_KEY_ID");
  return { keyId, keySecret, mode };
}

/** Prefix of every invoice number. "FBC/26-27/00042" stays within GST's 16-character limit. */
export const INVOICE_PREFIX = "FBC";

/** The Indian financial year (April to March, India time) of a moment: "2026-27". */
export function financialYear(unix: number): string {
  const day = statDay(unix); // YYYY-MM-DD in India time
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** "FBC/26-27/" for the financial year "2026-27". */
export function invoiceSeriesPrefix(fy: string): string {
  return `${INVOICE_PREFIX}/${fy.slice(2)}/`;
}

/** "+91 ••••• •1578". Only the last four digits stay. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const last4 = phone.slice(-4);
  if (phone.startsWith("+91") && phone.length === 13) return `+91 ••••• •${last4}`;
  return `•••• ${last4}`;
}

const clip = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : null;

/** The shared RazorpayPayment shape from the API client's looser one. */
export function toPayment(p: ApiPayment): RazorpayPayment {
  return {
    id: p.id,
    amount: p.amount,
    currency: p.currency,
    status: p.status as RazorpayPayment["status"],
    order_id: p.order_id ?? null,
    method: p.method ?? null,
    email: p.email ?? null,
    contact: p.contact ?? null,
    error_description: p.error_description ?? null,
  };
}

// ---------------------------------------------------------------- rows

interface OrderRow {
  id: number;
  razorpay_order_id: string | null;
  mode: PaymentMode;
  student_id: number;
  course_id: number;
  batch_id: number | null;
  payment_kind: PaymentKind;
  list_price_paise: number;
  discount_paise: number;
  amount_paise: number;
  currency: string;
  coupon_id: number | null;
  status: OrderStatus;
  razorpay_payment_id: string | null;
  method: string | null;
  invoice_no: string | null;
  refunded_paise: number;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
  paid_at: number | null;
}

const ORDER_COLUMNS =
  "id, razorpay_order_id, mode, student_id, course_id, batch_id, payment_kind, list_price_paise, discount_paise, amount_paise, currency, coupon_id, status, razorpay_payment_id, method, invoice_no, refunded_paise, failure_reason, created_at, updated_at, paid_at";

export async function getOrderRow(db: Db, orderId: number): Promise<OrderRow | null> {
  return db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ?`).bind(orderId).first<OrderRow>();
}

export async function getOrderByRazorpayId(db: Db, razorpayOrderId: string): Promise<OrderRow | null> {
  return db.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE razorpay_order_id = ?`).bind(razorpayOrderId).first<OrderRow>();
}

interface RefundRow {
  id: number;
  order_id: number;
  razorpay_refund_id: string | null;
  amount_paise: number;
  status: RefundStatus;
  reason: string | null;
  revoke_access: number;
  created_at: number;
  updated_at: number;
}

const REFUND_COLUMNS = "id, order_id, razorpay_refund_id, amount_paise, status, reason, revoke_access, created_at, updated_at";

function toRefund(row: RefundRow): Refund {
  return {
    id: row.id,
    orderId: row.order_id,
    razorpayRefundId: row.razorpay_refund_id,
    amountPaise: row.amount_paise,
    status: row.status,
    reason: row.reason,
    revokeAccess: row.revoke_access === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRefunds(db: Db, orderId: number): Promise<Refund[]> {
  const { results } = await db
    .prepare(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE order_id = ? ORDER BY id`)
    .bind(orderId)
    .all<RefundRow>();
  return results.map(toRefund);
}

async function getRefundRow(db: Db, refundId: number): Promise<RefundRow | null> {
  return db.prepare(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE id = ?`).bind(refundId).first<RefundRow>();
}

// ---------------------------------------------------------------- fulfil

export async function fulfilOrder(env: Env, input: { orderId: number; payment: RazorpayPayment }): Promise<FulfilResult> {
  return fulfilOrderDb(env.DB, input);
}

/** fulfilOrder on a Db (tests and callers that already hold one). */
export async function fulfilOrderDb(
  db: Db,
  input: { orderId: number; payment: RazorpayPayment; actor?: string; now?: number },
): Promise<FulfilResult> {
  const { orderId, payment } = input;
  const now = input.now ?? unixNow();
  const actor = input.actor ?? "razorpay";
  const order = await getOrderRow(db, orderId);
  if (!order) return { ok: false, reason: "order_not_found" };
  if (!payment || payment.order_id !== order.razorpay_order_id || order.razorpay_order_id === null) {
    return { ok: false, reason: "order_mismatch" };
  }
  if (payment.amount !== order.amount_paise || payment.currency !== order.currency) return { ok: false, reason: "amount_mismatch" };
  if (payment.status !== "captured" && payment.status !== "refunded") return { ok: false, reason: "not_captured" };

  if (order.status !== "created" && order.status !== "failed") {
    return settledResult(db, order, payment.id);
  }
  // A payment Razorpay already refunded in full (late webhook for an order we never saw paid):
  // record it as paid first, the refund webhook then reconciles. Nothing to special-case here.

  const course = await db
    .prepare("SELECT access_days FROM courses WHERE id = ?")
    .bind(order.course_id)
    .first<{ access_days: number | null }>();
  const expiresAt = course?.access_days ? now + course.access_days * DAY_SECONDS : null;
  const live = order.mode === "live";
  const fy = financialYear(now);

  const unpaid = whenExists("orders", "id = ? AND status IN ('created', 'failed')", [orderId]);
  const guard = (sql: string, ...params: DbValue[]): DbStatement =>
    db.prepare(sql).bind(...params, ...unpaid.params);

  const statements: (DbStatement | null)[] = [
    // Enrollment: new, or renewing one that is revoked, expired, or a test-mode enrollment being
    // replaced by a live payment. An active enrollment from another order is left alone (and
    // flagged below): the student paid twice, and the admin refunds the second payment.
    guard(
      `INSERT INTO enrollments (student_id, course_id, batch_id, source, mode, order_id, starts_at, expires_at, created_at, updated_at)
       SELECT ?, ?, ?, 'payment', ?, ?, ?, ?, ?, ? WHERE ${unpaid.sql}
       ON CONFLICT (student_id, course_id) DO UPDATE SET
         batch_id = excluded.batch_id, source = 'payment', mode = excluded.mode, order_id = excluded.order_id,
         starts_at = excluded.starts_at, expires_at = excluded.expires_at, revoked_at = NULL, updated_at = excluded.updated_at
       WHERE enrollments.revoked_at IS NOT NULL
          OR (enrollments.expires_at IS NOT NULL AND enrollments.expires_at <= excluded.starts_at)
          OR (enrollments.mode = 'test' AND excluded.mode = 'live')`,
      order.student_id,
      order.course_id,
      order.batch_id,
      order.mode,
      orderId,
      now,
      expiresAt,
      now,
      now,
    ),
    auditStatementWhen(
      db,
      {
        actor,
        action: "order.duplicate_payment",
        entity: "order",
        entityId: orderId,
        data: { note: "The student already had an active enrollment from another order. Refund this payment." },
        now,
      },
      {
        sql: `${unpaid.sql} AND EXISTS (SELECT 1 FROM enrollments WHERE student_id = ? AND course_id = ? AND (order_id IS NULL OR order_id <> ?))`,
        params: [...unpaid.params, order.student_id, order.course_id, orderId],
      },
    ),
    order.coupon_id !== null
      ? guard(`UPDATE coupons SET used_count = used_count + 1, updated_at = ? WHERE id = ? AND ${unpaid.sql}`, now, order.coupon_id)
      : null,
    order.coupon_id !== null
      ? guard(
          `INSERT INTO coupon_redemptions (coupon_id, student_id, course_id, order_id, discount_paise, created_at)
           SELECT ?, ?, ?, ?, ?, ? WHERE ${unpaid.sql}`,
          order.coupon_id,
          order.student_id,
          order.course_id,
          orderId,
          order.discount_paise,
          now,
        )
      : null,
    // Two buyers can start checkout for the last seat; both payments are real, so the second one
    // still books (the money was taken) but is flagged for the admin, before the seat count passes
    // the limit. A flagged order can be refunded after the 24-hour window (isFlaggedForRefund).
    // Found by the e2e journeys (tests/e2e/02-batches.spec.mjs).
    order.batch_id !== null
      ? auditStatementWhen(
          db,
          {
            actor,
            action: "order.batch_overbooked",
            entity: "order",
            entityId: orderId,
            data: { batch: order.batch_id, note: "The batch was already full when this payment arrived. Move the student to another batch or refund this payment." },
            now,
          },
          {
            sql: `${unpaid.sql} AND EXISTS (SELECT 1 FROM batches WHERE id = ? AND seats IS NOT NULL AND seats_taken >= seats)`,
            params: [...unpaid.params, order.batch_id],
          },
        )
      : null,
    order.batch_id !== null
      ? guard(`UPDATE batches SET seats_taken = seats_taken + 1, updated_at = ? WHERE id = ? AND ${unpaid.sql}`, now, order.batch_id)
      : null,
    live
      ? guard(`INSERT INTO invoice_counters (fy, last) SELECT ?, 0 WHERE ${unpaid.sql} ON CONFLICT (fy) DO NOTHING`, fy)
      : null,
    live ? guard(`UPDATE invoice_counters SET last = last + 1 WHERE fy = ? AND ${unpaid.sql}`, fy) : null,
    live ? statStatement(db, unpaid, statDay(now), order.course_id, { paid: 1, revenue: order.amount_paise }) : null,
    auditStatementWhen(
      db,
      {
        actor,
        action: "order.paid",
        entity: "order",
        entityId: orderId,
        data: { payment: payment.id, amount: order.amount_paise, mode: order.mode },
        now,
      },
      unpaid,
    ),
    // LAST: mark the order paid. Every statement above is guarded by the state this one ends.
    db
      .prepare(
        `UPDATE orders SET status = 'paid', razorpay_payment_id = ?, paid_at = ?, method = ?, payer_contact = ?, payer_email = ?,
           failure_reason = NULL, updated_at = ?,
           invoice_no = ${live ? "? || printf('%05d', (SELECT last FROM invoice_counters WHERE fy = ?))" : "NULL"}
         WHERE id = ? AND status IN ('created', 'failed')`,
      )
      .bind(
        payment.id,
        now,
        clip(payment.method, 30),
        clip(payment.contact, 20),
        clip(payment.email, 254),
        now,
        ...(live ? [invoiceSeriesPrefix(fy), fy] : []),
        orderId,
      ),
  ];

  const results = await batch(db, statements);
  const paidNow = changes(results[results.length - 1]) === 1;
  if (!paidNow) {
    // Lost a race with another fulfil: report what the winner did.
    const fresh = await getOrderRow(db, orderId);
    if (!fresh) return { ok: false, reason: "order_not_found" };
    return settledResult(db, fresh, payment.id);
  }
  const enrollmentId = await enrollmentIdFor(db, order.student_id, order.course_id);
  return { ok: true, alreadyPaid: false, studentId: order.student_id, courseId: order.course_id, enrollmentId };
}

async function settledResult(db: Db, order: OrderRow, paymentId: string): Promise<FulfilResult> {
  if (order.razorpay_payment_id !== paymentId) {
    // A different payment on an order that is already paid. Razorpay normally blocks this; if it
    // happens the admin sees it in the webhook log and refunds it.
    return { ok: false, reason: "order_mismatch" };
  }
  if (order.status === "refunded") return { ok: false, reason: "refunded" };
  const enrollmentId = await enrollmentIdFor(db, order.student_id, order.course_id);
  return { ok: true, alreadyPaid: true, studentId: order.student_id, courseId: order.course_id, enrollmentId };
}

async function enrollmentIdFor(db: Db, studentId: number, courseId: number): Promise<number> {
  const row = await db
    .prepare("SELECT id FROM enrollments WHERE student_id = ? AND course_id = ?")
    .bind(studentId, courseId)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

/**
 * A guarded daily_stats upsert (paid orders, revenue, refunds). W7's bump() returns an unguarded
 * upsert, which a racing batch would apply twice, so the payment batches write their own.
 */
function statStatement(
  db: Db,
  condition: { sql: string; params: DbValue[] },
  day: string,
  courseId: number,
  by: { paid?: number; revenue?: number; refunds?: number },
): DbStatement {
  return db
    .prepare(
      `INSERT INTO daily_stats (day, course_id, paid_orders, revenue_paise, refunds_paise)
       SELECT ?, ?, ?, ?, ? WHERE ${condition.sql}
       ON CONFLICT (day, course_id) DO UPDATE SET
         paid_orders = paid_orders + excluded.paid_orders,
         revenue_paise = revenue_paise + excluded.revenue_paise,
         refunds_paise = refunds_paise + excluded.refunds_paise`,
    )
    .bind(day, courseId, by.paid ?? 0, by.revenue ?? 0, by.refunds ?? 0, ...condition.params);
}

/** Marks an unpaid order failed (payment.failed webhook, or a sync that finds only failed attempts). */
export async function markOrderFailed(db: Db, orderId: number, reason: string | null, now = unixNow()): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE orders SET status = 'failed', failure_reason = ?, failed_at = ?, updated_at = ? WHERE id = ? AND status = 'created'",
    )
    .bind(clip(reason, 300) ?? "Payment failed", now, now, orderId)
    .run();
  return changes(result) === 1;
}

// ---------------------------------------------------------------- refunds

/** Until when a paid order can be refunded (paid_at + 24 h), or null if unpaid. */
export function refundableUntil(paidAt: number | null): number | null {
  return paidAt === null ? null : paidAt + REFUND_WINDOW_SECONDS;
}

/** Calls Razorpay's refund API and records a `refunds` row; the webhook (or sync) finalises a pending one. */
export async function refundOrder(
  env: Env,
  orderId: number,
  input: { amountPaise?: number; reason: string; revoke: boolean },
): Promise<Refund> {
  return refundOrderDb(env.DB, paymentKeys(env), orderId, input);
}

export async function refundOrderDb(
  db: Db,
  keys: PaymentKeys,
  orderId: number,
  input: { amountPaise?: number; reason: string; revoke: boolean; actor?: string; now?: number },
): Promise<Refund> {
  const now = input.now ?? unixNow();
  const actor = input.actor ?? "admin";
  const reason = typeof input.reason === "string" ? input.reason.replace(/\s+/g, " ").trim() : "";
  if (reason.length < 1 || reason.length > 300) throw new ValidationError("reason", "Give a reason of up to 300 characters.");
  if (typeof input.revoke !== "boolean") throw new ValidationError("revoke", "revoke must be true or false.");

  const order = await getOrderRow(db, orderId);
  if (!order) throw new ConflictError("not_found", "That order doesn't exist.");
  if ((order.status !== "paid" && order.status !== "partially_refunded") || !order.razorpay_payment_id || order.paid_at === null) {
    throw new ConflictError("not_refundable", "Only a paid order can be refunded.");
  }
  if (order.mode !== keys.mode) {
    throw new ConflictError("mode_mismatch", `This is a ${order.mode}-mode order, but the site runs on ${keys.mode}-mode keys.`);
  }
  if (now > order.paid_at + REFUND_WINDOW_SECONDS && !(await isFlaggedForRefund(db, orderId))) {
    // The owner's policy: refund requests within 24 hours of purchase. A second payment for a
    // course the student already had (flagged by fulfilOrder) is not a purchase, so it can always
    // be returned.
    throw new ConflictError("refund_window_closed", "Refunds are only possible within 24 hours of the payment.");
  }

  const pending = await db
    .prepare("SELECT COALESCE(SUM(amount_paise), 0) AS total FROM refunds WHERE order_id = ? AND status = 'pending'")
    .bind(orderId)
    .first<{ total: number }>();
  const remaining = order.amount_paise - order.refunded_paise - (pending?.total ?? 0);
  const amount = input.amountPaise ?? remaining;
  if (!Number.isSafeInteger(amount) || amount < 100) throw new ValidationError("amountPaise", "A refund is at least ₹1.");
  if (amount > remaining) throw new ValidationError("amountPaise", "That is more than what is left to refund.");

  // Reserve the amount first, in one statement that re-checks what is left, so two clicks can't
  // refund more than was paid.
  const inserted = await db
    .prepare(
      `INSERT INTO refunds (order_id, amount_paise, status, reason, revoke_access, created_at, updated_at)
       SELECT ?, ?, 'pending', ?, ?, ?, ?
       WHERE (SELECT amount_paise - refunded_paise FROM orders WHERE id = ? AND status IN ('paid', 'partially_refunded'))
             - (SELECT COALESCE(SUM(amount_paise), 0) FROM refunds WHERE order_id = ? AND status = 'pending') >= ?`,
    )
    .bind(orderId, amount, reason, input.revoke ? 1 : 0, now, now, orderId, orderId, amount)
    .run();
  if (changes(inserted) !== 1) throw new ConflictError("conflict", "Another refund on this order is in progress. Reload and try again.");
  const refundId = lastId(inserted);

  let entity: RazorpayRefundEntity;
  try {
    entity = await createRazorpayRefund(keys, order.razorpay_payment_id, {
      amount,
      receipt: `refund_${refundId}`,
      notes: { order_id: String(orderId), refund_id: String(refundId) },
    });
  } catch (err) {
    if (err instanceof RazorpayError && err.status >= 400 && err.status < 500) {
      // Razorpay said no: nothing was refunded, release the reserved amount.
      await db
        .prepare("UPDATE refunds SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'")
        .bind(now, refundId)
        .run();
      throw new ConflictError("razorpay_refused", `Razorpay refused the refund: ${err.message.replace(/^Razorpay: /, "")}`);
    }
    // Unknown outcome (timeout, 5xx): keep it pending. The webhook or "Sync with Razorpay" settles it.
    console.error(`refund: ${err instanceof Error ? err.message : "unknown error"} (order ${orderId}, refund ${refundId})`);
    const row = await getRefundRow(db, refundId);
    return toRefund(row!);
  }

  await reconcileRefund(db, order, entity, { actor, now, refundId });
  return toRefund((await getRefundRow(db, refundId))!);
}

/** A payment the platform itself flagged (a second payment, a seat that wasn't there): refundable any time. */
async function isFlaggedForRefund(db: Db, orderId: number): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT 1 AS flagged FROM audit_log WHERE entity = 'order' AND entity_id = ? AND action IN ('order.duplicate_payment', 'order.batch_overbooked') LIMIT 1",
    )
    .bind(String(orderId))
    .first();
  return Boolean(row);
}

/**
 * Brings one Razorpay refund into D1: finds (or creates, for a refund made in Razorpay's
 * dashboard) its `refunds` row, then marks it processed (crediting the order, revoking access if
 * asked) or failed. Safe to call any number of times.
 */
export async function reconcileRefund(
  db: Db,
  order: OrderRow,
  entity: RazorpayRefundEntity,
  options: { actor?: string; now?: number; refundId?: number } = {},
): Promise<RefundRow | null> {
  const now = options.now ?? unixNow();
  const actor = options.actor ?? "razorpay";
  if (typeof entity?.id !== "string" || !/^rfnd_[A-Za-z0-9]{1,40}$/.test(entity.id)) return null;
  if (!Number.isSafeInteger(entity.amount) || entity.amount < 100) return null;

  let row = await db
    .prepare(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE razorpay_refund_id = ?`)
    .bind(entity.id)
    .first<RefundRow>();
  if (!row) {
    const notes = entity.notes && !Array.isArray(entity.notes) ? (entity.notes as Record<string, string>) : {};
    const ourId = options.refundId ?? (/^\d{1,12}$/.test(notes.refund_id ?? "") ? Number(notes.refund_id) : null);
    if (ourId !== null) {
      await db
        .prepare(
          "UPDATE refunds SET razorpay_refund_id = ?, updated_at = ? WHERE id = ? AND order_id = ? AND razorpay_refund_id IS NULL AND amount_paise = ?",
        )
        .bind(entity.id, now, ourId, order.id, entity.amount)
        .run();
      row = await db.prepare(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE razorpay_refund_id = ?`).bind(entity.id).first<RefundRow>();
    }
  }
  if (!row) {
    // Made outside this site (Razorpay dashboard). Full refunds revoke access; partial ones don't.
    const full = entity.amount >= order.amount_paise - order.refunded_paise;
    await db
      .prepare(
        `INSERT INTO refunds (order_id, razorpay_refund_id, amount_paise, status, reason, revoke_access, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', 'Refunded in the Razorpay dashboard', ?, ?, ?)
         ON CONFLICT (razorpay_refund_id) DO NOTHING`,
      )
      .bind(order.id, entity.id, entity.amount, full ? 1 : 0, now, now)
      .run();
    row = await db.prepare(`SELECT ${REFUND_COLUMNS} FROM refunds WHERE razorpay_refund_id = ?`).bind(entity.id).first<RefundRow>();
    if (!row) return null;
  }

  if (entity.status === "processed") {
    await finaliseRefund(db, row, order, { actor, now });
  } else if (entity.status === "failed") {
    await db
      .prepare("UPDATE refunds SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'")
      .bind(now, row.id)
      .run();
  }
  return getRefundRow(db, row.id);
}

/** Applies a processed refund once: order totals and status, access, stats, audit, then the row. */
async function finaliseRefund(db: Db, refund: RefundRow, order: OrderRow, options: { actor: string; now: number }): Promise<void> {
  const { now, actor } = options;
  const open = whenExists("refunds", "id = ? AND status <> 'processed'", [refund.id]);
  const guard = (sql: string, ...params: DbValue[]): DbStatement => db.prepare(sql).bind(...params, ...open.params);
  await batch(db, [
    guard(
      `UPDATE orders SET refunded_paise = refunded_paise + ?,
         status = CASE WHEN refunded_paise + ? >= amount_paise THEN 'refunded' ELSE 'partially_refunded' END,
         updated_at = ?
       WHERE id = ? AND status IN ('paid', 'partially_refunded') AND ${open.sql}`,
      refund.amount_paise,
      refund.amount_paise,
      now,
      order.id,
    ),
    guard(
      `UPDATE enrollments SET revoked_at = ?, updated_at = ?
       WHERE order_id = ? AND revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM refunds WHERE id = ? AND revoke_access = 1) AND ${open.sql}`,
      now,
      now,
      order.id,
      refund.id,
    ),
    // A fully refunded batch booking that loses its access gives its seat back.
    order.batch_id !== null
      ? guard(
          `UPDATE batches SET seats_taken = seats_taken - 1, updated_at = ?
           WHERE id = ? AND seats_taken > 0
             AND EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'refunded')
             AND EXISTS (SELECT 1 FROM refunds WHERE id = ? AND revoke_access = 1) AND ${open.sql}`,
          now,
          order.batch_id,
          order.id,
          refund.id,
        )
      : null,
    order.mode === "live" ? statStatement(db, open, statDay(now), order.course_id, { refunds: refund.amount_paise }) : null,
    auditStatementWhen(
      db,
      {
        actor,
        action: "order.refunded",
        entity: "order",
        entityId: order.id,
        data: { refund: refund.razorpay_refund_id, amount: refund.amount_paise, revoke: refund.revoke_access === 1 },
        now,
      },
      open,
    ),
    db
      .prepare("UPDATE refunds SET status = 'processed', updated_at = ? WHERE id = ? AND status <> 'processed'")
      .bind(now, refund.id),
  ]);
}

// ---------------------------------------------------------------- sync

/** Re-fetches the order's payment and refunds from Razorpay and reconciles D1. */
export async function syncOrder(env: Env, orderId: number): Promise<AdminOrder> {
  return syncOrderDb(env.DB, paymentKeys(env), orderId);
}

export async function syncOrderDb(db: Db, keys: PaymentKeys, orderId: number, now = unixNow()): Promise<AdminOrder> {
  let order = await getOrderRow(db, orderId);
  if (!order) throw new ConflictError("not_found", "That order doesn't exist.");
  if (order.mode !== keys.mode) {
    throw new ConflictError("mode_mismatch", `This is a ${order.mode}-mode order, but the site runs on ${keys.mode}-mode keys.`);
  }

  if ((order.status === "created" || order.status === "failed") && order.razorpay_order_id) {
    const payments = await fetchRazorpayOrderPayments(keys, order.razorpay_order_id);
    const settled = payments.find((p) => p.status === "captured" || p.status === "refunded");
    const authorized = payments.find((p) => p.status === "authorized");
    if (settled) {
      await fulfilOrderDb(db, { orderId, payment: toPayment(settled), actor: "admin", now });
    } else if (authorized && authorized.amount === order.amount_paise) {
      const captured = await captureOrFetchPayment(keys, authorized.id, order.amount_paise, order.currency);
      await fulfilOrderDb(db, { orderId, payment: toPayment(captured), actor: "admin", now });
    } else if (payments.length > 0 && payments.every((p) => p.status === "failed") && order.status === "created") {
      await markOrderFailed(db, orderId, payments[payments.length - 1]?.error_description ?? null, now);
    }
    order = (await getOrderRow(db, orderId))!;
  }

  if (order.razorpay_payment_id) {
    for (const refund of await fetchRazorpayRefunds(keys, order.razorpay_payment_id)) {
      if (refund.payment_id !== order.razorpay_payment_id) continue;
      await reconcileRefund(db, order, refund, { actor: "admin", now });
      order = (await getOrderRow(db, orderId))!;
    }
  }
  const out = await loadAdminOrder(db, orderId);
  return out!;
}

// ---------------------------------------------------------------- webhooks

/** Processes a stored webhook_events row (also the admin's replay). Errors go to webhook_events.error. */
export async function processWebhookEvent(env: Env, eventId: string): Promise<WebhookOutcome> {
  let keys: PaymentKeys | null = null;
  try {
    keys = paymentKeys(env);
  } catch {
    keys = null; // capture of authorized payments needs the keys; everything else works without
  }
  return processWebhookEventDb(env.DB, keys, eventId);
}

interface WebhookPayload {
  event?: unknown;
  payload?: {
    payment?: { entity?: ApiPayment };
    order?: { entity?: { id?: string } };
    refund?: { entity?: RazorpayRefundEntity };
  };
}

/** What processing an event did that the caller acts on: the order it newly marked paid (the receipt email goes out once). */
export interface WebhookOutcome {
  paidOrderId: number | null;
}

export async function processWebhookEventDb(db: Db, keys: PaymentKeys | null, eventId: string, now = unixNow()): Promise<WebhookOutcome> {
  const row = await db
    .prepare("SELECT event_id, type, payload, processed_at FROM webhook_events WHERE event_id = ?")
    .bind(eventId)
    .first<{ event_id: string; type: string; payload: string; processed_at: number | null }>();
  if (!row) throw new ConflictError("not_found", "That webhook event doesn't exist.");

  const finish = async (note: string | null) => {
    await db
      .prepare("UPDATE webhook_events SET processed_at = ?, error = ? WHERE event_id = ?")
      .bind(now, note === null ? null : note.slice(0, 1000), eventId)
      .run();
  };

  try {
    const body = JSON.parse(row.payload) as WebhookPayload;
    const outcome: WebhookOutcome = { paidOrderId: null };
    const note = await handleEvent(db, keys, row.type, body, now, outcome);
    await finish(note);
    return outcome;
  } catch (err) {
    // Left unprocessed: Razorpay retries (the endpoint answers 500) and the admin can replay it.
    const message = err instanceof Error ? err.message : "unknown error";
    await db
      .prepare("UPDATE webhook_events SET error = ? WHERE event_id = ?")
      .bind(message.slice(0, 1000), eventId)
      .run();
    throw err;
  }
}

/** Returns a note for the admin's webhook log (null when all went well). Throws on a transient error. */
async function handleEvent(
  db: Db,
  keys: PaymentKeys | null,
  type: string,
  body: WebhookPayload,
  now: number,
  outcome: WebhookOutcome,
): Promise<string | null> {
  const paymentEntity = body.payload?.payment?.entity;
  switch (type) {
    case "payment.captured":
    case "order.paid":
    case "payment.authorized": {
      if (!paymentEntity || typeof paymentEntity.id !== "string") return "No payment in the event.";
      const razorpayOrderId = paymentEntity.order_id ?? body.payload?.order?.entity?.id ?? null;
      if (!razorpayOrderId) return "Payment without an order: not from this site's checkout.";
      const order = await getOrderByRazorpayId(db, razorpayOrderId);
      if (!order) return `No order ${razorpayOrderId} here: not from this site.`;
      let payment = toPayment(paymentEntity);
      if (payment.status === "authorized") {
        if (order.status !== "created" && order.status !== "failed") return null;
        if (!keys) throw new ConfigError("RAZORPAY_KEY_SECRET");
        if (payment.amount !== order.amount_paise) return "Authorized amount doesn't match the order: not captured.";
        payment = toPayment(await captureOrFetchPayment(keys, payment.id, order.amount_paise, order.currency));
      }
      const result = await fulfilOrderDb(db, { orderId: order.id, payment, actor: "razorpay", now });
      if (result.ok && !result.alreadyPaid) outcome.paidOrderId = order.id;
      return result.ok ? null : `Not fulfilled: ${result.reason}.`;
    }
    case "payment.failed": {
      if (!paymentEntity?.order_id) return null;
      const order = await getOrderByRazorpayId(db, paymentEntity.order_id);
      if (!order) return `No order ${paymentEntity.order_id} here: not from this site.`;
      await markOrderFailed(db, order.id, paymentEntity.error_description ?? null, now);
      return null;
    }
    case "refund.created":
    case "refund.processed":
    case "refund.failed": {
      const refund = body.payload?.refund?.entity;
      if (!refund || typeof refund.payment_id !== "string") return "No refund in the event.";
      const order = await db
        .prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE razorpay_payment_id = ?`)
        .bind(refund.payment_id)
        .first<OrderRow>();
      if (!order) return `No order for payment ${refund.payment_id} here: not from this site.`;
      const status = type === "refund.processed" ? "processed" : type === "refund.failed" ? "failed" : refund.status;
      const reconciled = await reconcileRefund(db, order, { ...refund, status }, { actor: "razorpay", now });
      return reconciled ? null : "Refund could not be matched.";
    }
    default:
      return `Ignored: ${type}.`;
  }
}

// ---------------------------------------------------------------- reads for the admin and receipts

interface AdminOrderRow extends OrderRow {
  course_slug: string;
  course_title: string;
  student_name: string | null;
  student_phone: string | null;
  coupon_code: string | null;
}

export function toOrderSummary(row: OrderRow & { course_slug: string; course_title: string }): OrderSummary {
  return {
    id: row.id,
    courseId: row.course_id,
    courseSlug: row.course_slug,
    courseTitle: row.course_title,
    status: row.status,
    mode: row.mode,
    paymentKind: row.payment_kind,
    amountPaise: row.amount_paise,
    refundedPaise: row.refunded_paise,
    razorpayPaymentId: row.razorpay_payment_id,
    invoiceNo: row.invoice_no,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    refundableUntil: refundableUntil(row.paid_at),
  };
}

/** One order as the admin sees it, or null. */
export async function loadAdminOrder(db: Db, orderId: number): Promise<AdminOrder | null> {
  const row = await db
    .prepare(
      `SELECT ${ORDER_COLUMNS.split(", ").map((c) => `o.${c}`).join(", ")},
              c.slug AS course_slug, c.title AS course_title, s.name AS student_name, s.phone AS student_phone, k.code AS coupon_code
       FROM orders o JOIN courses c ON c.id = o.course_id JOIN students s ON s.id = o.student_id
       LEFT JOIN coupons k ON k.id = o.coupon_id
       WHERE o.id = ?`,
    )
    .bind(orderId)
    .first<AdminOrderRow>();
  if (!row) return null;
  return {
    ...toOrderSummary(row),
    studentId: row.student_id,
    studentName: row.student_name,
    studentPhoneMasked: maskPhone(row.student_phone),
    batchId: row.batch_id,
    listPricePaise: row.list_price_paise,
    discountPaise: row.discount_paise,
    couponId: row.coupon_id,
    couponCode: row.coupon_code,
    razorpayOrderId: row.razorpay_order_id,
    method: row.method,
    failureReason: row.failure_reason,
    refunds: await listRefunds(db, orderId),
  };
}
