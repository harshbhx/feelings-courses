/**
 * Payments in the admin (W5): the orders list with filters, one order with its refunds, the CSV
 * export, and Razorpay webhook events. Refund, sync and webhook replay are W2's (orders.ts); the
 * routes call them after the admin check.
 *
 * Owner decisions: no GSTIN and no tax columns anywhere (the CSV has none either); invoice numbers
 * are shown as W2 assigns them; refundableUntil = paidAt + 24 h (REFUND_WINDOW_SECONDS).
 */
import type { Page } from "../../../src/shared/api.ts";
import { REFUND_WINDOW_SECONDS } from "../../../src/shared/constants.ts";
import type { AdminOrder, OrderStatus, OrderSummary, Refund, WebhookEventRow } from "../../../src/shared/types.ts";
import type { Db, DbValue } from "../db/d1.ts";
import { ValidationError } from "../db/errors.ts";
import { chunked, placeholders } from "../db/tx.ts";
import { rupees, toCsv } from "./csv.ts";
import { NotFoundError, istDateTime, istDayStart, maskPhone } from "./request.ts";

export const ORDER_STATUSES: readonly OrderStatus[] = ["created", "paid", "failed", "partially_refunded", "refunded"];
export const ORDERS_PAGE_SIZE = 25;
export const CSV_MAX_ROWS = 20_000;

export interface OrderRow {
  id: number;
  razorpay_order_id: string | null;
  mode: OrderSummary["mode"];
  student_id: number;
  course_id: number;
  batch_id: number | null;
  payment_kind: OrderSummary["paymentKind"];
  list_price_paise: number;
  discount_paise: number;
  amount_paise: number;
  coupon_id: number | null;
  status: OrderStatus;
  razorpay_payment_id: string | null;
  method: string | null;
  invoice_no: string | null;
  refunded_paise: number;
  failure_reason: string | null;
  created_at: number;
  paid_at: number | null;
  course_slug: string;
  course_title: string;
  student_name: string | null;
  student_phone: string | null;
  coupon_code: string | null;
  batch_title?: string | null;
}

export const ORDER_SELECT =
  "SELECT o.id, o.razorpay_order_id, o.mode, o.student_id, o.course_id, o.batch_id, o.payment_kind, o.list_price_paise, " +
  "o.discount_paise, o.amount_paise, o.coupon_id, o.status, o.razorpay_payment_id, o.method, o.invoice_no, o.refunded_paise, " +
  "o.failure_reason, o.created_at, o.paid_at, c.slug AS course_slug, c.title AS course_title, s.name AS student_name, " +
  "s.phone AS student_phone, cp.code AS coupon_code, b.title AS batch_title " +
  "FROM orders o JOIN courses c ON c.id = o.course_id JOIN students s ON s.id = o.student_id " +
  "LEFT JOIN coupons cp ON cp.id = o.coupon_id LEFT JOIN batches b ON b.id = o.batch_id";

interface RefundRow {
  id: number;
  order_id: number;
  razorpay_refund_id: string | null;
  amount_paise: number;
  status: Refund["status"];
  reason: string | null;
  revoke_access: number;
  created_at: number;
  updated_at: number;
}

export function orderSummary(row: OrderRow): OrderSummary {
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
    refundableUntil: row.paid_at === null ? null : row.paid_at + REFUND_WINDOW_SECONDS,
  };
}

