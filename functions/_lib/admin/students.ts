/**
 * Students in the admin (W5): search and list, one student in full, add a student by hand, grant
 * and revoke course access, sign a student out everywhere, erase (DPDP) and the CSV export.
 *
 * - Lists mask phone numbers ("+91 ••••• •1578"); the detail view and the owner's CSV export show
 *   them in full.
 * - A manual grant is an enrollment with source 'manual'. Its mode is 'live', because it is real
 *   access and not a test payment (W3 treats test-mode enrollments as inactive once payments are
 *   live). Expiry defaults to the course's access_days (365 by the owner's decision).
 * - Erase keeps orders (amounts are business records) but removes the student's name, phone and
 *   email everywhere they are stored, ends their sessions and access, and withdraws certificates.
 */
import type { AdminAccessLinkResponse, Page } from "../../../src/shared/api.ts";
import type {
  AdminStudent,
  AdminStudentRow,
  Certificate,
  EnrollmentSummary,
  StudentSession,
} from "../../../src/shared/types.ts";
import { DAY, LOGIN_TOKEN_TTL } from "../config.ts";
import { auditStatement } from "../db/audit.ts";
import type { Db, DbValue } from "../db/d1.ts";
import { ConflictError, ValidationError, isUniqueViolation } from "../db/errors.ts";
import { batch } from "../db/tx.ts";
import * as v from "../db/validate.ts";
import { issueLoginToken } from "../session.ts";
import { ADMIN_ACTOR } from "./auth.ts";
import { courseRow, takesBatches } from "./courses.ts";
import { rupees, toCsv } from "./csv.ts";
import { ordersOfStudent } from "./orders.ts";
import { NotFoundError, istDateTime, maskPhone } from "./request.ts";

export const STUDENTS_PAGE_SIZE = 25;
export const STUDENTS_CSV_MAX_ROWS = 20_000;
/** Where an access link lands after sign-in. */
export const ACCESS_LINK_LANDING = "/account";

// ---------------------------------------------------------------- list and search

export interface StudentFilters {
  q: string | null;
  course: number | null;
}

interface StudentListRow {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  created_at: number;
  erased_at: number | null;
  enrollments: number;
  paid: number;
  last_seen: number | null;
}

function studentWhere(filters: StudentFilters): { sql: string; params: DbValue[] } {
  const where: string[] = [];
  const params: DbValue[] = [];
  const pattern = v.likePattern(filters.q, "q");
  if (pattern !== null) {
    // Phone numbers are stored as +91XXXXXXXXXX: search them by digits, however they were typed.
    const digits = (filters.q ?? "").replace(/\D/g, "");
    const phonePattern = digits.length >= 3 ? `%${digits}%` : pattern;
    where.push("(s.name LIKE ? ESCAPE '\\' OR s.email LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern, phonePattern);
  }
  if (filters.course !== null) {
    where.push("EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = s.id AND e.course_id = ?)");
    params.push(filters.course);
  }
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

/** Counts paid money once refunds are taken off; test payments don't count once the site is live. */
function studentSelect(live: boolean): string {
  return (
    "SELECT s.id, s.name, s.phone, s.email, s.created_at, s.erased_at, " +
    "(SELECT count(*) FROM enrollments e WHERE e.student_id = s.id AND e.revoked_at IS NULL) AS enrollments, " +
    "(SELECT COALESCE(SUM(o.amount_paise - o.refunded_paise), 0) FROM orders o WHERE o.student_id = s.id " +
    `AND o.status IN ('paid', 'partially_refunded', 'refunded')${live ? " AND o.mode = 'live'" : ""}) AS paid, ` +
    "(SELECT MAX(x.last_seen_at) FROM sessions x WHERE x.student_id = s.id) AS last_seen " +
    "FROM students s"
  );
}

export async function listStudents(db: Db, filters: StudentFilters, page: number, live: boolean): Promise<Page<AdminStudentRow>> {
  const { sql, params } = studentWhere(filters);
  const [rows, total] = await Promise.all([
    db
      .prepare(`${studentSelect(live)}${sql} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`)
      .bind(...params, STUDENTS_PAGE_SIZE, (page - 1) * STUDENTS_PAGE_SIZE)
      .all<StudentListRow>(),
    db.prepare(`SELECT count(*) AS n FROM students s${sql}`).bind(...params).first<{ n: number }>(),
  ]);
  return {
    items: rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      phoneMasked: maskPhone(r.phone),
      email: r.email,
      enrollments: r.enrollments,
      paidPaise: r.paid,
      lastSeenAt: r.last_seen,
      createdAt: r.created_at,
      erased: r.erased_at !== null,
    })),
    page,
    pageSize: STUDENTS_PAGE_SIZE,
    total: total?.n ?? 0,
  };
}

