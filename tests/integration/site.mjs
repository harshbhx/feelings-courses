// A small stand-in for Cloudflare Pages' Functions router, so the integration tests run requests
// through the real files: functions/_middleware.ts first (screening, migration, host routing, the
// course-area gate), then any folder _middleware.ts, then the route file the path matches. Route
// files are found on disk, so a new route is covered without editing this file.
//
//   const site = createSite(env, { assets });
//   const res = await site.fetch(req("https://glow.feelingsbeautycare.in/api/order", { body }));
//
// Pages rules followed here: [name] matches one segment, [[name]] matches the rest, index.ts is
// the folder itself, a static segment beats a parameter, onRequest<Method> beats onRequest, and a
// path without a route goes to static assets (env.ASSETS). Not covered: _routes.json (every path
// runs Functions here), and the Pages runtime's own 405s.

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { context } from "../helpers/http.mjs";

const FUNCTIONS = fileURLToPath(new URL("../../functions/", import.meta.url));

/** Every route file and folder middleware under functions/ (not _lib, not _generated). */
export function routeFiles(dir = FUNCTIONS) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "_lib" || entry.name === "_generated" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") && entry.name !== "tsconfig.json") {
      const rel = relative(FUNCTIONS, full).split(sep).join("/");
      // Underscore files other than _middleware are helpers (learn/_gate.ts), not routes.
      if (entry.name.startsWith("_") && entry.name !== "_middleware.ts") continue;
      out.push(rel);
    }
  }
  return out.sort();
}

/** "api/orders/[id]/refund.ts" → { segments: ["api", "orders", ":id", "refund"], file } */
function parseRoute(file) {
  const parts = file.replace(/\.ts$/, "").split("/");
  if (parts.at(-1) === "index") parts.pop();
  const segments = parts.map((p) => {
    const rest = /^\[\[(\w+)\]\]$/.exec(p);
    if (rest) return { rest: rest[1] };
    const param = /^\[(\w+)\]$/.exec(p);
    return param ? { param: param[1] } : { text: p };
  });
  return { file, segments };
}

function match(route, pathSegments) {
  const params = {};
  let i = 0;
  for (const seg of route.segments) {
    if (seg.rest) {
      params[seg.rest] = pathSegments.slice(i);
      return { params, score: route.segments.length * 10 - 5 };
    }
    if (i >= pathSegments.length) return null;
    const value = pathSegments[i];
    if (seg.text !== undefined && seg.text !== value) return null;
    if (seg.param) params[seg.param] = value;
    i += 1;
  }
  if (i !== pathSegments.length) return null;
  // Static segments score higher than parameters.
  const score = route.segments.reduce((s, seg) => s + (seg.text !== undefined ? 10 : 5), 0);
  return { params, score };
}

const modules = new Map();
async function load(file) {
  if (!modules.has(file)) modules.set(file, import(pathToFileURL(join(FUNCTIONS, file)).href));
  return modules.get(file);
}

function handlerOf(mod, method) {
  const named = `onRequest${method[0]}${method.slice(1).toLowerCase()}`;
  return mod[named] ?? mod.onRequest ?? null;
}

const ROUTES = routeFiles()
  .filter((f) => !f.endsWith("_middleware.ts"))
  .map(parseRoute);
const MIDDLEWARES = routeFiles()
  .filter((f) => f.endsWith("_middleware.ts") && f !== "_middleware.ts")
  .map((f) => ({ file: f, prefix: f.slice(0, -"_middleware.ts".length).replace(/\/$/, "").split("/").filter(Boolean) }));

/** The route file Pages would pick for `pathname`, with its params, or null. */
export function findRoute(pathname) {
  const segments = pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  let best = null;
  for (const route of ROUTES) {
    const m = match(route, segments);
    if (m && (!best || m.score > best.score)) best = { ...m, file: route.file };
  }
  return best;
}

/**
 * @param {object} env  the Pages env (DB, MEDIA, ASSETS, secrets…)
 * @returns {{ fetch(request: Request): Promise<Response>, waitUntil: Promise<unknown>[] }}
 */
export function createSite(env) {
  const waitUntil = [];
  async function dispatch(request) {
    const url = new URL(request.url);
    const route = findRoute(url.pathname);
    if (!route) return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not Found", { status: 404 });
    const mod = await load(route.file);
    const handler = handlerOf(mod, request.method);
    if (!handler) return new Response(null, { status: 405 });
    // Folder middlewares that cover this route, outermost first.
    const segments = url.pathname.split("/").filter(Boolean);
    const chain = MIDDLEWARES.filter((m) => m.prefix.every((p, i) => segments[i] === p)).sort((a, b) => a.prefix.length - b.prefix.length);
    const ctx = context({ request, env, params: route.params });
    ctx.waitUntil = (p) => waitUntil.push(Promise.resolve(p).catch(() => undefined));
    let step = 0;
    const run = async () => {
      if (step < chain.length) {
        const m = chain[step++];
        const mw = await load(m.file);
        return mw.onRequest(ctx);
      }
      return handler(ctx);
    };
    ctx.next = run;
    return run();
  }

  const root = load("_middleware.ts");
  return {
    waitUntil,
    async fetch(request) {
      const { onRequest } = await root;
      const ctx = context({ request, env, next: () => dispatch(request) });
      ctx.waitUntil = (p) => waitUntil.push(Promise.resolve(p).catch(() => undefined));
      return onRequest(ctx);
    },
  };
}