function mapRefund(row: RefundRow): Refund {
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

function adminOrder(row: OrderRow, refunds: Refund[]): AdminOrder {
  return {
    ...orderSummary(row),
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
    refunds,
  };
}

async function refundsFor(db: Db, orderIds: number[]): Promise<Map<number, Refund[]>> {
  const out = new Map<number, Refund[]>();
  for (const ids of chunked(orderIds)) {
    const { results } = await db
      .prepare(
        "SELECT id, order_id, razorpay_refund_id, amount_paise, status, reason, revoke_access, created_at, updated_at " +
          `FROM refunds WHERE order_id IN (${placeholders(ids.length)}) ORDER BY id`,
      )
      .bind(...ids)
      .all<RefundRow>();
    for (const row of results) {
      const list = out.get(row.order_id) ?? [];
      list.push(mapRefund(row));
      out.set(row.order_id, list);
    }
  }
  return out;
}

export interface OrderFilters {
  status: OrderStatus | null;
  course: number | null;
  /** India-time days, inclusive. */
  from: string | null;
  to: string | null;
  studentId?: number | null;
}

function orderWhere(filters: OrderFilters): { sql: string; params: DbValue[] } {
  if (filters.from && filters.to && filters.from > filters.to) throw new ValidationError("from", "from must be on or before to.");
  const where: string[] = [];
  const params: DbValue[] = [];
  if (filters.status) {
    where.push("o.status = ?");
    params.push(filters.status);
  }
  if (filters.course !== null) {
    where.push("o.course_id = ?");
    params.push(filters.course);
  }
  if (filters.studentId) {
    where.push("o.student_id = ?");
    params.push(filters.studentId);
  }
  if (filters.from) {
    where.push("o.created_at >= ?");
    params.push(istDayStart(filters.from));
  }
  if (filters.to) {
    where.push("o.created_at < ?");
    params.push(istDayStart(filters.to) + 86_400);
  }
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

export async function listOrders(db: Db, filters: OrderFilters, page: number): Promise<Page<AdminOrder>> {
  const { sql, params } = orderWhere(filters);
  const offset = (page - 1) * ORDERS_PAGE_SIZE;
  const [rows, total] = await Promise.all([
    db
      .prepare(`${ORDER_SELECT}${sql} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`)
      .bind(...params, ORDERS_PAGE_SIZE, offset)
      .all<OrderRow>(),
    db.prepare(`SELECT count(*) AS n FROM orders o${sql}`).bind(...params).first<{ n: number }>(),
  ]);
  const refunds = rows.results.length ? await refundsFor(db, rows.results.map((r) => r.id)) : new Map<number, Refund[]>();
  return {
    items: rows.results.map((row) => adminOrder(row, refunds.get(row.id) ?? [])),
    page,
    pageSize: ORDERS_PAGE_SIZE,
    total: total?.n ?? 0,
  };
}

export async function getOrder(db: Db, id: number): Promise<AdminOrder> {
  const row = await db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).bind(id).first<OrderRow>();
  if (!row) throw new NotFoundError("That order doesn't exist.");
  const refunds = await refundsFor(db, [id]);
  return adminOrder(row, refunds.get(id) ?? []);
}

/** A student's orders, newest first (for the student detail). */
export async function ordersOfStudent(db: Db, studentId: number): Promise<OrderSummary[]> {
  const { results } = await db
    .prepare(`${ORDER_SELECT} WHERE o.student_id = ? ORDER BY o.created_at DESC, o.id DESC`)
    .bind(studentId)
    .all<OrderRow>();
  return results.map(orderSummary);
}

/**
 * The payments export. Full phone numbers (it is the owner's own record), amounts in rupees, India
 * time. No GSTIN and no tax columns (owner decision).
 */
export async function ordersCsv(db: Db, filters: OrderFilters): Promise<string> {
  const { sql, params } = orderWhere(filters);
  const { results } = await db
    .prepare(`${ORDER_SELECT}${sql} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`)
    .bind(...params, CSV_MAX_ROWS)
    .all<OrderRow>();
  return toCsv(
    [
      "Order",
      "Invoice no",
      "Created (IST)",
      "Paid (IST)",
      "Status",
      "Mode",
      "Course",
      "Batch",
      "Student",
      "Phone",
      "List price (Rs)",
      "Discount (Rs)",
      "Coupon",
      "Amount (Rs)",
      "Refunded (Rs)",
      "Method",
      "Razorpay payment",
      "Razorpay order",
    ],
    results.map((r) => [
      r.id,
      r.invoice_no,
      istDateTime(r.created_at),
      istDateTime(r.paid_at),
      r.status,
      r.mode,
      r.course_title,
      r.batch_title ?? "",
      r.student_name,
      r.student_phone,
      rupees(r.list_price_paise),
      rupees(r.discount_paise),
      r.coupon_code,
      rupees(r.amount_paise),
      rupees(r.refunded_paise),
      r.method,
      r.razorpay_payment_id,
      r.razorpay_order_id,
    ]),
  );
}

// ---------------------------------------------------------------- webhooks

export async function listWebhooks(db: Db, pendingOnly: boolean): Promise<WebhookEventRow[]> {
  const { results } = await db
    .prepare(
      "SELECT event_id, type, mode, received_at, processed_at, error FROM webhook_events" +
        (pendingOnly ? " WHERE processed_at IS NULL" : "") +
        " ORDER BY received_at DESC LIMIT 200",
    )
    .all<{ event_id: string; type: string; mode: WebhookEventRow["mode"]; received_at: number; processed_at: number | null; error: string | null }>();
  return results.map((r) => ({
    eventId: r.event_id,
    type: r.type,
    mode: r.mode,
    receivedAt: r.received_at,
    processedAt: r.processed_at,
    error: r.error,
  }));
}

/** A webhook event id from a path: Razorpay's are like "evt_…"; anything else is a 404. */
export async function webhookExists(db: Db, raw: string | string[] | undefined): Promise<string> {
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,100}$/.test(id)) throw new NotFoundError("That webhook event doesn't exist.");
  const row = await db.prepare("SELECT event_id FROM webhook_events WHERE event_id = ?").bind(id).first();
  if (!row) throw new NotFoundError("That webhook event doesn't exist.");
  return id;
}
