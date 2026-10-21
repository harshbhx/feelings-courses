// Content-Security-Policy, written at build time. The last step of `npm run build`:
//
//   node scripts/csp.mjs [dist-folder]
//
// 1. Scans every dist/**/*.html for inline executable <script> elements (no src): classic and
//    module scripts, import maps and speculation rules. Data blocks (application/ld+json,
//    application/json, any other non-script type) are skipped: browsers never run them, so CSP
//    doesn't apply to them.
// 2. Hashes each one (SHA-256 of its text, exactly as the browser sees it).
// 3. Writes one site-wide Content-Security-Policy header into the /* rule of dist/_headers
//    (copied from public/_headers by Astro), keeping every other header and rule.
//
// Any inline script added later is hashed on the next build, so nothing is kept by hand. The
// policy allows exactly what the site loads (see policy() below); 'unsafe-inline' is never given
// to scripts. Styles keep 'unsafe-inline': the pages rely on inline style="" attributes and
// inlined CSS, and styles can't run script.
//
// Text that JS inserts at runtime as an inline script or speculation rules is not in the HTML,
// so it can't be found here. Put its exact text in the page as
//   <script type="text/plain" data-csp-hash>…</script>
// and insert that text verbatim (element.textContent); it is hashed like an inline script. Keep it
// the same on every page: the policy is site-wide. ('inline-speculation-rules' is no way out:
// browsers ignore it once a policy has hashes, just as they ignore 'unsafe-inline'.)
//
// Fails the build (exit 1) on an inline event handler (onclick="…") or a javascript: URL, which
// the policy would block, and when the header grows past Cloudflare Pages' 2,000-character limit
// for one header line.

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.resolve(process.argv[2] ?? path.join(root, "dist"));
const headersFile = path.join(dist, "_headers");
const HEADER = "Content-Security-Policy";
const MAX_HEADER_LENGTH = 2000; // Cloudflare Pages: one header in _headers can be at most 2,000 characters

if (!existsSync(dist)) {
  console.error(`csp: no build at ${dist}. Run astro build first.`);
  process.exit(1);
}

// Razorpay Checkout (standard web integration), loaded only after a buyer taps Enroll. Razorpay
// doesn't publish a CSP list, so this is what checkout.js itself loads on our page (checked against
// the live script and in a headless browser, 2026-10-20):
// - script: checkout.js, and the risk-detection bundle it injects from cdn.razorpay.com;
// - frame: the payment form itself, api.razorpay.com/v1/checkout/public;
// - connect: its event and error beacons (lumberjack.razorpay.com seen; -cx and -metrics are in the
//   script too).
// Nothing more: card fields, UPI and bank pages run inside Razorpay's own frame and windows, and in
// Instagram's and Facebook's in-app browsers (redirect flow) Razorpay posts only to our own
// /api/verify, which form-action 'self' already allows.
const RAZORPAY = {
  script: ["https://checkout.razorpay.com", "https://cdn.razorpay.com"],
  frame: ["https://api.razorpay.com"],
  connect: ["https://lumberjack.razorpay.com", "https://lumberjack-cx.razorpay.com", "https://lumberjack-metrics.razorpay.com"],
};

// Everything the site loads, and from where. Keep this list to what the pages really use.
const policy = (scriptHashes) => ({
  "default-src": ["'self'"],
  // Our bundles, the hashed inline scripts, and Cloudflare Web Analytics' beacon if the owner
  // switches it on.
  "script-src": ["'self'", ...scriptHashes, "https://static.cloudflareinsights.com", ...RAZORPAY.script],
  "style-src": ["'self'", "'unsafe-inline'"],
  // YouTube thumbnails (stories, Shorts rail) and Google reviewers' photos (live reviews).
  "img-src": ["'self'", "data:", "https://i.ytimg.com", "https://*.googleusercontent.com"],
  // Vite inlines the smallest Fontsource subset (cyrillic-ext) into the CSS as a data: URL.
  "font-src": ["'self'", "data:"],
  // /api/* is same-origin; Web Analytics reports to cloudflareinsights.com.
  "connect-src": ["'self'", "https://cloudflareinsights.com", ...RAZORPAY.connect],
  // The embeds run in their own frames: YouTube (privacy mode), Instagram's profile embed, Google Maps,
  // and Razorpay's payment form.
  "frame-src": ["https://www.youtube-nocookie.com", "https://www.instagram.com", "https://www.google.com", ...RAZORPAY.frame],
  "media-src": ["'self'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'self'"],
  "upgrade-insecure-requests": [],
});

// ---------- scan ----------

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

