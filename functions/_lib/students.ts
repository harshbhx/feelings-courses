/**
 * The signed-in student's own account (W3): profile, devices and orders. Every function takes the
 * student id from the session, never from the request.
 */
import type { OrderSummary, Student, StudentSession } from "../../src/shared/types.ts";
import { REFUND_WINDOW_SECONDS } from "../../src/shared/constants.ts";
import { auditStatement } from "./db/audit.ts";
import { unixNow, type Db } from "./db/d1.ts";
import { ConflictError, isUniqueViolation, ValidationError } from "./db/errors.ts";
import { batch } from "./db/tx.ts";
import * as v from "./db/validate.ts";

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
 * Updates the student's own name and email. The phone number can't be changed here: it is how
 * the student signs back in, so only the admin changes it. An email that belongs to another
 * student gets one generic answer (409), which never says whose it is.
 */
export async function updateStudent(
  db: Db,
  studentId: number,
  body: Record<string, unknown>,
  now = unixNow(),
): Promise<Student> {
  const current = await getStudent(db, studentId);
  if (!current) throw new ValidationError("student", "No such student.");
  const name = "name" in body ? v.text(body.name, "name", { min: 1, max: 80 }) : current.name;
  const email = "email" in body ? v.optionalEmail(body.email) : current.email;
  if (email === null && current.phone === null) throw new ValidationError("email", "Keep an email or a phone number on your account.");
  if (name === current.name && email === current.email) return current;
  try {
    await batch(db, [
      db
        .prepare("UPDATE students SET name = ?, email = ?, updated_at = ? WHERE id = ? AND erased_at IS NULL")
        .bind(name, email, now, studentId),
      auditStatement(db, {
        actor: `student:${studentId}`,
        action: "student.update_profile",
        entity: "student",
        entityId: studentId,
        data: { name: name !== current.name, email: email !== current.email },
        now,
      }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err, "students.email")) {
      throw new ConflictError("conflict", "That email can't be used on this account. Message us on WhatsApp if it's yours.");
    }
    throw err;
  }
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

/** paidAt + 24 h (the owner's refund window), or null when unpaid. */
export function refundableUntil(paidAt: number | null): number | null {
  return paidAt === null ? null : paidAt + REFUND_WINDOW_SECONDS;
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
