/**
 * Serves lesson media from R2 (W4): GET and HEAD /media/v/<lessonId> (video) and /media/c/<lessonId>
 * (captions) behind signed URLs, and /media/i/<key> (public images).
 *
 * Every video or captions request, in order:
 * 1. method GET or HEAD;
 * 2. no hotlinking: a request another site made (Sec-Fetch-Site: cross-site, or a Referer from a
 *    host that isn't ours) or one that isn't a media load (Sec-Fetch-Dest other than video, audio,
 *    track or empty) is refused, and every answer carries Cross-Origin-Resource-Policy: same-site;
 * 3. the signed link (media.ts verifyMediaLink): shape, expiry (2 h), HMAC;
 * 4. student links: the request's session cookie must hash to the link's session tag, and D1 must
 *    still have that session live AND an active enrollment in the lesson's course (a revoked
 *    device, a refund or an expired year stops playback within LIVE_CHECK_TTL, the time a passed
 *    check is reused). Public links: the lesson must be a free preview of a published course;
 * 5. the object is streamed from R2 with byte ranges (206 Partial Content, 416 when unsatisfiable),
 *    ETag and If-Range, so seeking works and nothing is buffered in memory.
 *
 * Refusals are 403 / 404 with the JSON error shape; the player can't read them, it just asks the
 * play endpoint for fresh links.
 */
import { DEFAULT_APEX_DOMAIN } from "../../src/shared/constants.ts";
import { config, MEDIA_URL_TTL, PUBLIC_SESSION_TAG } from "./config.ts";
import { unixNow } from "./db/d1.ts";
import { hasDb, type Env } from "./env.ts";
import { error, errorResponse, methodNotAllowed, securityHeaders } from "./http.ts";
import { sessionTokenHash, verifyMediaLink, type MediaUrlKind } from "./media.ts";
import { fallbackContentType, MEDIA_KEY_RE } from "./media-rules.ts";

/** How long a passed D1 check (session + enrollment) is reused by this isolate. */
export const LIVE_CHECK_TTL = 60;
const LIVE_CHECK_MAX_ENTRIES = 500;

const ALLOWED_DEST: Readonly<Record<MediaUrlKind | "i", readonly string[]>> = {
  v: ["video", "audio", "empty"],
  c: ["track", "empty"],
  i: ["image", "empty", "document"],
};

// ---------------------------------------------------------------- hotlinking

/** Hosts whose pages may load our media: the hub, the apex and its subdomains (course hosts). */
export function isOwnHost(host: string, env: Partial<Env>): boolean {
  const cfg = config(env);
  const h = host.toLowerCase();
  if (h === cfg.hubHost) return true;
  for (const apex of new Set([cfg.apexDomain, DEFAULT_APEX_DOMAIN])) {
    if (h === apex || h.endsWith(`.${apex}`)) return true;
  }
  // Preview deployments (<hash>.<project>.pages.dev) serve their own media.
  return cfg.appEnv !== "production" && h.endsWith(".pages.dev");
}

/** Why a request looks like hotlinking or a non-media load, or null when it's fine. */
export function hotlinkRefusal(request: Request, env: Partial<Env>, kind: MediaUrlKind | "i"): string | null {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site === "cross-site") return "cross-site";
  const dest = request.headers.get("Sec-Fetch-Dest");
  if (dest !== null && !ALLOWED_DEST[kind].includes(dest)) return `dest:${dest}`;
  const referer = request.headers.get("Referer");
  if (referer) {
    let host: string;
    try {
      host = new URL(referer).hostname;
    } catch {
      return "referer";
    }
    if (host !== new URL(request.url).hostname && !isOwnHost(host, env)) return "referer";
  }
  return null;
}

// ---------------------------------------------------------------- ranges

export type ByteRange = { offset: number; length?: number } | { suffix: number };

/**
 * Parses a Range header. undefined = serve the whole object (no header, a syntax R2 can't serve
 * such as several ranges, or nonsense: RFC 9110 says ignore it). "unsatisfiable" = answer 416.
 */
export function parseRange(header: string | null): ByteRange | "unsatisfiable" | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    return suffix === 0 ? "unsatisfiable" : { suffix };
  }
  const offset = Number(m[1]);
  if (m[2] === "") return { offset };
  const end = Number(m[2]);
  if (end < offset) return undefined;
  return { offset, length: end - offset + 1 };
}

/** The bytes a range covers in an object of `size` bytes, or null when it covers none. */
export function resolveRange(range: ByteRange, size: number): { start: number; end: number } | null {
  if ("suffix" in range) {
    if (size === 0) return null;
    return { start: Math.max(0, size - range.suffix), end: size - 1 };
  }
  if (range.offset >= size) return null;
  const end = range.length === undefined ? size - 1 : Math.min(size - 1, range.offset + range.length - 1);
  return { start: range.offset, end };
}

// ---------------------------------------------------------------- D1 checks

interface LessonMedia {
  video_provider: string;
  video_ref: string | null;
  captions_key: string | null;
}

const liveChecks = new Map<string, { until: number; media: LessonMedia }>();

