/**
 * Fixed-window rate limits in D1 (plan 1.13). One statement per check:
 *   INSERT … ON CONFLICT (bucket) DO UPDATE SET count = count + 1 … RETURNING count
 *
 * Bucket = "<rule>:<subject>:<windowStart>", for example "signin_ip:203.0.113.9:1761200100".
 * Each window gets its own row, which expires at the end of the window plus one day; the lazy
 * daily job (W7) deletes expired rows with cleanupRateLimits().
 *
 * Subjects are IPs, emails or "global". An email subject is hashed by the caller's choice:
 * pass `await sha256Hex(contact)` so no contact detail sits in the table.
 */
import { DAY, RATE_LIMITS, type RateLimitName, type RateLimitRule } from "./config.ts";
import type { Db } from "./db/d1.ts";
import { unixNow } from "./db/d1.ts";

export interface RateLimitResult {
  /** This hit is within the limit. */
  allowed: boolean;
  /** Hits in this window, including this one. */
  count: number;
  limit: number;
  /** Unix seconds when the window ends. */
  resetAt: number;
  /** Seconds until resetAt (for Retry-After). */
  retryAfter: number;
}

const SUBJECT_RE = /^[A-Za-z0-9_.:@+-]{1,120}$/;

/** The bucket key for a rule, subject and time. */
export function bucketKey(name: string, subject: string, rule: RateLimitRule, now: number): string {
  const start = Math.floor(now / rule.window) * rule.window;
  // Unusual subjects (IPv6 with zones, odd header values) are kept safe by a fixed fallback form.
  const safe = SUBJECT_RE.test(subject) ? subject : encodeURIComponent(subject).slice(0, 120);
  return `${name}:${safe}:${start}`;
}

/**
 * Counts one hit against `name` (a key of RATE_LIMITS, or a custom rule) for `subject`, and says
 * whether it is allowed. Every call counts, allowed or not.
 */
export async function hit(
  db: Db,
  name: RateLimitName | string,
  subject: string,
  options: { rule?: RateLimitRule; now?: number } = {},
): Promise<RateLimitResult> {
  const rule = options.rule ?? (RATE_LIMITS as Record<string, RateLimitRule>)[name];
  if (!rule) throw new Error(`ratelimit: unknown rule "${name}"`);
  const now = options.now ?? unixNow();
  const start = Math.floor(now / rule.window) * rule.window;
  const resetAt = start + rule.window;
  const row = await db
    .prepare(
      "INSERT INTO rate_limits (bucket, count, expires_at) VALUES (?, 1, ?) " +
        "ON CONFLICT (bucket) DO UPDATE SET count = count + 1 RETURNING count",
    )
    .bind(bucketKey(name, subject, rule, now), resetAt + DAY)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return { allowed: count <= rule.limit, count, limit: rule.limit, resetAt, retryAfter: Math.max(1, resetAt - now) };
}

/** Reads the count without adding a hit (for "is the admin login locked?"). */
export async function peek(
  db: Db,
  name: RateLimitName | string,
  subject: string,
  options: { rule?: RateLimitRule; now?: number } = {},
): Promise<RateLimitResult> {
  const rule = options.rule ?? (RATE_LIMITS as Record<string, RateLimitRule>)[name];
  if (!rule) throw new Error(`ratelimit: unknown rule "${name}"`);
  const now = options.now ?? unixNow();
  const start = Math.floor(now / rule.window) * rule.window;
  const resetAt = start + rule.window;
  const row = await db
    .prepare("SELECT count FROM rate_limits WHERE bucket = ?")
    .bind(bucketKey(name, subject, rule, now))
    .first<{ count: number }>();
  const count = row?.count ?? 0;
  return { allowed: count < rule.limit, count, limit: rule.limit, resetAt, retryAfter: Math.max(1, resetAt - now) };
}

/** Deletes expired buckets. Returns how many rows went. */
export async function cleanupRateLimits(db: Db, now = unixNow()): Promise<number> {
  const result = await db.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(now).run();
  return result.meta.changes;
}
