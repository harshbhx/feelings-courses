/**
 * The gate in front of every /api/admin/* route (W5), mounted by functions/api/admin/_middleware.ts.
 *
 *   1. No D1 binding yet (before the owner runs setup): 503 platform_not_configured.
 *   2. Production answers only on the hub host (the admin cookie is host-only anyway).
 *   3. Writes (POST, PUT, DELETE) must carry this site's Origin, and a body must be JSON, except
 *      W4's upload parts under /api/admin/uploads/ (binary). Together with the SameSite=Strict
 *      cookie this is the CSRF defence (plan section 5).
 *   4. Every route except POST /api/admin/login needs a valid admin session (401 otherwise).
 *   5. W7's lazy daily job gets a chance to run (in waitUntil, never blocking the response).
 *   6. Every response gets no-store, the security headers with X-Frame-Options: DENY, and noindex.
 */
import { config } from "../config.ts";
import { maybeRunDaily } from "../daily.ts";
import { unixNow } from "../db/d1.ts";
import { hasDb, type Env } from "../env.ts";
import { error, isJson, securityHeaders } from "../http.ts";
import { NotImplementedError } from "../stub.ts";
import { adminToken, clearAdminCookie, readAdminSession } from "./auth.ts";
import { adminErrorResponse, type AdminContext } from "./request.ts";

export interface AdminMiddlewareContext extends AdminContext {
  next(): Promise<Response>;
}

/** Routes that answer without a session. */
const PUBLIC_ROUTES = new Set(["POST /api/admin/login"]);
/** W4's multipart upload parts are raw bytes, not JSON. */
const BINARY_PREFIX = "/api/admin/uploads/";

function finish(response: Response): Response {
  const out = new Response(response.body, response);
  securityHeaders(out.headers, { frameDeny: true });
  if (!out.headers.has("Cache-Control")) out.headers.set("Cache-Control", "no-store");
  out.headers.set("X-Robots-Tag", "noindex, nofollow");
  return out;
}

async function gate(ctx: AdminMiddlewareContext, now: number): Promise<Response> {
  const { request, env } = ctx;
  if (!hasDb(env)) return error(503, "platform_not_configured", "The admin isn't set up yet.");

  const url = new URL(request.url);
  const cfg = config(env);
  if (cfg.appEnv === "production" && url.hostname !== cfg.hubHost) return error(404, "not_found", "Not found.");

  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    if (request.headers.get("Origin") !== url.origin) {
      return error(403, "cross_origin", "This request must come from the admin itself.");
    }
    const type = request.headers.get("Content-Type");
    const length = request.headers.get("Content-Length");
    const hasBody = type !== null || (length !== null && length !== "0");
    if (hasBody && !isJson(request) && !url.pathname.startsWith(BINARY_PREFIX)) {
      return error(415, "unsupported_media_type", "Send JSON (Content-Type: application/json).");
    }
  }

  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (!PUBLIC_ROUTES.has(`${method} ${path}`)) {
    const session = await readAdminSession(env.DB, request, now);
    if (!session) {
      const headers: Record<string, string> = adminToken(request) ? { "Set-Cookie": clearAdminCookie() } : {};
      return error(401, "unauthorized", "Please sign in to the admin.", {}, headers);
    }
    ctx.data.admin = { sessionId: session.id, expiresAt: session.expiresAt };
  }

  runDailyInBackground(ctx);
  return ctx.next();
}

/** maybeRunDaily (W7) never blocks or breaks an admin response. Until W7 lands it is a stub. */
function runDailyInBackground(ctx: AdminMiddlewareContext): void {
  const job = Promise.resolve()
    .then(() => maybeRunDaily(ctx.env, ctx))
    .catch((err) => {
      if (!(err instanceof NotImplementedError)) console.error(`daily: ${err instanceof Error ? err.message : "failed"}`);
    });
  try {
    ctx.waitUntil(job);
  } catch {
    /* no waitUntil (tests): the promise still settles on its own */
  }
}

export async function adminMiddleware(ctx: AdminMiddlewareContext, now = unixNow()): Promise<Response> {
  let response: Response;
  try {
    response = await gate(ctx, now);
  } catch (err) {
    response = adminErrorResponse(err);
  }
  return finish(response);
}

/** The Pages export (functions/api/admin/_middleware.ts). */
export function adminMiddlewareHandler(context: EventContext<Env, any, any>): Promise<Response> {
  return adminMiddleware(context as unknown as AdminMiddlewareContext);
}
