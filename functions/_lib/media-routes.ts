/**
 * The HTTP side of W4's admin media endpoints: admin check, method, CSRF, body and error mapping.
 * The route files under functions/api/admin/ are one line each and call these.
 *
 * Admin authentication is W5's: its middleware (functions/api/admin/_middleware.ts) checks the
 * admin cookie and sets `context.data.admin`. These handlers refuse (401) when it isn't there, so
 * until W5 is merged the endpoints are closed, never open.
 */
import { hasDb, type Context } from "./env.ts";
import { error, errorResponse, isJson, json, methodNotAllowed, readJson, sameOrigin } from "./http.ts";
import { COMPLETE_MAX_BYTES, completeUpload, deleteMedia, listMedia, startUpload, uploadPart, UploadError } from "./uploads.ts";
import { ValidationError } from "./db/errors.ts";

/** True when W5's admin middleware authenticated this request. */
export function isAdmin(data: unknown): boolean {
  const admin = (data as { admin?: unknown } | null | undefined)?.admin;
  return typeof admin === "object" && admin !== null;
}

type Handler = (context: Context) => Promise<Response>;

function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}

function mapError(err: unknown): Response {
  if (err instanceof UploadError) return error(err.status, err.code, err.message);
  if (err instanceof ValidationError && (err.code === "upload_invalid" || err.code === "upload_too_large")) {
    return error(err.code === "upload_too_large" ? 413 : 400, err.code, err.message, { fields: { [err.field]: err.message } });
  }
  return errorResponse(err);
}

/** Wraps a handler with the checks every admin media endpoint shares. */
function adminEndpoint(methods: readonly string[], body: "json" | "bytes" | "none", handle: Handler): Handler {
  return async (context) => {
    const { request, env } = context;
    if (!methods.includes(request.method)) return methodNotAllowed(methods);
    if (!isAdmin(context.data)) return noStore(error(401, "unauthorized", "Sign in to the admin first."));
    if (request.method !== "GET" && !sameOrigin(request)) return noStore(error(403, "cross_origin", "Cross-site request refused."));
    if (body === "json" && !isJson(request)) return noStore(error(415, "unsupported_media_type", "Send JSON."));
    if (body === "bytes" && (request.headers.get("Content-Type") ?? "").toLowerCase().split(";")[0]!.trim() !== "application/octet-stream") {
      return noStore(error(415, "unsupported_media_type", "Send the part as application/octet-stream."));
    }
    if (!hasDb(env) || !env.MEDIA) return noStore(error(503, "platform_not_configured", "Media storage isn't set up yet."));
    try {
      return noStore(await handle(context));
    } catch (err) {
      return noStore(mapError(err));
    }
  };
}

const param = (context: Context, name: string): string => {
  const value = context.params[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
};

/** POST /api/admin/uploads */
export const onStartUpload = adminEndpoint(["POST"], "json", async ({ request, env }) => {
  const body = await readJson(request);
  if (!body.ok) return body.response;
  return json(await startUpload(env, body.value), 201);
});

/** PUT /api/admin/uploads/:id/parts/:n */
export const onUploadPart = adminEndpoint(["PUT"], "bytes", async (context) => {
  const { request, env } = context;
  const header = request.headers.get("Content-Length");
  const declared = header !== null && /^\d{1,12}$/.test(header) ? Number(header) : null;
  return json(await uploadPart(env, param(context, "id"), param(context, "n"), () => request.arrayBuffer(), declared));
});

/** POST /api/admin/uploads/:id/complete */
export const onCompleteUpload = adminEndpoint(["POST"], "json", async (context) => {
  const body = await readJson(context.request, COMPLETE_MAX_BYTES);
  if (!body.ok) return body.response;
  return json(await completeUpload(context.env, param(context, "id"), body.value));
});

/** DELETE /api/admin/uploads/:id[?force=1] */
export const onDeleteMedia = adminEndpoint(["DELETE"], "none", async (context) => {
  const force = new URL(context.request.url).searchParams.get("force") === "1";
  await deleteMedia(context.env, param(context, "id"), force);
  return new Response(null, { status: 204 });
});

/** GET /api/admin/media */
export const onListMedia = adminEndpoint(["GET"], "none", async ({ request, env }) => {
  return json(await listMedia(env, new URL(request.url).searchParams));
});
