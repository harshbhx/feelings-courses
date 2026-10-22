/**
 * Rate-limit helpers for endpoints (plan 1.13, W7), on top of W0's ratelimit.ts.
 *
 *   const limited = await enforceRateLimits(env.DB, [
 *     { rule: "restore_ip", subject: ipSubject(request) },
 *     { rule: "restore_contact", subject: await contactSubject(contact) },
 *   ]);
 *   if (limited) return limited;            // 429 with Retry-After
 *
 * - Every rule is counted (a blocked request still counts against the others).
 * - IPv6 clients are limited per /64, the block one home or phone usually gets, so rotating
 *   addresses inside it doesn't reset the limit.
 * - Phone numbers and emails are hashed before they are stored as a bucket subject.
 * - Failure policy: a D1 error is "open" (allow) by default, so an outage of the limiter doesn't
 *   block checkout; pass `onError: "closed"` where a guess is worse than an outage (admin login).
 */
import type { RateLimitName, RateLimitRule } from "./config.ts";
import { RATE_LIMITS } from "./config.ts";
import { sha256Hex } from "./crypto.ts";
import type { Db } from "./db/d1.ts";
import { error, clientIp } from "./http.ts";
import { hit, type RateLimitResult } from "./ratelimit.ts";

export interface LimitCheck {
  rule: RateLimitName;
  subject: string;
}

/** The client's address as a rate-limit subject: IPv4 as is, IPv6 cut to its /64. */
export function ipSubject(request: Request): string {
  const ip = clientIp(request);
  if (!ip.includes(":")) return ip;
  const zoneless = ip.split("%")[0]!.toLowerCase();
  // Expand "::" so the first four groups are well defined.
  const [head, tail] = zoneless.includes("::") ? zoneless.split("::") : [zoneless, undefined];
  const left = head ? head.split(":") : [];
  const right = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups
    .slice(0, 4)
    .map((g) => (g || "0").replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** A phone or email as a subject: lower-cased, spaces removed, then SHA-256 (no contact detail is stored). */
export async function contactSubject(contact: string): Promise<string> {
  return `h:${(await sha256Hex(contact.trim().toLowerCase().replace(/\s+/g, ""))).slice(0, 40)}`;
}

/** 429 in the API's error shape, with Retry-After. */
export function tooManyRequests(retryAfter: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfter));
  return error(
    429,
    "rate_limited",
    "Too many tries. Please wait a little and try again.",
    { retryAfter: seconds },
    { "Retry-After": String(seconds) },
  );
}

/**
 * Counts one hit on every check; returns a 429 when any is over its limit, else null.
 * `rules` overrides RATE_LIMITS entries (tests, or a stricter local rule).
 */
export async function enforceRateLimits(
  db: Db,
  checks: readonly LimitCheck[],
  options: { now?: number; onError?: "open" | "closed"; rules?: Partial<Record<RateLimitName, RateLimitRule>> } = {},
): Promise<Response | null> {
  let results: RateLimitResult[];
  try {
    results = await Promise.all(
      checks.map((c) => hit(db, c.rule, c.subject, { now: options.now, rule: options.rules?.[c.rule] ?? RATE_LIMITS[c.rule] })),
    );
  } catch (err) {
    console.error(`ratelimit: ${err instanceof Error ? err.message : String(err)}`);
    return options.onError === "closed" ? error(503, "unavailable", "Please try again in a minute.", {}, { "Retry-After": "60" }) : null;
  }
  const blocked = results.filter((r) => !r.allowed);
  if (blocked.length === 0) return null;
  return tooManyRequests(Math.max(...blocked.map((r) => r.retryAfter)));
}
