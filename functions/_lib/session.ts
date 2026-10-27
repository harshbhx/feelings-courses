/**
 * Student sessions and single-use login tokens (plan 1.4). Signatures frozen by W0, bodies by W3.
 *
 * - Session cookie `__Host-fbc_s` (config.ts SESSION_COOKIE): 32 random bytes, base64url; D1 stores
 *   only sha256Hex(token) in `sessions.token_hash`, so a database leak signs nobody in.
 *   180 days, sliding (refreshed at most daily), at most 2 live sessions per student
 *   (MAX_SESSIONS_PER_STUDENT, owner decision): the 3rd sign-in revokes the oldest.
 * - Signing in again on a device that already has a session replaces that session instead of
 *   pushing out the student's other device.
 * - Login tokens (`login_tokens`): "handoff" (10 min) after payment, "admin_link" (24 h) sent by
 *   the admin on WhatsApp. Single use: consumed by one guarded UPDATE … RETURNING, so two racing
 *   requests can't both use a token. redirect_path must be a same-site path ("/…", never "//…").
 * - Session lookups go by the token's hash through the UNIQUE index; the raw token is never
 *   compared, stored or logged.
 */
import type { LoginTokenPurpose } from "../../src/shared/types.ts";
import {
  config,
  LOGIN_TOKEN_TTL,
  MAX_SESSIONS_PER_STUDENT,
  SESSION_COOKIE,
  SESSION_TOUCH_INTERVAL,
  SESSION_TTL,
} from "./config.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { unixNow, type Db } from "./db/d1.ts";
import { ValidationError } from "./db/errors.ts";
import { batch, changes } from "./db/tx.ts";
import { hasDb, type Env } from "./env.ts";

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

/** A raw session or login token: 32 bytes as base64url, 43 characters. */
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** Longest redirect path a login token may carry. */
export const MAX_REDIRECT_LENGTH = 300;
/** Longest User-Agent kept for the devices list (the column allows 400). */
const MAX_USER_AGENT = 300;

// ---------------------------------------------------------------- cookies

/** The value of cookie `name` in a Cookie header, or null. The first one wins, as browsers send the most specific first. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    if (pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return null;
}

/** The request's session token when it is well formed, else null. */
export function sessionToken(request: Request): string | null {
  const value = readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  return value && TOKEN_RE.test(value) ? value : null;
}

/** Set-Cookie for a new session. `__Host-` requires Secure, Path=/ and no Domain (hub only). */
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_TTL}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** Set-Cookie that removes the session cookie. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** The User-Agent, tidied for the devices list (no control characters, capped), or null. */
export function tidyUserAgent(value: string | null): string | null {
  const tidy = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return tidy === "" ? null : tidy.slice(0, MAX_USER_AGENT);
}

// ---------------------------------------------------------------- sessions

/**
 * Creates a session for the student (revoking the oldest beyond MAX_SESSIONS_PER_STUDENT = 2) and returns the Set-Cookie
 * header value. `request` supplies the User-Agent, and its current session cookie (if any) is
 * replaced rather than counted as another device.
 */
export async function createSession(
  db: Db,
  studentId: number,
  request: Request,
  now: number = unixNow(),
): Promise<{ cookie: string }> {
  if (!Number.isSafeInteger(studentId) || studentId < 1) throw new ValidationError("studentId", "studentId must be an id.");
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const previous = sessionToken(request);
  const previousHash = previous ? await sha256Hex(previous) : null;

  const results = await batch(db, [
    // 1. This device's old session (any student), so a re-sign-in doesn't use up a device slot.
    previousHash !== null &&
      db.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").bind(now, previousHash),
    // 2. The new session, only for a student who still exists and hasn't been erased.
    db
      .prepare(
        "INSERT INTO sessions (token_hash, student_id, created_at, last_seen_at, expires_at, user_agent) " +
          "SELECT ?, id, ?, ?, ?, ? FROM students WHERE id = ? AND erased_at IS NULL",
      )
      .bind(tokenHash, now, now, now + SESSION_TTL, tidyUserAgent(request.headers.get("User-Agent")), studentId),
    // 3. The device limit: every live session but the newest MAX_SESSIONS_PER_STUDENT is revoked.
    db
      .prepare(
        "UPDATE sessions SET revoked_at = ? WHERE student_id = ? AND revoked_at IS NULL AND expires_at > ? " +
          "AND id NOT IN (SELECT id FROM sessions WHERE student_id = ? AND revoked_at IS NULL AND expires_at > ? " +
          "ORDER BY created_at DESC, id DESC LIMIT ?)",
      )
      .bind(now, studentId, now, studentId, now, MAX_SESSIONS_PER_STUDENT),
  ]);
  const inserted = results[previousHash !== null ? 1 : 0];
  if (changes(inserted) !== 1) throw new ValidationError("studentId", "That student can't sign in.");
  return { cookie: sessionCookie(token) };
}

