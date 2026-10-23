// An ASSETS binding over the built site (dist/), with the Cloudflare Pages rules the e2e journeys
// rely on: `build.format: "file"` pages (/c/glow → c/glow.html, / → index.html, /x.html → 308 /x),
// dist/_headers (the hashed Content-Security-Policy included, so a script the policy would block
// fails in the browser here too), dist/_redirects (plain 30x lines) and 404.html for a miss.
// Files are read on each request, so the server can start before the build finishes.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** Parses a Pages _headers file into [{ pattern: RegExp, headers: [name, value][] }]. */
export function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const source = raw.trim();
      const re = source
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]\w*/g, "[^/]+"))
        .join(".*");
      current = { source, pattern: new RegExp(`^${re}$`), headers: [] };
      rules.push(current);
      continue;
    }
    const line = raw.trim();
    const i = line.indexOf(":");
    if (current && i > 0) current.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return rules;
}

/** Parses a Pages _redirects file into [{ from, to, status }] (exact paths only). */
function parseRedirects(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [from, to, status] = l.split(/\s+/);
      return { from, to, status: Number(status) || 302 };
    });
}

export function distAssets(dist) {
  const read = (name) => {
    const file = join(dist, name);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  };
  const isFile = (rel) => {
    const file = join(dist, rel);
    return existsSync(file) && statSync(file).isFile() ? file : null;
  };

  function headersFor(pathname) {
    const headers = new Headers();
    for (const rule of parseHeaders(read("_headers"))) {
      if (!rule.pattern.test(pathname)) continue;
      for (const [name, value] of rule.headers) {
        const prev = headers.get(name);
        headers.set(name, prev ? `${prev}, ${value}` : value);
      }
    }
    return headers;
  }

  function respond(file, pathname, status, method) {
    const headers = headersFor(pathname);
    headers.set("Content-Type", TYPES[extname(file).toLowerCase()] ?? "application/octet-stream");
    const body = method === "HEAD" ? null : readFileSync(file);
    return new Response(body, { status, headers });
  }

  return {
    async fetch(input, init) {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return new Response("Bad Request", { status: 400 });
      }
      if (pathname.includes("\0") || normalize(pathname).startsWith("..")) return new Response("Not Found", { status: 404 });

      for (const r of parseRedirects(read("_redirects"))) {
        if (r.from === pathname) return new Response(null, { status: r.status, headers: { Location: r.to } });
      }
      if (pathname.endsWith(".html") && pathname !== "/404.html") {
        const pretty = pathname === "/index.html" ? "/" : pathname.slice(0, -".html".length);
        if (isFile(pathname)) return new Response(null, { status: 308, headers: { Location: pretty + url.search } });
      }
      const method = request.method === "HEAD" ? "HEAD" : "GET";
      const candidates = pathname.endsWith("/") ? [`${pathname}index.html`] : [pathname, `${pathname}.html`, `${pathname}/index.html`];
      for (const rel of candidates) {
        const file = isFile(rel);
        if (file) return respond(file, pathname, 200, method);
      }
      const notFound = isFile("/404.html");
      return notFound ? respond(notFound, pathname, 404, method) : new Response("Not Found", { status: 404 });
    },
  };
}
