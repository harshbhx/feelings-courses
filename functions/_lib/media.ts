/**
 * Signed media URLs (plan 1.6, W4).
 *
 *   /media/<kind>/<lessonId>?e=<exp>&s=<sidTag>&sig=<hmac>
 *   sig = HMAC-SHA256(APP_SECRET, "<kind>|<lessonId>|<exp>|<sidTag>")
 * kind "v" = video, "c" = captions. sidTag = first 16 hex of the session's tokenHash, or "public"
 * for free previews. ttl defaults to config.ts MEDIA_URL_TTL (2 h) and can't be longer.
 *
 * A URL only works:
 * - before `e` (at most 2 hours after it was issued);
 * - with an untouched signature (the lesson, expiry and session are all signed);
 * - for a student URL, from the browser holding the session cookie whose hash starts with `s`
 *   (functions/_lib/media-serve.ts checks the cookie on every request), so a copied link is useless
 *   on another device or after signing out.
 */
import { MEDIA_URL_TTL, PUBLIC_SESSION_TAG, SESSION_COOKIE, requireSecret } from "./config.ts";
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from "./crypto.ts";
import { unixNow } from "./db/d1.ts";
import type { Env } from "./env.ts";

export type MediaUrlKind = "v" | "c";

/** Shortest and longest lifetimes signMediaUrl accepts. */
export const MIN_MEDIA_TTL = 60;
export const MAX_MEDIA_TTL = MEDIA_URL_TTL;
/** Allowed clock difference between the isolate that signed and the one that checks. */
const CLOCK_SKEW = 300;

const SESSION_TAG_RE = /^[0-9a-f]{16}$/;
const SIG_RE = /^[0-9a-f]{64}$/;
/** The session cookie's token: base64url (W3 issues 32 random bytes = 43 characters). */
const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** True for a 16-hex session tag or "public". */
export function isSessionTag(value: unknown): value is string {
  return typeof value === "string" && (value === PUBLIC_SESSION_TAG || SESSION_TAG_RE.test(value));
}

function isLessonId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** The string that is signed. */
export function mediaSigningInput(kind: MediaUrlKind, lessonId: number, exp: number, sidTag: string): string {
  return `${kind}|${lessonId}|${exp}|${sidTag}`;
}

/**
 * A root-relative signed URL for a lesson's video ("v") or captions ("c"). `sessionTag` is the
 * EnrollmentRef's sessionTag, or PUBLIC_SESSION_TAG for a free preview. `now` is for tests.
 */
export async function signMediaUrl(
  env: Env,
  input: { kind: "v" | "c"; lessonId: number; sessionTag: string; ttl?: number; now?: number },
): Promise<string> {
  const { kind, lessonId, sessionTag } = input;
  if (kind !== "v" && kind !== "c") throw new TypeError("signMediaUrl: kind must be v or c");
  if (!isLessonId(lessonId)) throw new TypeError("signMediaUrl: lessonId must be a positive integer");
  if (!isSessionTag(sessionTag)) throw new TypeError("signMediaUrl: sessionTag must be 16 hex characters or public");
  const ttl = Math.min(MAX_MEDIA_TTL, Math.max(MIN_MEDIA_TTL, Math.floor(input.ttl ?? MEDIA_URL_TTL)));
  const secret = requireSecret(env, "APP_SECRET");
  const exp = (input.now ?? unixNow()) + ttl;
  const sig = await hmacSha256Hex(secret, mediaSigningInput(kind, lessonId, exp, sessionTag));
  return `/media/${kind}/${lessonId}?e=${exp}&s=${sessionTag}&sig=${sig}`;
}

/** The expiry (`e`) of a URL made by signMediaUrl. */
export function mediaUrlExpiry(url: string): number {
  return Number(new URL(url, "https://x.invalid").searchParams.get("e"));
}

export type MediaLinkCheck =
  | { ok: true; kind: MediaUrlKind; lessonId: number; exp: number; sidTag: string }
  | { ok: false; reason: "malformed" | "expired" | "bad_signature" };

/**
 * Checks a signed media URL's parameters: shape, expiry, then the HMAC (in constant time). It does
 * not check the session cookie; media-serve.ts does that next.
 */
export async function verifyMediaLink(
  env: Env,
  input: { kind: string; lessonId: string; params: URLSearchParams },
  now: number = unixNow(),
): Promise<MediaLinkCheck> {
  const { kind, lessonId: rawId, params } = input;
  const e = params.get("e") ?? "";
  const s = params.get("s") ?? "";
  const sig = (params.get("sig") ?? "").toLowerCase();
  if ((kind !== "v" && kind !== "c") || !/^[1-9]\d{0,11}$/.test(rawId) || !/^[1-9]\d{0,11}$/.test(e) || !isSessionTag(s) || !SIG_RE.test(sig)) {
    return { ok: false, reason: "malformed" };
  }
  const lessonId = Number(rawId);
  const exp = Number(e);
  // Expired, or further ahead than any URL we issue (a forged far-future expiry fails the HMAC
  // anyway; this also bounds a leaked secret's damage window per URL).
  if (exp <= now || exp > now + MAX_MEDIA_TTL + CLOCK_SKEW) return { ok: false, reason: "expired" };
  const secret = requireSecret(env, "APP_SECRET");
  const expected = await hmacSha256Hex(secret, mediaSigningInput(kind, lessonId, exp, s));
  if (!timingSafeEqual(expected, sig)) return { ok: false, reason: "bad_signature" };
  return { ok: true, kind, lessonId, exp, sidTag: s };
}

/** The value of cookie `name` in a Cookie header, or null (the first one wins). */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    if (pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return null;
}

/**
 * sha256Hex of the request's student session cookie, or null when there is no well-formed cookie.
 * Its first 16 characters are the session tag signed into the student's media URLs.
 */
export async function sessionTokenHash(request: Request): Promise<string | null> {
  const token = cookieValue(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!token || !SESSION_TOKEN_RE.test(token)) return null;
  return sha256Hex(token);
}
