/**
 * The lesson play logic (plan W4), called by W3's GET /api/learn/:slug/lessons/:lessonId/play
 * after requireEnrollment(). STUB: signature frozen by W0, body by W4.
 */
import type { PlayInfo } from "../../src/shared/types.ts";
import type { Env } from "./env.ts";
import type { EnrollmentRef } from "./session.ts";
import { notImplemented } from "./stub.ts";

/**
 * Signed video (and captions) URLs, resume position and watermark for one lesson of the enrolled
 * course. null when the lesson isn't in that course or has no video.
 */
export async function playLesson(env: Env, enrollment: EnrollmentRef, lessonId: number): Promise<PlayInfo | null> {
  return notImplemented("playLesson", "W4");
}
