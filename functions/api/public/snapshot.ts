// GET /api/public/snapshot: the published content the build renders (plan 1.1, W1).
//
// - No D1 binding yet (setup not run): 404, so scripts/snapshot.mjs falls back to the seed instead
//   of failing the production build.
// - A D1 error: 5xx, on purpose. The build then fails and the previous deployment stays live,
//   rather than shipping a site with courses missing.
// - Public content only (functions/_lib/snapshot.ts decides what is in it). It is cached at the
//   edge for a few seconds so a burst of requests can't run up D1 reads; a publish is followed by
//   a debounced deploy hook (120 s), so the build never sees a stale copy.
import { buildSnapshot } from "../../_lib/snapshot.ts";
import { hasDb, type Env } from "../../_lib/env.ts";
import { error, errorResponse, json, methodNotAllowed } from "../../_lib/http.ts";

/** Seconds the edge keeps a copy. */
export const SNAPSHOT_EDGE_TTL = 10;

interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function edgeCache(): EdgeCache | null {
  const c = (globalThis as { caches?: { default?: EdgeCache } }).caches;
  return c?.default ?? null;
}

export async function handleSnapshot(
  request: Request,
  env: Partial<Env>,
  waitUntil: (p: Promise<unknown>) => void = () => {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET"]);
  if (!hasDb(env)) return error(404, "not_configured", "The course database isn't set up yet.");

  const cache = edgeCache();
  // The cache key ignores the query string, so ?x=1 can't be used to skip the cache.
  const key = new Request(new URL("/api/public/snapshot", request.url).href, { method: "GET" });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  try {
    const snapshot = await buildSnapshot(env as Env);
    const res = json(snapshot, 200, { "Cache-Control": `public, max-age=0, s-maxage=${SNAPSHOT_EDGE_TTL}` });
    if (cache) waitUntil(cache.put(key, res.clone()));
    return res;
  } catch (err) {
    return errorResponse(err);
  }
}

export const onRequest: PagesFunction<Env> = (context) =>
  handleSnapshot(context.request, context.env, (p) => context.waitUntil(p));