interface SessionRow {
  id: number;
  student_id: number;
  last_seen_at: number;
}

/**
 * The request's valid session (not expired, not revoked, student not erased), or null. Touches
 * last_seen_at at most daily, and slides the expiry forward at the same time.
 */
export async function readSession(env: Partial<Env>, request: Request, now: number = unixNow()): Promise<SessionRef | null> {
  if (!hasDb(env)) return null;
  const token = sessionToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT s.id, s.student_id, s.last_seen_at FROM sessions s JOIN students st ON st.id = s.student_id " +
      "WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND st.erased_at IS NULL",
  )
    .bind(tokenHash, now)
    .first<SessionRow>();
  if (!row) return null;
  if (now - row.last_seen_at >= SESSION_TOUCH_INTERVAL) {
    await env.DB.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(now, now + SESSION_TTL, row.id)
      .run();
  }
  return { sessionId: row.id, studentId: row.student_id, tokenHash };
}

/** Revokes one of the student's sessions. True when it was live. */
export async function revokeSession(db: Db, studentId: number, sessionId: number, now: number = unixNow()): Promise<boolean> {
  const result = await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND student_id = ? AND revoked_at IS NULL")
    .bind(now, sessionId, studentId)
    .run();
  return changes(result) === 1;
}

/** Revokes every live session of the student. Returns how many. */
export async function revokeAllSessions(db: Db, studentId: number, now: number = unixNow()): Promise<number> {
  const result = await db
    .prepare("UPDATE sessions SET revoked_at = ? WHERE student_id = ? AND revoked_at IS NULL")
    .bind(now, studentId)
    .run();
  return changes(result);
}

// ---------------------------------------------------------------- login tokens

/**
 * A safe same-site redirect path, or null. Accepts "/path?query#hash" only: no scheme, no host,
 * no "//" or "/\" (which browsers treat as another host), no control characters.
 */
export function safeRedirectPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_REDIRECT_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value, "https://hub.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://hub.invalid") return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.startsWith("//") ? null : path;
}

/**
 * Creates a single-use login token and returns the raw token (only its hash is stored). A new
 * admin link replaces the student's unused older ones, so only the latest link Urmi sent works.
 */
export async function issueLoginToken(
  db: Db,
  studentId: number,
  purpose: LoginTokenPurpose,
  redirectPath: string,
  now: number = unixNow(),
): Promise<string> {
  const ttl = (LOGIN_TOKEN_TTL as Record<string, number>)[purpose];
  if (!ttl) throw new ValidationError("purpose", "Unknown login token purpose.");
  const path = safeRedirectPath(redirectPath);
  if (!path) throw new ValidationError("redirectPath", "The redirect must be a path on this site.");
  if (!Number.isSafeInteger(studentId) || studentId < 1) throw new ValidationError("studentId", "studentId must be an id.");

  const token = randomToken(32);
  const results = await batch(db, [
    purpose === "admin_link" &&
      db
        .prepare(
          "UPDATE login_tokens SET used_at = ? WHERE student_id = ? AND purpose = 'admin_link' AND used_at IS NULL AND expires_at > ?",
        )
        .bind(now, studentId, now),
    db
      .prepare(
        "INSERT INTO login_tokens (token_hash, purpose, student_id, redirect_path, created_at, expires_at) " +
          "SELECT ?, ?, id, ?, ?, ? FROM students WHERE id = ? AND erased_at IS NULL",
      )
      .bind(await sha256Hex(token), purpose, path, now, now + ttl, studentId),
  ]);
  if (changes(results[results.length - 1]) !== 1) throw new ValidationError("studentId", "That student can't sign in.");
  return token;
}