function attributes(source) {
  const attrs = new Map();
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of source.matchAll(re)) attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? "");
  return attrs;
}

// The HTML spec's JavaScript MIME type essences: a script with one of these types (or none) runs.
const JS_TYPES = new Set(
  [
    "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
    "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
    "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
    "text/x-ecmascript", "text/x-javascript",
  ],
);
// Inline elements that script-src governs: classic and module scripts, import maps, speculation rules.
function isExecutable(attrs) {
  if (!attrs.has("type")) return true;
  const type = attrs.get("type").trim().toLowerCase();
  if (type === "") return true;
  if (type === "module" || type === "importmap" || type === "speculationrules") return true;
  return JS_TYPES.has(type.split(";")[0].trim());
}

// The parser turns CRLF and lone CR into LF before a script's text exists; hash what it hashes.
const sha256 = (text) =>
  `'sha256-${createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("base64")}'`;

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
const HANDLER = /<[a-z][^>]*?\son[a-z]+\s*=/gi;
const JS_URL = /\s(?:href|src|action|formaction)\s*=\s*["']?\s*javascript:/gi;

const pages = await walk(dist);
const hashes = new Map(); // hash -> { pages, kind, preview }
const failures = [];
let inlineCount = 0;

for (const file of pages) {
  const rel = path.relative(dist, file).split(path.sep).join("/");
  const html = await readFile(file, "utf8");

  for (const m of html.matchAll(SCRIPT)) {
    const attrs = attributes(m[1]);
    if (attrs.has("src") || !(isExecutable(attrs) || attrs.has("data-csp-hash"))) continue;
    const text = m[2];
    if (text.trim() === "") continue;
    inlineCount++;
    const hash = sha256(text);
    const entry = hashes.get(hash) ?? { pages: 0, kind: attrs.get("type") || "classic", preview: text.trim().slice(0, 60) };
    entry.pages++;
    hashes.set(hash, entry);
  }

  // Inline handlers and javascript: URLs would be blocked; look for them outside script and style text.
  const markup = html.replace(SCRIPT, "<script></script>").replace(STYLE, "<style></style>");
  for (const m of markup.matchAll(HANDLER)) failures.push(`${rel}: inline event handler in ${m[0].slice(0, 80)}…`);
  for (const m of markup.matchAll(JS_URL)) failures.push(`${rel}: javascript: URL near ${m[0].trim()}`);
}

if (failures.length) {
  console.error(`csp: ${failures.length} problem(s) the policy would block. Move the code into a <script>:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

// ---------- header ----------

const sortedHashes = [...hashes.keys()].sort();
const value = Object.entries(policy(sortedHashes))
  .map(([name, sources]) => [name, ...sources].join(" "))
  .join("; ");
const line = `  ${HEADER}: ${value}`;

if (`${HEADER}: ${value}`.length > MAX_HEADER_LENGTH) {
  console.error(
    `csp: the header is ${`${HEADER}: ${value}`.length} characters, over Cloudflare Pages' ${MAX_HEADER_LENGTH}. ` +
      `${sortedHashes.length} distinct inline scripts: merge some, or move them into bundled scripts.`,
  );
  process.exit(1);
}

// Put the policy into the /* rule, replacing an older one, and leave everything else as it is.
const original = existsSync(headersFile) ? await readFile(headersFile, "utf8") : "";
const lines = original.split(/\r?\n/);
const isRule = (l) => l.length > 0 && !/^\s/.test(l) && !l.startsWith("#");
const start = lines.findIndex((l) => l.trim() === "/*" && isRule(l));
let out;
if (start === -1) {
  out = ["/*", line, "", ...lines];
} else {
  let end = start + 1;
  while (end < lines.length && !isRule(lines[end]) && lines[end].trim() !== "") end++;
  const block = lines.slice(start + 1, end).filter((l) => !l.trim().toLowerCase().startsWith(`${HEADER.toLowerCase()}:`));
  out = [...lines.slice(0, start + 1), ...block, line, ...lines.slice(end)];
}
await writeFile(headersFile, out.join("\n"));

console.log(
  `csp: ${pages.length} pages, ${inlineCount} inline scripts, ${sortedHashes.length} distinct hashes; ` +
    `${HEADER} (${value.length} chars) written to ${path.relative(root, headersFile).split(path.sep).join("/")}`,
);
for (const h of sortedHashes) {
  const e = hashes.get(h);
  console.log(`  ${h}  ${String(e.pages).padStart(3)} page(s)  ${e.kind}  ${JSON.stringify(e.preview)}`);
}