export async function studentsCsv(db: Db, filters: StudentFilters, live: boolean): Promise<string> {
  const { sql, params } = studentWhere(filters);
  const { results } = await db
    .prepare(`${studentSelect(live)}${sql} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`)
    .bind(...params, STUDENTS_CSV_MAX_ROWS)
    .all<StudentListRow>();
  return toCsv(
    ["Student", "Name", "Phone", "Email", "Courses", "Paid (Rs)", "Joined (IST)", "Last seen (IST)", "Erased"],
    results.map((r) => [
      r.id,
      r.name,
      r.phone,
      r.email,
      r.enrollments,
      rupees(r.paid),
      istDateTime(r.created_at),
      istDateTime(r.last_seen),
      r.erased_at === null ? "" : "yes",
    ]),
  );
}

// ---------------------------------------------------------------- one student

interface StudentRow {
  id: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  state_code: string | null;
  created_at: number;
  erased_at: number | null;
}

async function studentRow(db: Db, id: number): Promise<StudentRow> {
  const row = await db
    .prepare("SELECT id, name, phone, email, state_code, created_at, erased_at FROM students WHERE id = ?")
    .bind(id)
    .first<StudentRow>();
  if (!row) throw new NotFoundError("That student doesn't exist.");
  return row;
}

interface EnrollmentRow {
  id: number;
  course_id: number;
  slug: string;
  title: string;
  format: EnrollmentSummary["format"];
  batch_id: number | null;
  batch_title: string | null;
  starts_on: string | null;
  ends_on: string | null;
  schedule_text: string | null;
  source: EnrollmentSummary["source"];
  mode: EnrollmentSummary["mode"];
  starts_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  completed_at: number | null;
  total_lessons: number;
  completed_lessons: number;
}

const ENROLLMENT_SELECT =
  "SELECT e.id, e.course_id, c.slug, c.title, c.format, e.batch_id, b.title AS batch_title, b.starts_on, b.ends_on, " +
  "b.schedule_text, e.source, e.mode, e.starts_at, e.expires_at, e.revoked_at, e.completed_at, " +
  "(SELECT count(*) FROM lessons l WHERE l.course_id = e.course_id) AS total_lessons, " +
  "(SELECT count(*) FROM lessons l JOIN lesson_progress p ON p.lesson_id = l.id AND p.student_id = e.student_id " +
  " WHERE l.course_id = e.course_id AND p.completed_at IS NOT NULL) AS completed_lessons " +
  "FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN batches b ON b.id = e.batch_id";

/** Same rule as W3's session.ts enrollmentActive: not revoked, not expired, not test-mode on a live site. */
export function enrollmentActive(row: { revoked_at: number | null; expires_at: number | null; mode: string }, now: number, live: boolean): boolean {
  if (row.revoked_at !== null) return false;
  if (row.expires_at !== null && row.expires_at <= now) return false;
  return !(live && row.mode === "test");
}