export interface ConsumedToken {
  studentId: number;
  purpose: LoginTokenPurpose;
  redirectPath: string;
}

/**
 * Uses up a login token: one guarded UPDATE, so only the first request wins. null when the token
 * is malformed, unknown, used, expired, or its student was erased.
 */
export async function consumeLoginToken(db: Db, rawToken: unknown, now: number = unixNow()): Promise<ConsumedToken | null> {
  if (typeof rawToken !== "string" || !TOKEN_RE.test(rawToken)) return null;
  const row = await db
    .prepare(
      "UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? " +
        "AND student_id IN (SELECT id FROM students WHERE erased_at IS NULL) RETURNING student_id, purpose, redirect_path",
    )
    .bind(now, await sha256Hex(rawToken), now)
    .first<{ student_id: number; purpose: LoginTokenPurpose; redirect_path: string }>();
  if (!row) return null;
  return { studentId: row.student_id, purpose: row.purpose, redirectPath: safeRedirectPath(row.redirect_path) ?? "/account" };
}

/** The purpose of a token that is still usable, without using it up (the link page asks first). */
export async function peekLoginToken(db: Db, rawToken: unknown, now: number = unixNow()): Promise<LoginTokenPurpose | null> {
  if (typeof rawToken !== "string" || !TOKEN_RE.test(rawToken)) return null;
  const row = await db
    .prepare(
      "SELECT t.purpose FROM login_tokens t JOIN students s ON s.id = t.student_id " +
        "WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ? AND s.erased_at IS NULL",
    )
    .bind(await sha256Hex(rawToken), now)
    .first<{ purpose: LoginTokenPurpose }>();
  return row?.purpose ?? null;
}

// ---------------------------------------------------------------- enrollments

export interface EnrollmentRow {
  id: number;
  course_id: number;
  mode: "test" | "live";
  starts_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

/**
 * Whether an enrollment gives access now: not revoked, started, not expired (1 year from
 * purchase by default), and not a test-mode enrollment while the site takes live payments.
 */
export function enrollmentActive(row: Pick<EnrollmentRow, "mode" | "starts_at" | "expires_at" | "revoked_at">, now: number, liveMode: boolean): boolean {
  if (row.revoked_at !== null) return false;
  if (row.starts_at > now) return false;
  if (row.expires_at !== null && row.expires_at <= now) return false;
  if (liveMode && row.mode === "test") return false;
  return true;
}

/** The student's active enrollment in the course `courseSlug` (not deleted), or null. */
export async function findActiveEnrollment(
  env: Partial<Env>,
  studentId: number,
  courseSlug: string,
  now: number = unixNow(),
): Promise<EnrollmentRow | null> {
  if (!hasDb(env)) return null;
  const row = await env.DB.prepare(
    "SELECT e.id, e.course_id, e.mode, e.starts_at, e.expires_at, e.revoked_at FROM enrollments e " +
      "JOIN courses c ON c.id = e.course_id WHERE e.student_id = ? AND c.slug = ? AND c.deleted_at IS NULL",
  )
    .bind(studentId, courseSlug)
    .first<EnrollmentRow>();
  if (!row) return null;
  return enrollmentActive(row, now, config(env).paymentMode === "live") ? row : null;
}

/**
 * The session's active enrollment in the course `courseSlug`, or null (no session, not enrolled,
 * expired, revoked, or a test-mode enrollment while payments are live).
 */
export async function requireEnrollment(
  env: Env,
  request: Request,
  courseSlug: string,
  now: number = unixNow(),
): Promise<EnrollmentRef | null> {
  if (typeof courseSlug !== "string" || !/^[a-z0-9-]{1,40}$/.test(courseSlug)) return null;
  const session = await readSession(env, request, now);
  if (!session) return null;
  const row = await findActiveEnrollment(env, session.studentId, courseSlug, now);
  if (!row) return null;
  return {
    studentId: session.studentId,
    enrollmentId: row.id,
    courseId: row.course_id,
    sessionTag: session.tokenHash.slice(0, 16),
  };
}
