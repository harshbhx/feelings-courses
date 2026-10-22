/**
 * HTTP helpers for every Pages Function. Moved out of checkout.ts (W0) with the same behaviour, so
 * all endpoints answer in one shape:
 *   success  JSON, Cache-Control: no-store
 *   error    { error: code, message, fields? } (src/shared/api.ts ApiErrorBody)
 *
 * Responses made by Functions don't get the rules in public/_headers, so HTML responses and
 * redirects from Functions pass through securityHeaders().
 */
import type { ApiErrorBody } from "../../src/shared/api.ts";
import { MAX_JSON_BYTES } from "./config.ts";
import { ValidationError, ConflictError } from "./db/errors.ts";
import { ConfigError } from "./config.ts";
import { NotImplementedError } from "./stub.ts";

const JSON_TYPE = "application/json; charset=utf-8";

/** A JSON response, never cached. */
export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", ...headers },
  });
}

/** An error response: { error: code, message, fields? }. */
export function error(
  status: number,
  code: string,
  message: string,
  extra: Pick<ApiErrorBody, "fields" | "retryAfter"> = {},
  headers: Record<string, string> = {},
): Response {
  const body: ApiErrorBody = { error: code, message, ...extra };
  return json(body, status, headers);
}

/** 405 with an Allow header. The default matches the demo checkout ("Use POST."). */
export function methodNotAllowed(allow: readonly string[] = ["POST"]): Response {
  return new Response(JSON.stringify({ error: "method_not_allowed", message: `Use ${allow.join(" or ")}.` }), {
    status: 405,
    headers: { Allow: allow.join(", "), "Content-Type": JSON_TYPE, "Cache-Control": "no-store" },
  });
}

/**
 * A redirect to `path`, resolved against the request's URL (so a path stays on the same host; pass
 * an absolute URL to change host). 303 by default: after a POST the browser follows with a GET.
 */
export function redirect(request: Request, path: string, cookie?: string | string[], status = 303): Response {
  const headers = new Headers({ Location: new URL(path, request.url).href, "Cache-Control": "no-store" });
  for (const value of cookie === undefined ? [] : Array.isArray(cookie) ? cookie : [cookie]) {
    headers.append("Set-Cookie", value);
  }
  return new Response(null, { status, headers: securityHeaders(headers) });
}

/** A browser always sends Origin on a cross-site POST; when it's there it must be this site. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

/** True when the request declares a JSON body (mutating endpoints require it, plan section 5 CSRF). */
export function isJson(request: Request): boolean {
  return (request.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json");
}

/** The body as text, or null when it is over `maxBytes`. */
export async function readBody(request: Request, maxBytes = MAX_JSON_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).length > maxBytes ? null : text;
}

export type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false; response: Response };

/** Reads a JSON object body. An empty body is {}. Arrays and other values are refused (400). */
export async function readJson(request: Request, maxBytes = MAX_JSON_BYTES): Promise<JsonBody> {
  const text = await readBody(request, maxBytes);
  if (text === null) return { ok: false, response: error(413, "too_large", "That request is too large.") };
  if (text.trim() === "") return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value };
  } catch {
    /* falls through */
  }
  return { ok: false, response: error(400, "invalid_json", "The request body must be a JSON object.") };
}

/** Reads a form body (application/x-www-form-urlencoded), or null when too large. */
export async function readForm(request: Request, maxBytes = MAX_JSON_BYTES): Promise<URLSearchParams | null> {
  const text = await readBody(request, maxBytes);
  return text === null ? null : new URLSearchParams(text);
}

/** The headers public/_headers gives static pages, for responses made by Functions. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
};

/**
 * Adds the security headers (without overwriting ones already set). `frameDeny` adds
 * X-Frame-Options: DENY (admin, learn and account responses, plan 1.19); otherwise SAMEORIGIN.
 */
export function securityHeaders(headers: Headers = new Headers(), options: { frameDeny?: boolean } = {}): Headers {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (!headers.has("X-Frame-Options")) headers.set("X-Frame-Options", options.frameDeny ? "DENY" : "SAMEORIGIN");
  return headers;
}

/** The client's IP as Cloudflare reports it ("unknown" in tests without the header). */
export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "unknown";
}

/**
 * Maps the data layer's thrown errors to responses: ValidationError → 400 invalid_details with the
 * field, ConflictError → 409, ConfigError → 503 platform_not_configured, NotImplementedError → 501. Anything else → 500 (the
 * message is logged, never sent).
 */
export function errorResponse(err: unknown): Response {
  if (err instanceof ValidationError) {
    return error(400, "invalid_details", err.message, { fields: { [err.field]: err.message } });
  }
  if (err instanceof ConflictError) return error(409, err.code, err.message);
  if (err instanceof ConfigError) {
    console.error(`config: ${err.secret} missing`);
    return error(503, "platform_not_configured", "This part of the site isn't set up yet.");
  }
  if (err instanceof NotImplementedError) return error(501, "not_implemented", "This isn't available yet.");
  console.error(`server: ${err instanceof Error ? err.message : "unknown error"}`);
  return error(500, "server_error", "Something went wrong. Please try again.");
}
