/**
 * The lesson play logic (plan W4), called by W3's GET /api/learn/:slug/lessons/:lessonId/play
 * after requireEnrollment(), and the free-preview links for GET /api/public/preview/:lessonId.
 */
import type { PlayInfo, SignedMedia, Watermark } from "../../src/shared/types.ts";
import { PUBLIC_SESSION_TAG } from "./config.ts";
import { unixNow } from "./db/d1.ts";
import { hasDb, type Env } from "./env.ts";
import { mediaUrlExpiry, signMediaUrl } from "./media.ts";
import type { EnrollmentRef } from "./session.ts";

/** Within this many seconds of the end, a lesson restarts from 0 instead of resuming. */
export const RESUME_END_MARGIN = 10;

interface PlayRow {
  id: number;
  captions_key: string | null;
  duration_seconds: number | null;
  name: string | null;
  phone: string | null;
  email: string | null;
  position_seconds: number | null;
  completed_at: number | null;
}

/** "+919876541578" → "+91 ••••• •1578" (only the last 4 digits show). */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return null;
  const last4 = digits.slice(-4);
  if (phone.startsWith("+91") && digits.length === 12) return `+91 ••••• •${last4}`;
  const cc = phone.startsWith("+") ? `+${digits.slice(0, Math.max(1, digits.length - 10))} ` : "";
  return `${cc}•••• ${last4}`;
}

/** "priya.shah@gmail.com" → "pr•••@gmail.com". */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 1) return null;
  return `${email.slice(0, Math.min(2, at))}•••${email.slice(at)}`;
}

/** The overlay text: the student's name and masked phone, so a screen recording names its source. */
export function watermarkFor(student: { name: string | null; phone: string | null; email: string | null }): Watermark {
  const phoneMasked = maskPhone(student.phone);
  const name = student.name?.trim() || (phoneMasked ? "" : maskEmail(student.email) ?? "");
  return { name, phoneMasked };
}

/** Where to resume: the saved position, unless the lesson was finished or the position is at the end. */
export function resumePosition(row: Pick<PlayRow, "position_seconds" | "completed_at" | "duration_seconds">): number {
  const pos = Math.max(0, Math.floor(row.position_seconds ?? 0));
  if (row.completed_at !== null && row.completed_at !== undefined) return 0;
  if (row.duration_seconds && pos >= row.duration_seconds - RESUME_END_MARGIN) return 0;
  return pos;
}

/**
 * Signed video (and captions) URLs, resume position and watermark for one lesson of the enrolled
 * course. null when the lesson isn't in that course or has no R2 video. `now` is for tests.
 */
export async function playLesson(env: Env, enrollment: EnrollmentRef, lessonId: number, now: number = unixNow()): Promise<PlayInfo | null> {
  if (!hasDb(env)) return null;
  if (!Number.isSafeInteger(lessonId) || lessonId <= 0) return null;
  const row = await env.DB.prepare(
    "SELECT l.id, l.captions_key, l.duration_seconds, s.name, s.phone, s.email, p.position_seconds, p.completed_at " +
      "FROM lessons l JOIN students s ON s.id = ? " +
      "LEFT JOIN lesson_progress p ON p.student_id = s.id AND p.lesson_id = l.id " +
      "WHERE l.id = ? AND l.course_id = ? AND l.video_provider = 'r2' AND l.video_ref IS NOT NULL",
  )
    .bind(enrollment.studentId, lessonId, enrollment.courseId)
    .first<PlayRow>();
  if (!row) return null;
  const media = await signedLessonMedia(env, row.id, row.captions_key !== null, enrollment.sessionTag, now);
  return {
    ...media,
    resumeAt: resumePosition(row),
    watermark: watermarkFor(row),
  };
}

/** Signed links for a lesson's video and (when it has them) captions. */
async function signedLessonMedia(env: Env, lessonId: number, hasCaptions: boolean, sessionTag: string, now: number): Promise<SignedMedia> {
  const src = await signMediaUrl(env, { kind: "v", lessonId, sessionTag, now });
  const captions = hasCaptions ? await signMediaUrl(env, { kind: "c", lessonId, sessionTag, now }) : null;
  return { src, captions, expiresAt: mediaUrlExpiry(src) };
}

/**
 * Public links for a free-preview lesson of a published course (no sign-in), or null. Used by
 * GET /api/public/preview/:lessonId.
 */
export async function previewLesson(env: Env, lessonId: number, now: number = unixNow()): Promise<SignedMedia | null> {
  if (!hasDb(env)) return null;
  if (!Number.isSafeInteger(lessonId) || lessonId <= 0) return null;
  const row = await env.DB.prepare(
    "SELECT l.id, l.captions_key FROM lessons l JOIN courses c ON c.id = l.course_id " +
      "WHERE l.id = ? AND l.free_preview = 1 AND l.video_provider = 'r2' AND l.video_ref IS NOT NULL " +
      "AND c.status = 'published' AND c.deleted_at IS NULL",
  )
    .bind(lessonId)
    .first<{ id: number; captions_key: string | null }>();
  if (!row) return null;
  return signedLessonMedia(env, row.id, row.captions_key !== null, PUBLIC_SESSION_TAG, now);
}
