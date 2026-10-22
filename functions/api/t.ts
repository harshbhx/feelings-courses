// POST /api/t: a page view, for the owner's dashboard (daily_stats.views, plan 1.12, W7).
// Body { c: courses.id or 0 for hub pages, e: "view" }. No cookies, no IP stored beyond the
// rate-limit bucket (about a day).
//
// Always 204 when the request is well-formed, even when it isn't counted (a bot, over the
// track_ip limit, an unpublished course, no database yet), so the endpoint tells a scraper nothing.
import { bump, statDay } from "../_lib/analytics.ts";
import { isLikelyBot } from "../_lib/abuse.ts";
import { unixNow } from "../_lib/db/d1.ts";
import { hasDb, type Env } from "../_lib/env.ts";
import { enforceRateLimits, ipSubject } from "../_lib/guard.ts";
import { error, isJson, methodNotAllowed, readJson, sameOrigin } from "../_lib/http.ts";

const noContent = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

export async function handleTrack(request: Request, env: Partial<Env>, now: number = unixNow()): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(["POST"]);
  if (!sameOrigin(request)) return error(403, "forbidden", "Cross-site requests are not accepted.");
  if (!isJson(request)) return error(415, "unsupported_media_type", "Send JSON.");
  const body = await readJson(request, 512);
  if (!body.ok) return body.response;
  const { c, e } = body.value;
  if (e !== "view" || typeof c !== "number" || !Number.isSafeInteger(c) || c < 0) {
    return error(400, "invalid_details", "Expected { c: course id, e: \"view\" }.");
  }
  if (!hasDb(env) || isLikelyBot(request.headers.get("User-Agent"))) return noContent();

  const db = env.DB;
  const limited = await enforceRateLimits(db, [{ rule: "track_ip", subject: ipSubject(request) }], { now });
  if (limited) return noContent();
  try {
    if (c !== 0) {
      const course = await db.prepare("SELECT 1 AS ok FROM courses WHERE id = ? AND status = 'published' AND deleted_at IS NULL").bind(c).first();
      if (!course) return noContent();
    }
    await bump(db, statDay(now), c, "views").run();
  } catch (err) {
    console.error(`track: ${err instanceof Error ? err.message : String(err)}`);
  }
  return noContent();
}

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleTrack(request, env);