function mapEnrollment(row: EnrollmentRow, now: number, live: boolean): EnrollmentSummary {
  return {
    id: row.id,
    courseId: row.course_id,
    courseSlug: row.slug,
    courseTitle: row.title,
    format: row.format,
    batch:
      row.batch_id === null || row.batch_title === null || row.starts_on === null
        ? null
        : { id: row.batch_id, title: row.batch_title, startsOn: row.starts_on, endsOn: row.ends_on, scheduleText: row.schedule_text },
    source: row.source,
    mode: row.mode,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    completedAt: row.completed_at,
    active: enrollmentActive(row, now, live),
    completedLessons: row.completed_lessons,
    totalLessons: row.total_lessons,
  };
}

export async function getEnrollment(db: Db, id: number, now: number, live: boolean): Promise<EnrollmentSummary> {
  const row = await db.prepare(`${ENROLLMENT_SELECT} WHERE e.id = ?`).bind(id).first<EnrollmentRow>();
  if (!row) throw new NotFoundError("That enrollment doesn't exist.");
  return mapEnrollment(row, now, live);
}

export async function getStudent(db: Db, id: number, opts: { now: number; live: boolean; hubOrigin: string }): Promise<AdminStudent> {
  const student = await studentRow(db, id);
  const [enrollments, orders, sessions, certificates] = await Promise.all([
    db.prepare(`${ENROLLMENT_SELECT} WHERE e.student_id = ? ORDER BY e.created_at DESC, e.id DESC`).bind(id).all<EnrollmentRow>(),
    ordersOfStudent(db, id),
    db
      .prepare(
        "SELECT id, created_at, last_seen_at, expires_at, user_agent FROM sessions " +
          "WHERE student_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC",
      )
      .bind(id, opts.now)
      .all<{ id: number; created_at: number; last_seen_at: number; expires_at: number; user_agent: string | null }>(),
    db
      .prepare(
        "SELECT x.code, x.course_id, c.title AS course_title, x.name_on_cert, x.title, x.issued_at, x.revoked_at " +
          "FROM certificates x JOIN courses c ON c.id = x.course_id WHERE x.student_id = ? ORDER BY x.issued_at DESC",
      )
      .bind(id)
      .all<{ code: string; course_id: number; course_title: string; name_on_cert: string; title: string; issued_at: number; revoked_at: number | null }>(),
  ]);
  return {
    id: student.id,
    name: student.name,
    phone: student.phone,
    email: student.email,
    stateCode: student.state_code,
    createdAt: student.created_at,
    erasedAt: student.erased_at,
    enrollments: enrollments.results.map((r) => mapEnrollment(r, opts.now, opts.live)),
    orders,
    sessions: sessions.results.map(
      (r): StudentSession => ({
        id: r.id,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        expiresAt: r.expires_at,
        userAgent: r.user_agent,
        current: false,
      }),
    ),
    certificates: certificates.results.map(
      (r): Certificate => ({
        code: r.code,
        courseId: r.course_id,
        courseTitle: r.course_title,
        nameOnCertificate: r.name_on_cert,
        title: r.title,
        issuedAt: r.issued_at,
        revokedAt: r.revoked_at,
        verifyUrl: `${opts.hubOrigin}/verify/${r.code}`,
      }),
    ),
  };
}

// ---------------------------------------------------------------- grants

interface GrantPlan {
  courseId: number;
  batchId: number | null;
  expiresAt: number | null;
}

/**
 * Checks a grant: the course exists, the batch belongs to it, isn't cancelled and has a seat, and
 * the expiry is in the future. `expiresAt` omitted = the course's access_days; null = never.
 */
