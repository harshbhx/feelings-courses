/**
 * Certificates (plan 1.11). Signature of issueCertificate frozen by W0, bodies by W3.
 *
 * - Code: 10 Crockford base32 characters (crypto.ts randomCrockford), about 50 bits, so codes can't
 *   be guessed; the public check is rate limited per IP as well (RATE_LIMITS.certificate_ip).
 * - Wording comes from courses.certificate_title, never invented: a course without one has no
 *   certificate.
 * - One certificate per student and course. A reissue (a corrected name) replaces name_on_cert,
 *   title and issued_at but keeps the code, so a printed or shared verify link keeps working. It
 *   never clears revoked_at: only the admin decides about a revoked certificate.
 * - The public check shows only the name, the course and the date, and nothing at all for a
 *   revoked certificate or an erased student.
 */
import type { Certificate, CertificateCheck } from "../../src/shared/types.ts";
import { config } from "./config.ts";
import { CROCKFORD, randomCrockford } from "./crypto.ts";
import { auditStatement } from "./db/audit.ts";
import { unixNow, type Db } from "./db/d1.ts";
import { ConflictError, isUniqueViolation, ValidationError } from "./db/errors.ts";
import { batch } from "./db/tx.ts";
import * as v from "./db/validate.ts";
import type { Env } from "./env.ts";

export const CERTIFICATE_CODE_LENGTH = 10;
const CODE_RE = new RegExp(`^[${CROCKFORD}]{${CERTIFICATE_CODE_LENGTH}}$`);

/**
 * A typed or pasted code in canonical form, or null. Crockford decoding: case-insensitive, I and L
 * read as 1, O as 0; spaces and hyphens are ignored ("abcd-efgh-jk").
 */
export function normalizeCertificateCode(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const code = value
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  return CODE_RE.test(code) ? code : null;
}

/** https://<hub>/verify/<code> */
export function verifyUrl(env: Partial<Env>, code: string): string {
  return `${config(env).hubOrigin}/verify/${code}`;
}

interface CertificateRow {
  code: string;
  course_id: number;
  course_title: string;
  name_on_cert: string;
  title: string;
  issued_at: number;
  revoked_at: number | null;
}

const SELECT_CERTIFICATE =
  "SELECT ce.code, ce.course_id, c.title AS course_title, ce.name_on_cert, ce.title, ce.issued_at, ce.revoked_at " +
  "FROM certificates ce JOIN courses c ON c.id = ce.course_id";

function toCertificate(env: Partial<Env>, row: CertificateRow): Certificate {
  return {
    code: row.code,
    courseId: row.course_id,
    courseTitle: row.course_title,
    nameOnCertificate: row.name_on_cert,
    title: row.title,
    issuedAt: row.issued_at,
    revokedAt: row.revoked_at,
    verifyUrl: verifyUrl(env, row.code),
  };
}

/** The student's certificate for the course, or null. */
export async function getCertificate(env: Partial<Env> & { DB: Db }, studentId: number, courseId: number): Promise<Certificate | null> {
  const row = await env.DB.prepare(`${SELECT_CERTIFICATE} WHERE ce.student_id = ? AND ce.course_id = ?`)
    .bind(studentId, courseId)
    .first<CertificateRow>();
  return row ? toCertificate(env, row) : null;
}

/** The name as it may be printed: 2 to 80 characters, one line. */
export function certificateName(value: unknown): string {
  return v.text(value, "nameOnCertificate", { min: 2, max: 80 });
}

/**
 * Issues (or reissues) the student's certificate for the course. Used by the student's own claim
 * (after checking completion) and by the admin (W5). Throws ValidationError for a bad name and
 * ConflictError("no_certificate") when the course has no certificate wording.
 */