/** For tests: forget cached checks. */
export function resetLiveChecks(): void {
  liveChecks.clear();
}

/** A D1 lookup whose passes are reused by this isolate for LIVE_CHECK_TTL (failures never are). */
async function cached(cacheKey: string, now: number, lookup: () => Promise<LessonMedia | null>): Promise<LessonMedia | null> {
  const hit = liveChecks.get(cacheKey);
  if (hit && hit.until > now) return hit.media;
  if (hit) liveChecks.delete(cacheKey);
  const media = await lookup();
  if (!media) return null;
  if (liveChecks.size >= LIVE_CHECK_MAX_ENTRIES) {
    const oldest = liveChecks.keys().next().value;
    if (oldest !== undefined) liveChecks.delete(oldest);
  }
  liveChecks.set(cacheKey, { until: now + LIVE_CHECK_TTL, media });
  return media;
}

/**
 * The lesson's media when the session (by full token hash) is live and enrolled in the lesson's
 * course, else null. One indexed query.
 */
async function studentLessonMedia(env: Env, tokenHash: string, lessonId: number, now: number): Promise<LessonMedia | null> {
  const liveOnly = config(env).paymentMode === "live" ? 1 : 0;
  return env.DB.prepare(
    "SELECT l.video_provider, l.video_ref, l.captions_key FROM sessions s " +
      "JOIN lessons l ON l.id = ? " +
      "JOIN courses c ON c.id = l.course_id AND c.deleted_at IS NULL " +
      "JOIN enrollments e ON e.student_id = s.student_id AND e.course_id = l.course_id " +
      "WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? " +
      "AND e.revoked_at IS NULL AND e.starts_at <= ? AND (e.expires_at IS NULL OR e.expires_at > ?) " +
      "AND (? = 0 OR e.mode = 'live') LIMIT 1",
  )
    .bind(lessonId, tokenHash, now, now, now, liveOnly)
    .first<LessonMedia>();
}

/** The lesson's media when it is a free preview of a published, not deleted course. */
async function previewLessonMedia(env: Env, lessonId: number): Promise<LessonMedia | null> {
  return env.DB.prepare(
    "SELECT l.video_provider, l.video_ref, l.captions_key FROM lessons l JOIN courses c ON c.id = l.course_id " +
      "WHERE l.id = ? AND l.free_preview = 1 AND c.status = 'published' AND c.deleted_at IS NULL",
  )
    .bind(lessonId)
    .first<LessonMedia>();
}

// ---------------------------------------------------------------- responses

function refuse(status: 403 | 404, extra: Record<string, string> = {}): Response {
  const res =
    status === 403 ? error(403, "forbidden", "This video link has expired or isn't yours. Reload the lesson.") : error(404, "not_found", "Not found.");
  const headers = securityHeaders(new Headers(res.headers), { frameDeny: true });
  headers.set("Cross-Origin-Resource-Policy", "same-site");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status, headers });
}

interface ServeOptions {
  kind: MediaUrlKind | "i";
  /** Cache-Control for a successful answer. */
  cacheControl: string;
  /** Cross-Origin-Resource-Policy. */
  corp: "same-site" | "cross-origin";
}

/**
 * Streams `key` from R2 with Range, If-Range and If-None-Match support. 404 when the object is
 * missing. Exported for the tests.
 */
export async function serveObject(env: Env, request: Request, key: string, options: ServeOptions): Promise<Response> {
  const bucket = env.MEDIA;
  const head = request.method === "HEAD";
  const baseHeaders = (): Headers => {
    const h = securityHeaders(new Headers(), { frameDeny: true });
    h.set("Accept-Ranges", "bytes");
    h.set("Cache-Control", options.cacheControl);
    h.set("Cross-Origin-Resource-Policy", options.corp);
    h.set("X-Robots-Tag", "noindex, nofollow");
    h.set("Content-Disposition", "inline");
    h.set("Vary", "Range");
    return h;
  };

  let range = parseRange(request.headers.get("Range"));
  const ifRange = request.headers.get("If-Range");

  // HEAD: metadata only.
  if (head) {
    const obj = await bucket.head(key);
    if (!obj) return refuse(404);
    const h = baseHeaders();
    h.set("Content-Type", obj.httpMetadata?.contentType || fallbackContentType(options.kind));
    h.set("Content-Length", String(obj.size));
    h.set("ETag", obj.httpEtag);
    return new Response(null, { status: 200, headers: h });
  }

  if (range === "unsatisfiable") {
    const obj = await bucket.head(key);
    if (!obj) return refuse(404);
    return rangeNotSatisfiable(obj.size, baseHeaders());
  }

  let obj: R2ObjectBody | R2Object | null;
  try {
    obj = await bucket.get(key, range ? { range } : {});
  } catch (err) {
    // R2 refuses a range that doesn't fit the object. Look at the size: past the end is 416;
    // otherwise ask again for exactly the bytes that exist. Any other R2 failure is a 500.
    if (!range) throw err;
    const meta = await bucket.head(key);
    if (!meta) return refuse(404);
    const span = resolveRange(range, meta.size);
    if (!span) return rangeNotSatisfiable(meta.size, baseHeaders());
    range = { offset: span.start, length: span.end - span.start + 1 };
    obj = await bucket.get(key, { range });
  }
  if (!obj || !("body" in obj)) return refuse(404);

  // If-Range: the client's copy changed, so send the whole new object instead of a piece.
  if (range && ifRange !== null && ifRange.trim() !== obj.httpEtag) {
    await obj.body.cancel();
    range = undefined;
    obj = await bucket.get(key);
    if (!obj || !("body" in obj)) return refuse(404);
  }

  const h = baseHeaders();
  h.set("Content-Type", obj.httpMetadata?.contentType || fallbackContentType(options.kind));
  h.set("ETag", obj.httpEtag);
  h.set("Last-Modified", obj.uploaded.toUTCString());

  const ifNoneMatch = request.headers.get("If-None-Match");
  if (!range && ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === obj.httpEtag || t.trim() === "*")) {
    await obj.body.cancel();
    h.delete("Content-Disposition");
    return new Response(null, { status: 304, headers: h });
  }

  if (range) {
    const span = resolveRange(range, obj.size);
    if (!span) {
      await obj.body.cancel();
      return rangeNotSatisfiable(obj.size, h);
    }
    h.set("Content-Range", `bytes ${span.start}-${span.end}/${obj.size}`);
    h.set("Content-Length", String(span.end - span.start + 1));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers: h });
}