async function planGrant(db: Db, input: Record<string, unknown>, now: number): Promise<GrantPlan> {
  const courseId = v.id(input.courseId, "courseId");
  const course = await courseRow(db, courseId).catch(() => {
    throw new ValidationError("courseId", "That course doesn't exist.");
  });
  let batchId: number | null = null;
  if (!v.isMissing(input.batchId)) {
    batchId = v.id(input.batchId, "batchId");
    if (!takesBatches(course.format)) throw new ValidationError("batchId", "This course has no batches.");
    const b = await db
      .prepare("SELECT status, seats, seats_taken FROM batches WHERE id = ? AND course_id = ?")
      .bind(batchId, courseId)
      .first<{ status: string; seats: number | null; seats_taken: number }>();
    if (!b) throw new ValidationError("batchId", "That batch isn't part of this course.");
    if (b.status === "cancelled") throw new ValidationError("batchId", "That batch is cancelled.");
    if (b.seats !== null && b.seats_taken >= b.seats) throw new ConflictError("batch_full", "That batch is full. Add seats to it first.");
  }
  let expiresAt: number | null;
  if (input.expiresAt === undefined) {
    expiresAt = course.access_days === null ? null : now + course.access_days * DAY;
  } else if (input.expiresAt === null) {
    expiresAt = null;
  } else {
    expiresAt = v.timestamp(input.expiresAt, "expiresAt");
    if (expiresAt <= now) throw new ValidationError("expiresAt", "The access end date must be in the future.");
  }
  return { courseId, batchId, expiresAt };
}

/** Takes a seat in the batch, inside the grant's batch. */
function seatStatement(db: Db, batchId: number | null, now: number) {
  return batchId !== null && db.prepare("UPDATE batches SET seats_taken = seats_taken + 1, updated_at = ? WHERE id = ?").bind(now, batchId);
}

/**
 * Gives a student access to a course. A revoked or expired enrollment is reopened (same row: the
 * schema allows one per student and course); an active one is a 409 already_enrolled.
 */
export async function grantAccess(
  db: Db,
  studentId: number,
  input: Record<string, unknown>,
  opts: { now: number; live: boolean },
): Promise<EnrollmentSummary> {
  const { now, live } = opts;
  const student = await studentRow(db, studentId);
  if (student.erased_at !== null) throw new ConflictError("conflict", "This student's details were erased.");
  const plan = await planGrant(db, input, now);
  const existing = await db
    .prepare("SELECT id, revoked_at, expires_at, mode, batch_id FROM enrollments WHERE student_id = ? AND course_id = ?")
    .bind(studentId, plan.courseId)
    .first<{ id: number; revoked_at: number | null; expires_at: number | null; mode: string; batch_id: number | null }>();
  if (existing && enrollmentActive(existing, now, live)) {
    throw new ConflictError("already_enrolled", "This student already has access to this course.");
  }
  const data = { courseId: plan.courseId, batchId: plan.batchId, expiresAt: plan.expiresAt, reopened: Boolean(existing) };
  if (existing) {
    // An expired (not revoked) enrollment still holds its batch seat: keep it if the batch is the
    // same, otherwise give the old seat back and take the new one.
    const holdsSeat = existing.revoked_at === null && existing.batch_id !== null;
    const sameBatch = holdsSeat && existing.batch_id === plan.batchId;
    await batch(db, [
      holdsSeat &&
        !sameBatch &&
        db
          .prepare("UPDATE batches SET seats_taken = seats_taken - 1, updated_at = ? WHERE id = ? AND seats_taken > 0")
          .bind(now, existing.batch_id),
      !sameBatch && seatStatement(db, plan.batchId, now),
      db
        .prepare(
          "UPDATE enrollments SET revoked_at = NULL, batch_id = ?, mode = 'live', starts_at = ?, expires_at = ?, updated_at = ? WHERE id = ?",
        )
        .bind(plan.batchId, now, plan.expiresAt, now, existing.id),
      auditStatement(db, { actor: ADMIN_ACTOR, action: "enrollment.grant", entity: "enrollment", entityId: existing.id, data, now }),
    ]);
    return getEnrollment(db, existing.id, now, live);
  }
  const results = await batch(db, [
    seatStatement(db, plan.batchId, now),
    db
      .prepare(
        "INSERT INTO enrollments (student_id, course_id, batch_id, source, mode, starts_at, expires_at, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'manual', 'live', ?, ?, ?, ?) RETURNING id",
      )
      .bind(studentId, plan.courseId, plan.batchId, now, plan.expiresAt, now, now),
  ]);
  const id = (results[results.length - 1]!.results[0] as { id: number }).id;
  await auditStatement(db, { actor: ADMIN_ACTOR, action: "enrollment.grant", entity: "enrollment", entityId: id, data: { ...data, studentId }, now }).run();
  return getEnrollment(db, id, now, live);
}