export async function issueCertificate(
  env: Env,
  input: { studentId: number; courseId: number; name: string; actor?: string; now?: number },
): Promise<Certificate> {
  const db = env.DB;
  const now = input.now ?? unixNow();
  const studentId = v.id(input.studentId, "studentId");
  const courseId = v.id(input.courseId, "courseId");
  const name = certificateName(input.name);

  const course = await db
    .prepare("SELECT certificate_title FROM courses WHERE id = ? AND deleted_at IS NULL")
    .bind(courseId)
    .first<{ certificate_title: string | null }>();
  const title = course?.certificate_title?.trim();
  if (!title) throw new ConflictError("no_certificate", "This course has no certificate.");
  const student = await db.prepare("SELECT id FROM students WHERE id = ? AND erased_at IS NULL").bind(studentId).first();
  if (!student) throw new ValidationError("studentId", "No such student.");

  // A fresh code for a first issue; ON CONFLICT keeps the existing code on a reissue. A clash with
  // another certificate's code (1 in 2^50 per pair) is retried with a new one.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await batch(db, [
        db
          .prepare(
            "INSERT INTO certificates (code, student_id, course_id, name_on_cert, title, issued_at) VALUES (?, ?, ?, ?, ?, ?) " +
              "ON CONFLICT (student_id, course_id) DO UPDATE SET name_on_cert = excluded.name_on_cert, " +
              "title = excluded.title, issued_at = excluded.issued_at",
          )
          .bind(randomCrockford(CERTIFICATE_CODE_LENGTH), studentId, courseId, name, title, now),
        auditStatement(db, {
          actor: input.actor ?? `student:${studentId}`,
          action: "certificate.issue",
          entity: "student",
          entityId: studentId,
          data: { courseId },
          now,
        }),
      ]);
      break;
    } catch (err) {
      if (attempt < 2 && isUniqueViolation(err, "certificates.code")) continue;
      throw err;
    }
  }
  const certificate = await getCertificate(env, studentId, courseId);
  if (!certificate) throw new Error("issueCertificate: the certificate was not saved");
  return certificate;
}

/** What the public verify page shows: the API's CertificateCheck plus the printable wording. */
export interface CertificateView extends CertificateCheck {
  code: string | null;
  /** courses.certificate_title at issue time. */
  title: string | null;
  teacher: string | null;
  issuedAt: number | null;
}

const NOT_FOUND: CertificateView = {
  valid: false,
  name: null,
  course: null,
  issuedOn: null,
  revoked: false,
  code: null,
  title: null,
  teacher: null,
  issuedAt: null,
};

/** "YYYY-MM-DD" in India time (certificates are dated where the course is taught). */
export function istDate(unix: number): string {
  return new Date((unix + 5.5 * 3600) * 1000).toISOString().slice(0, 10);
}

/** The public check of a certificate code. Unknown, malformed and erased all look the same. */
export async function checkCertificate(db: Db, rawCode: unknown): Promise<CertificateView> {
  const code = normalizeCertificateCode(rawCode);
  if (!code) return NOT_FOUND;
  const row = await db
    .prepare(
      "SELECT ce.code, ce.name_on_cert, ce.title, ce.issued_at, ce.revoked_at, c.title AS course_title, c.teacher " +
        "FROM certificates ce JOIN courses c ON c.id = ce.course_id JOIN students s ON s.id = ce.student_id " +
        "WHERE ce.code = ? AND s.erased_at IS NULL",
    )
    .bind(code)
    .first<{
      code: string;
      name_on_cert: string;
      title: string;
      issued_at: number;
      revoked_at: number | null;
      course_title: string;
      teacher: string;
    }>();
  if (!row) return NOT_FOUND;
  if (row.revoked_at !== null) return { ...NOT_FOUND, revoked: true, code: row.code };
  return {
    valid: true,
    name: row.name_on_cert,
    course: row.course_title,
    issuedOn: istDate(row.issued_at),
    revoked: false,
    code: row.code,
    title: row.title,
    teacher: row.teacher,
    issuedAt: row.issued_at,
  };
}

/** Only the fields of the API contract (GET /api/certificates/:code). */
export function publicCheck(view: CertificateView): CertificateCheck {
  return { valid: view.valid, name: view.name, course: view.course, issuedOn: view.issuedOn, revoked: view.revoked };
}