function rangeNotSatisfiable(size: number, headers: Headers): Response {
  headers.set("Content-Range", `bytes */${size}`);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.delete("Content-Disposition");
  return new Response("Range not satisfiable.", { status: 416, headers });
}

/**
 * GET/HEAD /media/<v|c>/<lessonId>?e=&s=&sig=. `now` is for tests.
 */
export async function serveLessonMedia(
  env: Env,
  request: Request,
  kind: MediaUrlKind,
  lessonIdParam: string,
  now: number = unixNow(),
): Promise<Response> {
  try {
    return await lessonMedia(env, request, kind, lessonIdParam, now);
  } catch (err) {
    return errorResponse(err); // APP_SECRET missing → 503; anything else → 500, logged
  }
}

async function lessonMedia(env: Env, request: Request, kind: MediaUrlKind, lessonIdParam: string, now: number): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
  if (hotlinkRefusal(request, env, kind)) return refuse(403);
  if (!hasDb(env) || !env.MEDIA) return refuse(404);

  const link = await verifyMediaLink(env, { kind, lessonId: lessonIdParam, params: new URL(request.url).searchParams }, now);
  if (!link.ok) return refuse(403);

  let media: LessonMedia | null;
  if (link.sidTag === PUBLIC_SESSION_TAG) {
    media = await cached(`public:${link.lessonId}`, now, () => previewLessonMedia(env, link.lessonId));
  } else {
    const tokenHash = await sessionTokenHash(request);
    // Compare the cookie's tag with the signed one first: no D1 query for a link used elsewhere.
    if (!tokenHash || tokenHash.slice(0, 16) !== link.sidTag) return refuse(403);
    media = await cached(`${tokenHash}:${link.lessonId}`, now, () => studentLessonMedia(env, tokenHash, link.lessonId, now));
  }
  if (!media) return refuse(403);

  const key = kind === "v" ? (media.video_provider === "r2" ? media.video_ref : null) : media.captions_key;
  if (!key || !MEDIA_KEY_RE.test(key)) return refuse(404);

  const remaining = Math.max(0, Math.min(MEDIA_URL_TTL, link.exp - now));
  // Private: the URL is tied to one browser. no-transform keeps proxies from re-encoding.
  return serveObject(env, request, key, {
    kind,
    cacheControl: `private, max-age=${remaining}, no-transform`,
    corp: "same-site",
  });
}

/**
 * GET/HEAD /media/i/<key>: course images (cover, social image). Public, but only keys of images the
 * admin uploaded and finished (media row kind image, status ready); never videos or backups.
 */
export async function serveImage(env: Env, request: Request): Promise<Response> {
  try {
    return await image(env, request);
  } catch (err) {
    return errorResponse(err);
  }
}

async function image(env: Env, request: Request): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET", "HEAD"]);
  if (!hasDb(env) || !env.MEDIA) return refuse(404);
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/media/i/")) return refuse(404);
  let key: string;
  try {
    key = path
      .slice("/media/i/".length)
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
  } catch {
    return refuse(404);
  }
  if (!MEDIA_KEY_RE.test(key) || !key.startsWith("images/")) return refuse(404);
  const row = await env.DB.prepare("SELECT id FROM media WHERE key = ? AND kind = 'image' AND status = 'ready'").bind(key).first();
  if (!row) return refuse(404);
  // Keys are unique per upload (random part), so the bytes behind a URL never change.
  return serveObject(env, request, key, { kind: "i", cacheControl: "public, max-age=31536000, immutable", corp: "cross-origin" });
}
