// Serves every signed-in learner page for the quality run, exactly as Functions answer them: the
// same handlers, the same Response (status, headers including the pages' CSP and Cache-Control,
// body), rendered once from the test world in tests/ux/world.mjs (scripts/preview-student-pages.mjs
// lists the states). /app/*, the fonts and /favicon.svg come from public/ with the Cache-Control
// that public/_headers gives them on Pages, and text is gzipped as Cloudflare does. /robots.txt is
// the dev host's (disallow all). Never used in production; CI only.
//
//   node --experimental-strip-types --no-warnings --import ./tests/helpers/register.mjs tests/quality/learner-server.mjs [port]
//
// Page URLs drop the .html: /account, /course-home, /lesson…
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { studentPages } from "../../scripts/preview-student-pages.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const port = Number(process.argv[2] ?? 8790);

const rendered = new Map();
for (const [file, [, render]] of Object.entries(await studentPages())) {
  const response = await render();
  rendered.set(`/${file.replace(/\.html$/, "")}`, {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    body: Buffer.from(await response.arrayBuffer()),
  });
}

const TYPES = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml" };

/** The Cache-Control public/_headers sets for a static path (kept in step with that file). */
async function staticCacheControl(pathname) {
  const rules = await readFile(path.join(root, "public/_headers"), "utf8");
  let current = null;
  let value = null;
  for (const line of rules.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = line.trim();
      continue;
    }
    const m = /^\s+Cache-Control:\s*(.+)$/i.exec(line);
    if (m && current) {
      const pattern = new RegExp(`^${current.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
      if (pattern.test(pathname)) value = m[1].trim();
    }
  }
  return value ?? "public, max-age=0, must-revalidate";
}

/** Sends a body, gzipped when the client accepts it and it is text (Cloudflare compresses these). */
function send(req, res, status, headers, body) {
  const type = String(headers["content-type"] ?? headers["Content-Type"] ?? "");
  const gzip = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) && /^(text\/|application\/(json|javascript))|svg/.test(type) && body.length > 0;
  const out = gzip ? gzipSync(body) : body;
  res.writeHead(status, { ...headers, ...(gzip ? { "Content-Encoding": "gzip", Vary: "Accept-Encoding" } : {}), "Content-Length": String(out.length) });
  res.end(req.method === "HEAD" ? undefined : out);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const page = rendered.get(url.pathname);
  if (page) {
    send(req, res, page.status, page.headers, page.body);
    return;
  }
  if (url.pathname === "/robots.txt") {
    send(req, res, 200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" }, Buffer.from("User-agent: *\nDisallow: /\n"));
    return;
  }
  const file = url.pathname === "/favicon.svg" ? "favicon.svg" : url.pathname.startsWith("/app/") ? url.pathname.slice(1) : null;
  if (file && !file.includes("..")) {
    try {
      const body = await readFile(path.join(root, "public", file));
      send(req, res, 200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": await staticCacheControl(url.pathname) }, body);
      return;
    } catch {
      /* 404 below */
    }
  }
  // Video and media requests from the lesson page: an empty answer, like R2 with no object.
  res.writeHead(url.pathname.startsWith("/media/") ? 204 : 404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end();
}).listen(port, "127.0.0.1", () => {
  console.log(`learner pages on http://127.0.0.1:${port}: ${[...rendered.keys()].join(" ")}`);
});
