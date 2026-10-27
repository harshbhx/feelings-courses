// Request and Cloudflare Pages Functions context builders, for tests.
//
//   import { SITE, req, postJson, postForm, context, fakeAssets, cookiesFrom, readJson } from "../helpers/http.mjs";
//   const request = postJson("/api/checkout", { course: "basics" }, { cookie: "sid=abc", ip: "203.0.113.7" });
//   const ctx = context({ request, env: { DB: db, ASSETS: fakeAssets({ "/index.html": "<h1>hi</h1>" }) } });
//   const res = await onRequestPost(ctx);
//   assert.equal(ctx.nextCalls.length, 0);
//   assert.equal(cookiesFrom(res).sid.attributes.httponly, true);
//   const json = await readJson(res);
//
// - req() builds an absolute Request on SITE (or https://${host}); object bodies are JSON-encoded;
//   non-GET/HEAD requests get Origin = the request's own origin unless `origin: null` (or a value).
// - context() mimics a Pages EventContext; next() is recorded in ctx.nextCalls, waitUntil() promises
//   in ctx.waitUntilPromises.
// - fakeAssets() is an ASSETS-binding stand-in serving a pathname → body map (404 otherwise).

export const SITE = "https://courses.feelingsbeautycare.in";

const isPlainObject = (v) => v !== null && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null || Array.isArray(v));

/**
 * @param {string} path  "/api/x" (or an absolute URL)
 * @param {{ method?: string, body?: unknown, headers?: HeadersInit, origin?: string | null,
 *           cookie?: string, ip?: string, host?: string }} [opts]
 */
export function req(path, { method, body, headers, origin, cookie, ip, host } = {}) {
  const url = /^https?:\/\//.test(path) ? path : `${host ? `https://${host}` : SITE}${path}`;
  const verb = (method ?? (body === undefined ? "GET" : "POST")).toUpperCase();
  const h = new Headers();
  let payload = body;
  if (isPlainObject(body)) {
    payload = JSON.stringify(body);
    h.set("Content-Type", "application/json");
  }
  if (verb !== "GET" && verb !== "HEAD") {
    if (origin === undefined) h.set("Origin", new URL(url).origin);
    else if (origin !== null) h.set("Origin", origin);
  } else if (origin) {
    h.set("Origin", origin);
  }
  if (cookie) h.set("Cookie", cookie);
  if (ip) h.set("CF-Connecting-IP", ip);
  for (const [k, v] of new Headers(headers ?? {})) h.set(k, v); // explicit headers win
  return new Request(url, { method: verb, headers: h, body: payload ?? undefined });
}

/** POST with a JSON body. */
export const postJson = (path, body, opts = {}) => req(path, { ...opts, method: "POST", body });

/** POST with an application/x-www-form-urlencoded body. */
export const postForm = (path, fields, opts = {}) =>
  req(path, {
    ...opts,
    method: "POST",
    body: new URLSearchParams(fields).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...Object.fromEntries(new Headers(opts.headers ?? {})) },
  });

/**
 * A Pages EventContext-like object.
 * @param {{ request?: Request, env?: object, params?: object, data?: object,
 *           next?: (input?, init?) => Response | Promise<Response>, functionPath?: string }} [opts]
 */
export function context({ request = req("/"), env = {}, params = {}, data = {}, next, functionPath } = {}) {
  const ctx = {
    request,
    env,
    params,
    data,
    functionPath: functionPath ?? new URL(request.url).pathname,
    nextCalls: [],
    waitUntilPromises: [],
    passThroughCalled: false,
    async next(input, init) {
      ctx.nextCalls.push({ input, init });
      return next ? next(input, init) : new Response("next", { status: 200 });
    },
    waitUntil(promise) {
      ctx.waitUntilPromises.push(Promise.resolve(promise));
    },
    passThroughOnException() {
      ctx.passThroughCalled = true;
    },
  };
  return ctx;
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".js": "text/javascript",
  ".css": "text/css",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * An ASSETS Fetcher stand-in.
 * @param {Record<string, string | { body?: BodyInit, status?: number, headers?: HeadersInit }>} files
 */
export function fakeAssets(files = {}) {
  const assets = {
    requests: [],
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(new URL(String(input), SITE), init);
      const { pathname } = new URL(request.url);
      assets.requests.push(pathname);
      const file = files[pathname];
      if (file === undefined) return new Response("Not Found", { status: 404 });
      if (typeof file === "string") {
        const ext = /\.[a-z0-9]+$/i.exec(pathname)?.[0]?.toLowerCase();
        const headers = CONTENT_TYPES[ext] ? { "Content-Type": CONTENT_TYPES[ext] } : {};
        return new Response(file, { status: 200, headers });
      }
      return new Response(file.body ?? null, { status: file.status ?? 200, headers: file.headers });
    },
  };
  return assets;
}

/**
 * Parses every Set-Cookie header of a response.
 * @returns {Record<string, { value: string, attributes: Record<string, string | true> }>}
 */
export function cookiesFrom(response) {
  const out = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(";");
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    const attributes = {};
    for (const attr of attrs) {
      const j = attr.indexOf("=");
      if (j === -1) attributes[attr.trim().toLowerCase()] = true;
      else attributes[attr.slice(0, j).trim().toLowerCase()] = attr.slice(j + 1).trim();
    }
    out[name] = { value, attributes };
  }
  return out;
}

/** Reads a response body as JSON, with the raw text in the error if it is not JSON. */
export async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`readJson: response (${response.status}) is not JSON: ${text.slice(0, 200)}`);
  }
}