/** Ends access now (DELETE /api/admin/enrollments/:id). Frees the batch seat. Idempotent. */
export async function revokeEnrollment(db: Db, id: number, now: number): Promise<void> {
  const row = await db
    .prepare("SELECT id, student_id, course_id, batch_id, revoked_at FROM enrollments WHERE id = ?")
    .bind(id)
    .first<{ id: number; student_id: number; course_id: number; batch_id: number | null; revoked_at: number | null }>();
  if (!row) throw new NotFoundError("That enrollment doesn't exist.");
  if (row.revoked_at !== null) return;
  await batch(db, [
    row.batch_id !== null &&
      db
        .prepare(
          "UPDATE batches SET seats_taken = seats_taken - 1, updated_at = ? WHERE id = ? AND seats_taken > 0 " +
            "AND EXISTS (SELECT 1 FROM enrollments WHERE id = ? AND revoked_at IS NULL)",
        )
        .bind(now, row.batch_id, id),
    db.prepare("UPDATE enrollments SET revoked_at = ?, updated_at = ? WHERE id = ? AND revoked_at IS NULL").bind(now, now, id),
    auditStatement(db, {
      actor: ADMIN_ACTOR,
      action: "enrollment.revoke",
      entity: "enrollment",
      entityId: id,
      data: { studentId: row.student_id, courseId: row.course_id },
      now,
    }),
  ]);
}

// ---------------------------------------------------------------- add, sign out, erase

/** Adds a student by hand (someone who paid at the studio), optionally with access right away. */
export async function addStudent(
  db: Db,
  input: Record<string, unknown>,
  opts: { now: number; live: boolean; hubOrigin: string },
): Promise<AdminStudent> {
  const { now } = opts;
  const name = v.text(input.name, "name", { max: 80 });
  const phone = v.phone(input.phone, "phone");
  const email = v.optionalEmail(input.email, "email");
  const grant = v.isMissing(input.courseId) ? null : await planGrant(db, input, now);

  const clash = await db
    .prepare("SELECT id FROM students WHERE phone = ? OR (? IS NOT NULL AND email = ?)")
    .bind(phone, email, email)
    .first<{ id: number }>();
  if (clash) throw new ConflictError("student_exists", `A student with this phone or email already exists (#${clash.id}).`);

  let id: number;
  try {
    const results = await batch(db, [
      db
        .prepare("INSERT INTO students (name, phone, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id")
        .bind(name, phone, email, now, now),
      grant && seatStatement(db, grant.batchId, now),
      grant &&
        db
          .prepare(
            "INSERT INTO enrollments (student_id, course_id, batch_id, source, mode, starts_at, expires_at, created_at, updated_at) " +
              "VALUES ((SELECT id FROM students WHERE phone = ?), ?, ?, 'manual', 'live', ?, ?, ?, ?)",
          )
          .bind(phone, grant.courseId, grant.batchId, now, grant.expiresAt, now, now),
    ]);
    id = (results[0]!.results[0] as { id: number }).id;
  } catch (err) {
    if (isUniqueViolation(err, "students.")) throw new ConflictError("student_exists", "A student with this phone or email already exists.");
    throw err;
  }
  await auditStatement(db, {
    actor: ADMIN_ACTOR,
    action: "student.add",
    entity: "student",
    entityId: id,
    data: grant ? { courseId: grant.courseId, batchId: grant.batchId, expiresAt: grant.expiresAt } : {},
    now,
  }).run();
  return getStudent(db, id, opts);
}

/** Ends every signed-in device of the student (lost phone, shared login). */
export async function signOutEverywhere(db: Db, id: number, now: number): Promise<number> {
  await studentRow(db, id);
  const [result] = await batch(db, [
    db.prepare("UPDATE sessions SET revoked_at = ? WHERE student_id = ? AND revoked_at IS NULL").bind(now, id),
    auditStatement(db, { actor: ADMIN_ACTOR, action: "student.signout_all", entity: "student", entityId: id, now }),
  ]);
  return result?.meta.changes ?? 0;
}

