/**
 * The course area's data (W3): a student's enrollments, the course outline with their progress,
 * saving progress, course completion and the certificate claim.
 *
 * Access is decided only here and in session.ts (enrollmentActive): an enrollment gives access
 * while it is not revoked, not expired (1 year from purchase unless the admin set otherwise), and
 * not a test-mode one while the site takes live payments. Every function takes the student id
 * from the session, never from the request body.
 */
import type { LearnCourseResponse, ProgressResponse } from "../../src/shared/api.ts";
import type { Certificate, CourseFormat, EnrollmentBatch, EnrollmentSummary, LearnModule } from "../../src/shared/types.ts";
import { certificateName, getCertificate, issueCertificate } from "./certificates.ts";
import { config } from "./config.ts";
import { unixNow, type Db } from "./db/d1.ts";
import { ValidationError } from "./db/errors.ts";
import { batch } from "./db/tx.ts";
import type { Env } from "./env.ts";
import { enrollmentActive } from "./session.ts";

/** Longest position a progress save accepts when the lesson's duration is unknown (6 hours). */
export const MAX_POSITION_SECONDS = 6 * 3600;

function liveMode(env: Partial<Env>): boolean {
  return config(env).paymentMode === "live";
}

// ---------------------------------------------------------------- enrollments

interface EnrollmentListRow {
  id: number;
  course_id: number;
  slug: string;
  title: string;
  format: CourseFormat;
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
  "FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN batches b ON b.id = e.batch_id " +
  "WHERE e.student_id = ? AND c.deleted_at IS NULL";

function toBatch(row: EnrollmentListRow): EnrollmentBatch | null {
  if (row.batch_id === null || row.batch_title === null || row.starts_on === null) return null;
  return { id: row.batch_id, title: row.batch_title, startsOn: row.starts_on, endsOn: row.ends_on, scheduleText: row.schedule_text };
}

function toSummary(row: EnrollmentListRow, now: number, live: boolean): EnrollmentSummary {
  return {
    id: row.id,
    courseId: row.course_id,
    courseSlug: row.slug,
    courseTitle: row.title,
    format: row.format,
    batch: toBatch(row),
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

/** Every enrollment of the student (active first, then newest), for /account and GET /api/me. */
export async function listEnrollments(env: Partial<Env> & { DB: Db }, studentId: number, now = unixNow()): Promise<EnrollmentSummary[]> {
  const { results } = await env.DB.prepare(`${ENROLLMENT_SELECT} ORDER BY e.created_at DESC, e.id DESC`)
    .bind(studentId)
    .all<EnrollmentListRow>();
  const live = liveMode(env);
  const list = results.map((row) => toSummary(row, now, live));
  return [...list.filter((e) => e.active), ...list.filter((e) => !e.active)];
}

// ---------------------------------------------------------------- the course outline

interface LessonRow {
  id: number;
  module_id: number;
  slug: string;
  title: string;
  minutes: number;
  free_preview: number;
  vertical: number;
  video_provider: string;
  duration_seconds: number | null;
  notes: string | null;
  position_seconds: number | null;
  completed_at: number | null;
  has_progress: number | null;
}

/**
 * The course area for one course: outline, progress, enrollment, batch and certificate. null when
 * the course doesn't exist or the student has no active enrollment in it (callers answer 403/404
 * without saying which).
 */
export async function loadLearnCourse(
  env: Partial<Env> & { DB: Db },
  studentId: number,
  courseSlug: string,
  now = unixNow(),
): Promise<LearnCourseResponse | null> {
  const db = env.DB;
  const enrollmentRow = await db
    .prepare(`${ENROLLMENT_SELECT} AND c.slug = ?`)
    .bind(studentId, courseSlug)
    .first<EnrollmentListRow>();
  if (!enrollmentRow) return null;
  const enrollment = toSummary(enrollmentRow, now, liveMode(env));
  if (!enrollment.active) return null;

  const course = await db
    .prepare("SELECT id, slug, title, format, certificate_title, access_days FROM courses WHERE id = ?")
    .bind(enrollmentRow.course_id)
    .first<{ id: number; slug: string; title: string; format: CourseFormat; certificate_title: string | null; access_days: number | null }>();
  if (!course) return null;

  const [modules, lessons] = await Promise.all([
    db
      .prepare("SELECT id, position, title FROM modules WHERE course_id = ? ORDER BY position, id")
      .bind(course.id)
      .all<{ id: number; position: number; title: string }>(),
    db
      .prepare(
        "SELECT l.id, l.module_id, l.slug, l.title, l.minutes, l.free_preview, l.vertical, l.video_provider, " +
          "l.duration_seconds, l.notes, p.position_seconds, p.completed_at, p.student_id IS NOT NULL AS has_progress " +
          "FROM lessons l LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.student_id = ? " +
          "WHERE l.course_id = ? ORDER BY l.position, l.id",
      )
      .bind(studentId, course.id)
      .all<LessonRow>(),
  ]);

  const outline: LearnModule[] = modules.results.map((m) => ({ id: m.id, position: m.position, title: m.title, lessons: [] }));
  const byId = new Map(outline.map((m) => [m.id, m]));
  for (const l of lessons.results) {
    byId.get(l.module_id)?.lessons.push({
      id: l.id,
      slug: l.slug,
      title: l.title,
      minutes: l.minutes,
      freePreview: l.free_preview === 1,
      vertical: l.vertical === 1,
      hasVideo: l.video_provider !== "none",
      durationSeconds: l.duration_seconds,
      notes: l.notes,
      progress: l.has_progress
        ? { lessonId: l.id, positionSeconds: l.position_seconds ?? 0, completedAt: l.completed_at }
        : null,
    });
  }
  const total = lessons.results.length;
  const done = lessons.results.filter((l) => l.completed_at !== null).length;

  return {
    course: {
      id: course.id,
      slug: course.slug,
      title: course.title,
      format: course.format,
      certificateTitle: course.certificate_title,
      accessDays: course.access_days,
    },
    enrollment,
    batch: enrollment.batch,
    modules: outline,
    certificate: await getCertificate(env, studentId, course.id),
    complete: total > 0 && done === total,
  };
}

/** The lessons in course order, flattened (for previous / next and "continue"). */
export function flatLessons(course: Pick<LearnCourseResponse, "modules">) {
  return course.modules.flatMap((m) => m.lessons.map((lesson) => ({ ...lesson, module: m })));
}

/** The lesson to continue with: the first one not done yet, in course order. null when all are done. */
export function continueLesson(course: Pick<LearnCourseResponse, "modules">): ReturnType<typeof flatLessons>[number] | null {
  return flatLessons(course).find((l) => !l.progress?.completedAt) ?? null;
}

// ---------------------------------------------------------------- progress

export interface ProgressInput {
  lessonId: number;
  positionSeconds: number;
  completed?: boolean;
}

/** Checks a progress body from the browser. */
export function parseProgress(body: Record<string, unknown>): ProgressInput {
  const lessonId = Number(body.lessonId);
  if (!Number.isSafeInteger(lessonId) || lessonId < 1) throw new ValidationError("lessonId", "lessonId must be a lesson id.");
  const raw = body.positionSeconds ?? 0;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new ValidationError("positionSeconds", "positionSeconds must be a number of seconds.");
  }
  if (body.completed !== undefined && typeof body.completed !== "boolean") {
    throw new ValidationError("completed", "completed must be true or false.");
  }
  return { lessonId, positionSeconds: Math.floor(raw), completed: body.completed as boolean | undefined };
}

/**
 * Saves the student's place in a lesson, and its done tick. Marks the enrollment completed once
 * every lesson of the course is done (never un-marks it). null when the lesson doesn't exist or
 * the student has no active enrollment in its course (the caller answers the same for both).
 */
export async function saveProgress(
  env: Partial<Env> & { DB: Db },
  studentId: number,
  input: ProgressInput,
  now = unixNow(),
): Promise<ProgressResponse | null> {
  const db = env.DB;
  const lesson = await db
    .prepare(
      "SELECT l.id, l.course_id, l.duration_seconds, e.id AS enrollment_id, e.mode, e.starts_at, e.expires_at, e.revoked_at " +
        "FROM lessons l JOIN courses c ON c.id = l.course_id AND c.deleted_at IS NULL " +
        "JOIN enrollments e ON e.course_id = l.course_id AND e.student_id = ? WHERE l.id = ?",
    )
    .bind(studentId, input.lessonId)
    .first<{
      id: number;
      course_id: number;
      duration_seconds: number | null;
      enrollment_id: number;
      mode: "test" | "live";
      starts_at: number;
      expires_at: number | null;
      revoked_at: number | null;
    }>();
  if (!lesson || !enrollmentActive(lesson, now, liveMode(env))) return null;

  const cap = lesson.duration_seconds && lesson.duration_seconds > 0 ? lesson.duration_seconds : MAX_POSITION_SECONDS;
  const position = Math.min(Math.max(0, input.positionSeconds), cap);
  // Fixed SQL per case: done, not done, or unchanged (a plain position save).
  const completedSql =
    input.completed === true
      ? "COALESCE(lesson_progress.completed_at, excluded.completed_at)"
      : input.completed === false
        ? "NULL"
        : "lesson_progress.completed_at";

  const results = await batch<{ completed_at: number | null; total?: number; done?: number }>(db, [
    db
      .prepare(
        "INSERT INTO lesson_progress (student_id, lesson_id, position_seconds, completed_at, updated_at) VALUES (?, ?, ?, ?, ?) " +
          `ON CONFLICT (student_id, lesson_id) DO UPDATE SET position_seconds = excluded.position_seconds, ` +
          `completed_at = ${completedSql}, updated_at = excluded.updated_at RETURNING completed_at`,
      )
      .bind(studentId, lesson.id, position, input.completed === true ? now : null, now),
    // Completion: every lesson of the course done (and there is at least one).
    db
      .prepare(
        "UPDATE enrollments SET completed_at = ?, updated_at = ? WHERE id = ? AND completed_at IS NULL " +
          "AND EXISTS (SELECT 1 FROM lessons WHERE course_id = ?) " +
          "AND NOT EXISTS (SELECT 1 FROM lessons l LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.student_id = ? " +
          "WHERE l.course_id = ? AND p.completed_at IS NULL)",
      )
      .bind(now, now, lesson.enrollment_id, lesson.course_id, studentId, lesson.course_id),
    db
      .prepare(
        "SELECT count(*) AS total, count(p.completed_at) AS done FROM lessons l " +
          "LEFT JOIN lesson_progress p ON p.lesson_id = l.id AND p.student_id = ? WHERE l.course_id = ?",
      )
      .bind(studentId, lesson.course_id),
  ]);
  const saved = results[0]?.results[0];
  const counts = results[2]?.results[0];
  const total = counts?.total ?? 0;
  return {
    lessonId: lesson.id,
    completedAt: saved?.completed_at ?? null,
    courseComplete: total > 0 && counts?.done === total,
  };
}

// ---------------------------------------------------------------- certificate claim

export type ClaimResult =
  | { ok: true; certificate: Certificate }
  | { ok: false; reason: "not_enrolled" | "course_incomplete" | "no_certificate" | "revoked" };

/**
 * The student asks for (or corrects the name on) their certificate. Allowed once every lesson
 * is done, the course has certificate wording, and the certificate isn't revoked.
 */
export async function claimCertificate(
  env: Env,
  studentId: number,
  courseSlug: string,
  rawName: unknown,
  now = unixNow(),
): Promise<ClaimResult> {
  const name = certificateName(rawName);
  const course = await loadLearnCourse(env, studentId, courseSlug, now);
  if (!course) return { ok: false, reason: "not_enrolled" };
  if (!course.course.certificateTitle?.trim()) return { ok: false, reason: "no_certificate" };
  if (!course.complete) return { ok: false, reason: "course_incomplete" };
  if (course.certificate?.revokedAt) return { ok: false, reason: "revoked" };
  const certificate = await issueCertificate(env, { studentId, courseId: course.course.id, name, now });
  return { ok: true, certificate };
}

