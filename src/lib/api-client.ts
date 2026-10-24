/**
 * Typed fetch for browser code (learn, account, admin, checkout). Same-origin only: paths start
 * with "/". JSON in, JSON out; errors become ApiError with the server's code and message.
 *
 *   const me = await api<MeResponse>("/api/me");
 *   const quote = await api<CouponQuoteResponse>("/api/coupon/quote", { method: "POST", json: { course, code } });
 *
 * The endpoint map in src/shared/api.ts names every path's types; `call()` uses it:
 *
 *   const me = await call("GET /api/me");
 *   const refund = await call("POST /api/admin/orders/:id/refund", { id: 12 }, { reason, revoke: true });
 */
import type { ApiErrorBody, EndpointKey, RequestOf, ResponseOf } from "../shared/api.ts";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;
  readonly retryAfter: number | null;

  constructor(status: number, body: Partial<ApiErrorBody>) {
    super(body.message || "Something went wrong. Please try again.");
    this.name = "ApiError";
    this.status = status;
    this.code = typeof body.error === "string" ? body.error : status === 0 ? "network_error" : "server_error";
    this.fields = body.fields ?? {};
    this.retryAfter = typeof body.retryAfter === "number" ? body.retryAfter : null;
  }

  /** No network, or the request never reached the server. */
  get offline(): boolean {
    return this.status === 0;
  }
}

export interface ApiInit extends Omit<RequestInit, "body"> {
  /** Sent as JSON with Content-Type: application/json. */
  json?: unknown;
  /** Raw body (upload parts). */
  body?: BodyInit | null;
  /** Abort after this many milliseconds (default 20 s). */
  timeoutMs?: number;
}

/** Calls a same-origin API path. Resolves with the parsed JSON (undefined for 204), rejects with ApiError. */
export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`api: "${path}" must be a same-origin path`);
  const { json, timeoutMs = 20_000, headers, ...rest } = init;
  const h = new Headers(headers);
  h.set("Accept", "application/json");
  let body = init.body ?? null;
  if (json !== undefined) {
    h.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      body,
      headers: h,
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError(0, { message: "You seem to be offline. Check your connection and try again." });
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!res.ok) throw new ApiError(res.status, (data as Partial<ApiErrorBody>) ?? {});
  return data as T;
}

/** Fills ":name" segments from `params` (URL-encoded). */
export function fillPath(template: string, params: Record<string, string | number> = {}): string {
  return template.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`api: missing path parameter "${name}"`);
    return encodeURIComponent(String(value));
  });
}

/**
 * Calls an endpoint by its key in the endpoint map. For GET, `body` becomes the query string.
 */
export function call<K extends EndpointKey>(
  key: K,
  params: Record<string, string | number> = {},
  body?: RequestOf<K>,
  init: ApiInit = {},
): Promise<ResponseOf<K>> {
  const space = key.indexOf(" ");
  const method = key.slice(0, space);
  let path = fillPath(key.slice(space + 1), params);
  if (method === "GET" || method === "HEAD") {
    if (body && typeof body === "object") {
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
        if (v !== undefined && v !== null) query.set(k, String(v));
      }
      const qs = query.toString();
      if (qs) path += `?${qs}`;
    }
    return api<ResponseOf<K>>(path, { ...init, method });
  }
  return api<ResponseOf<K>>(path, { ...init, method, ...(body !== undefined ? { json: body } : {}) });
}