/**
 * DPDP erase. Keeps the orders' amounts and invoice numbers (business records) but removes the
 * person: name, phone, email and state on the student; the contact Razorpay collected on orders;
 * sessions and login links; access; and certificates are withdrawn with the name removed.
 */
export async function eraseStudent(db: Db, id: number, opts: { now: number; live: boolean; hubOrigin: string }): Promise<AdminStudent> {
  const { now } = opts;
  const student = await studentRow(db, id);
  if (student.erased_at === null) {
    await batch(db, [
      db
        .prepare("UPDATE students SET name = NULL, phone = NULL, email = NULL, state_code = NULL, erased_at = ?, updated_at = ? WHERE id = ?")
        .bind(now, now, id),
      db.prepare("UPDATE orders SET payer_contact = NULL, payer_email = NULL, updated_at = ? WHERE student_id = ?").bind(now, id),
      db.prepare("UPDATE sessions SET revoked_at = ? WHERE student_id = ? AND revoked_at IS NULL").bind(now, id),
      db.prepare("DELETE FROM login_tokens WHERE student_id = ?").bind(id),
      db
        .prepare(
          "UPDATE batches SET seats_taken = seats_taken - 1, updated_at = ? WHERE seats_taken > 0 AND id IN " +
            "(SELECT batch_id FROM enrollments WHERE student_id = ? AND revoked_at IS NULL AND batch_id IS NOT NULL)",
        )
        .bind(now, id),
      db.prepare("UPDATE enrollments SET revoked_at = ?, updated_at = ? WHERE student_id = ? AND revoked_at IS NULL").bind(now, now, id),
      db
        .prepare("UPDATE certificates SET name_on_cert = 'Erased', revoked_at = COALESCE(revoked_at, ?) WHERE student_id = ?")
        .bind(now, id),
      auditStatement(db, { actor: ADMIN_ACTOR, action: "student.erase", entity: "student", entityId: id, now }),
    ]);
  }
  return getStudent(db, id, opts);
}

// ---------------------------------------------------------------- access link (no email: WhatsApp)

/** The message the admin sends on WhatsApp with the link. */
export function accessLinkMessage(name: string | null, url: string): string {
  const hello = name ? `Hi ${name.split(" ")[0]},` : "Hi,";
  return (
    `${hello} here is your link to open your Feelings Beauty Care course on this phone:\n${url}\n\n` +
    "It works once and expires in 24 hours. Please don't share it."
  );
}

/**
 * A one-time sign-in link for a student, sent by the admin on WhatsApp (plan 1.4). W3's
 * issueLoginToken makes the token (single use, 24 h). Until W3 lands it is a stub (501).
 */
export async function createAccessLink(db: Db, id: number, opts: { now: number; hubOrigin: string }): Promise<AdminAccessLinkResponse> {
  const student = await studentRow(db, id);
  if (student.erased_at !== null) throw new ConflictError("conflict", "This student's details were erased.");
  const token = await issueLoginToken(db, id, "admin_link", ACCESS_LINK_LANDING);
  await auditStatement(db, { actor: ADMIN_ACTOR, action: "student.access_link", entity: "student", entityId: id, now: opts.now }).run();
  const url = `${opts.hubOrigin}/auth/continue?t=${encodeURIComponent(token)}`;
  const digits = student.phone?.replace(/\D/g, "") ?? "";
  return {
    url,
    whatsappUrl: `https://wa.me/${digits}?text=${encodeURIComponent(accessLinkMessage(student.name, url))}`,
    expiresAt: opts.now + LOGIN_TOKEN_TTL.admin_link,
  };
}

/** The student must exist and not be erased (certificate issue). */
export async function requireStudent(db: Db, id: number): Promise<void> {
  const student = await studentRow(db, id);
  if (student.erased_at !== null) throw new ConflictError("conflict", "This student's details were erased.");
}
