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
 * before any secret exists. It must never be used with live payment keys: once `course.demo` is
 * false, an unset ENROLL_SECRET means no cookie is issued or accepted at all, and cookies from demo
 * payments (`demo_…`) stop working.
 */

import { course } from "../../src/data/course.ts";
import { hmacSha256Hex, timingSafeEqual } from "./crypto.ts";

export interface EnrollEnv {
  ENROLL_SECRET?: string;
}

export const ENROLL_COOKIE = "fbc_enroll";

export interface Enrollment {
  courseSlug: string;
  expires: number;
  paymentRef: string;
}

/**
 * The demo key. Public on purpose: it is in this file for anyone to read, so a cookie signed with it
 * proves nothing. It only lets the demo run before the owner sets ENROLL_SECRET.
 */
export const DEMO_ENROLL_KEY = "DEMO-ONLY-public-key-not-a-secret-feelings-courses";

/** Browsers cap a cookie's lifetime at 400 days (Chrome since 2022), so Max-Age never asks for more. */
const MAX_COOKIE_SECONDS = 400 * 24 * 60 * 60;

// Payment refs go inside the dot-separated cookie: Razorpay ids (`pay_…`) and demo refs (`demo_…`).
const PAYMENT_REF = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^[a-z0-9-]{1,80}$/;

/** Days of access from `course.access` ("12 months", "90 days", "1 year"); 365 if it can't be read. */
export function accessDays(access: string = course.access): number {
  const m = /(\d+)\s*(day|week|month|year)s?/i.exec(access);
  if (!m) return 365;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const days = unit === "day" ? n : unit === "week" ? n * 7 : unit === "month" ? Math.round((n * 365) / 12) : n * 365;
  return days > 0 ? days : 365;
}

/** A new enrollment in this course for a verified payment, expiring after the access period. */
export function newEnrollment(paymentRef: string, nowMs: number = Date.now()): Enrollment {
  return {
    courseSlug: course.slug,
    expires: Math.floor(nowMs / 1000) + accessDays() * 24 * 60 * 60,
    paymentRef,
  };
}

/** The signing key, or null when none may be used (no ENROLL_SECRET outside demo mode). */
function signingKey(env: EnrollEnv): string | null {
  const secret = env.ENROLL_SECRET?.trim();
  if (secret) return secret;
  return course.demo ? DEMO_ENROLL_KEY : null;
}

/** Returns a Set-Cookie header value for a new enrollment. Implemented by the checkout work. */
export async function issueEnrollment(env: EnrollEnv, enrollment: Enrollment): Promise<string> {
  const key = signingKey(env);
  if (!key) throw new Error("issueEnrollment: ENROLL_SECRET is not set, and the demo key only works while course.demo is true");
  const { courseSlug, expires, paymentRef } = enrollment;
  if (!SLUG.test(courseSlug)) throw new Error("issueEnrollment: invalid course slug");
  if (!PAYMENT_REF.test(paymentRef)) throw new Error("issueEnrollment: invalid payment reference");
  if (!Number.isSafeInteger(expires)) throw new Error("issueEnrollment: invalid expiry");

  const payload = `${courseSlug}.${expires}.${paymentRef}`;
  const mac = await hmacSha256Hex(key, payload);
  const maxAge = Math.min(Math.max(0, expires - Math.floor(Date.now() / 1000)), MAX_COOKIE_SECONDS);
  return `${ENROLL_COOKIE}=${payload}.${mac}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** Reads and checks the cookie from a request. Returns the enrollment, or null if missing, expired or forged. */
export async function verifyEnrollment(env: EnrollEnv, request: Request): Promise<Enrollment | null> {
  const value = readCookie(request.headers.get("Cookie"), ENROLL_COOKIE);
  if (!value) return null;

  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [courseSlug, expiresText, paymentRef, mac] = parts;
  if (courseSlug !== course.slug || !/^\d{1,12}$/.test(expiresText) || !PAYMENT_REF.test(paymentRef)) return null;
  if (!/^[0-9a-f]{64}$/.test(mac)) return null;

  const expires = Number(expiresText);
  if (expires <= Math.floor(Date.now() / 1000)) return null;
  // Demo payments never unlock the real course.
  if (paymentRef.startsWith("demo_") && !course.demo) return null;

  const key = signingKey(env);
  if (!key) return null;
  const expected = await hmacSha256Hex(key, `${courseSlug}.${expiresText}.${paymentRef}`);
  if (!timingSafeEqual(mac, expected)) return null;

  return { courseSlug, expires, paymentRef };
}

/** The value of cookie `name` in a Cookie header, or null. */
function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    if (pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return null;
}
