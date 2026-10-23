/**
 * The signed-in student's own account (W3): profile, devices and orders. Every function takes the
 * student id from the session, never from the request.
 */
import type { OrderSummary, Student, StudentSession } from "../../src/shared/types.ts";
import { auditStatement } from "./db/audit.ts";
import { unixNow, type Db } from "./db/d1.ts";
import { ValidationError } from "./db/errors.ts";
import { batch } from "./db/tx.ts";
import * as v from "./db/validate.ts";
import { refundableUntil } from "./orders.ts"; // W2: paidAt + 24 h, one definition

interface StudentRow {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  state_code: string | null;
  created_at: number;
}

function toStudent(row: StudentRow): Student {
  return { id: row.id, name: row.name, phone: row.phone, email: row.email, stateCode: row.state_code, createdAt: row.created_at };
}

/** The student, or null when missing or erased. */
export async function getStudent(db: Db, studentId: number): Promise<Student | null> {
  const row = await db
    .prepare("SELECT id, name, phone, email, state_code, created_at FROM students WHERE id = ? AND erased_at IS NULL")
    .bind(studentId)
    .first<StudentRow>();
  return row ? toStudent(row) : null;
}

/**
 * Updates the student's own name. The email can't be changed here: it is who the student is and
 * how they sign in, so a change goes through the admin (Urmi checks it's really them). The phone
 * number is a contact detail the admin keeps.
 */
export async function updateStudent(
  db: Db,
  studentId: number,
  body: Record<string, unknown>,
  now = unixNow(),
): Promise<Student> {
  const current = await getStudent(db, studentId);
  if (!current) throw new ValidationError("student", "No such student.");
  if ("email" in body && body.email !== current.email) {
    throw new ValidationError("email", "To change your email, message us on WhatsApp.");
  }
  const name = "name" in body ? v.text(body.name, "name", { min: 1, max: 80 }) : current.name;
  if (name === current.name) return current;
  await batch(db, [
    db.prepare("UPDATE students SET name = ?, updated_at = ? WHERE id = ? AND erased_at IS NULL").bind(name, now, studentId),
    auditStatement(db, {
      actor: `student:${studentId}`,
      action: "student.update_profile",
      entity: "student",
      entityId: studentId,
      data: { name: true },
      now,
    }),
  ]);
  return (await getStudent(db, studentId)) ?? current;
}

/** The student's signed-in devices (live sessions), newest first. */
export async function listSessions(db: Db, studentId: number, currentSessionId: number | null, now = unixNow()): Promise<StudentSession[]> {
  const { results } = await db
    .prepare(
      "SELECT id, created_at, last_seen_at, expires_at, user_agent FROM sessions " +
        "WHERE student_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC, id DESC",
    )
    .bind(studentId, now)
    .all<{ id: number; created_at: number; last_seen_at: number; expires_at: number; user_agent: string | null }>();
  return results.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    userAgent: row.user_agent,
    current: row.id === currentSessionId,
  }));
}

/** A short device name from a User-Agent, for the devices list ("Chrome on Android"). */
export function deviceLabel(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iPhone or iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Linux|CrOS/.test(ua)
            ? "Linux"
            : null;
  const browser = /Instagram/.test(ua)
    ? "Instagram"
    : /FBAN|FBAV/.test(ua)
      ? "Facebook"
      : /Edg\//.test(ua)
        ? "Edge"
        : /SamsungBrowser/.test(ua)
          ? "Samsung Internet"
          : /Firefox|FxiOS/.test(ua)
            ? "Firefox"
            : /Chrome|CriOS/.test(ua)
              ? "Chrome"
              : /Safari/.test(ua)
                ? "Safari"
                : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

interface OrderRow {
  id: number;
  course_id: number;
  slug: string;
  title: string;
  status: OrderSummary["status"];
  mode: OrderSummary["mode"];
  payment_kind: OrderSummary["paymentKind"];
  amount_paise: number;
  refunded_paise: number;
  razorpay_payment_id: string | null;
  invoice_no: string | null;
  created_at: number;
  paid_at: number | null;
}


/** The student's payments (paid or refunded; unfinished checkouts are left out), newest first. */
export async function listOrders(db: Db, studentId: number): Promise<OrderSummary[]> {
  const { results } = await db
    .prepare(
      "SELECT o.id, o.course_id, c.slug, c.title, o.status, o.mode, o.payment_kind, o.amount_paise, o.refunded_paise, " +
        "o.razorpay_payment_id, o.invoice_no, o.created_at, o.paid_at FROM orders o JOIN courses c ON c.id = o.course_id " +
        "WHERE o.student_id = ? AND o.status IN ('paid', 'partially_refunded', 'refunded') ORDER BY o.paid_at DESC, o.id DESC",
    )
    .bind(studentId)
    .all<OrderRow>();
  return results.map((row) => ({
    id: row.id,
    courseId: row.course_id,
    courseSlug: row.slug,
    courseTitle: row.title,
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
  }));
}
