/**
 * Enrollment cookie: the contract between checkout (functions/api/*) and the course area
 * (functions/learn/_middleware.ts). The checkout work implements these two functions; the course
 * area only calls verifyEnrollment(). Keep the signatures.
 *
 * Cookie `fbc_enroll` = `<courseSlug>.<expiresUnixSeconds>.<paymentRef>.<hmacHex>`, where hmacHex is
 * HMAC-SHA256 over the first three parts, keyed with env.ENROLL_SECRET. HttpOnly, Secure,
 * SameSite=Lax, Path=/, Max-Age matching the access period.
 *
 * Demo mode (no ENROLL_SECRET set): a fixed, clearly named demo key is used, so the demo works
 * before any secret exists. It must never be used with live payment keys.
 */

export interface EnrollEnv {
  ENROLL_SECRET?: string;
}

export const ENROLL_COOKIE = "fbc_enroll";

export interface Enrollment {
  courseSlug: string;
  expires: number;
  paymentRef: string;
}

/** Returns a Set-Cookie header value for a new enrollment. Implemented by the checkout work. */
export async function issueEnrollment(_env: EnrollEnv, _enrollment: Enrollment): Promise<string> {
  throw new Error("issueEnrollment: not implemented yet");
}

/** Reads and checks the cookie from a request. Returns the enrollment, or null if missing, expired or forged. */
export async function verifyEnrollment(_env: EnrollEnv, _request: Request): Promise<Enrollment | null> {
  return null;
}
