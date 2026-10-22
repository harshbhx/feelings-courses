/**
 * Cheap request screening before anything else runs (W7). Called first in functions/_middleware.ts,
 * so a junk request costs no D1 query and no asset fetch.
 *
 * Refused:
 * - methods the site never uses (TRACE, CONNECT, WebDAV verbs…)             → 405
 * - URLs longer than MAX_URL_LENGTH                                        → 414
 * - NUL bytes or encoded NULs in the path                                  → 400
 * - a declared body over the path's limit (uploads get UPLOAD_PART_SIZE)   → 413
 *
 * Bodies are checked again where they are read (http.ts readJson caps at 16 KB); this only stops
 * the obvious cases at the door. Rate limits per endpoint live in guard.ts.
 */
import { UPLOAD_PART_SIZE } from "./config.ts";

export const ALLOWED_METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
export const MAX_URL_LENGTH = 2048;
/** Body cap for everything but upload parts. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Upload parts (W4: PUT /api/admin/uploads/:id/parts/:n): one part plus headroom. */
export const MAX_UPLOAD_BODY_BYTES = UPLOAD_PART_SIZE + 1024 * 1024;
/** The Razorpay webhook can carry a large payment entity; Razorpay's own limit is far below this. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

function plain(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

/** The body limit for a path. */
export function bodyLimit(pathname: string): number {
  if (/^\/api\/admin\/uploads\/[^/]+\/parts\/\d+$/.test(pathname)) return MAX_UPLOAD_BODY_BYTES;
  if (pathname === "/api/razorpay/webhook") return MAX_WEBHOOK_BODY_BYTES;
  return MAX_BODY_BYTES;
}

/** A refusal for an obviously bad request, or null to carry on. */
export function screenRequest(request: Request): Response | null {
  const method = request.method.toUpperCase();
  if (!ALLOWED_METHODS.includes(method)) return plain(405, "Method not allowed.", { Allow: ALLOWED_METHODS.join(", ") });
  if (request.url.length > MAX_URL_LENGTH) return plain(414, "That address is too long.");
  const { pathname } = new URL(request.url);
  if (pathname.includes("\u0000") || /%00/i.test(pathname)) return plain(400, "Bad request.");
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size < 0) return plain(400, "Bad request.");
    if (size > bodyLimit(pathname)) return plain(413, "That request is too large.");
  }
  return null;
}

/**
 * Crawlers, link-preview fetchers and monitoring tools: their page views are not counted
 * (/api/t). Not a security check: a bot can claim any user agent.
 */
const BOT_RE =
  /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|headless|lighthouse|pagespeed|curl|wget|python|httpclient|okhttp|axios|node-fetch|go-http|java\/|monitor|uptime/i;

export function isLikelyBot(userAgent: string | null): boolean {
  return !userAgent || userAgent.length < 8 || BOT_RE.test(userAgent);
}
