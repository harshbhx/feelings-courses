/**
 * Student sessions and single-use login tokens (plan 1.4). STUB: signatures frozen by W0, bodies by W3.
 *
 * - Session cookie `__Host-fbc_s` (config.ts SESSION_COOKIE): 32 random bytes, base64url; D1 stores
 *   only sha256Hex(token) in `sessions.token_hash`. 180 days, sliding, max 3 per student.
 * - Login tokens (`login_tokens`): "handoff" (10 min) after payment, "admin_link" (24 h) sent by
 *   the admin on WhatsApp. Single use. redirect_path must start with "/" and not "//".
 */
import type { LoginTokenPurpose } from "../../src/shared/types.ts";
import type { Db } from "./db/d1.ts";
import type { Env } from "./env.ts";
import { notImplemented } from "./stub.ts";

export interface SessionRef {
  sessionId: number;
  studentId: number;
  /** sha256Hex of the cookie token. Its first 16 characters are the media URLs' sidTag. */
  tokenHash: string;
}

export interface EnrollmentRef {
  studentId: number;
  enrollmentId: number;
  courseId: number;
  /** First 16 hex characters of the session's tokenHash: binds signed media URLs to this cookie. */
  sessionTag: string;
}

/**
 * Creates a session for the student (revoking the oldest beyond 3) and returns the Set-Cookie
 * header value. `request` supplies the User-Agent.
 */
export async function createSession(db: Db, studentId: number, request: Request): Promise<{ cookie: string }> {
  return notImplemented("createSession", "W3");
}

/** The request's valid session (not expired, not revoked), or null. Touches last_seen_at at most daily. */
export async function readSession(env: Env, request: Request): Promise<SessionRef | null> {
  return notImplemented("readSession", "W3");
}

/** Creates a single-use login token and returns the raw token (only its hash is stored). */
export async function issueLoginToken(
  db: Db,
  studentId: number,
  purpose: LoginTokenPurpose,
  redirectPath: string,
): Promise<string> {
  return notImplemented("issueLoginToken", "W3");
}

/**
 * The session's active enrollment in the course `courseSlug`, or null (no session, not enrolled,
 * expired, revoked, or a test-mode enrollment while payments are live).
 */
export async function requireEnrollment(env: Env, request: Request, courseSlug: string): Promise<EnrollmentRef | null> {
  return notImplemented("requireEnrollment", "W3");
}
