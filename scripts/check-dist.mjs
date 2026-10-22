// Checks the built site before it ships (W7). CI runs it after `npm run build:fast`.
//
//   node scripts/check-dist.mjs [dist] [--live]
//
// Always:
// - dist/_headers carries the Content-Security-Policy in its /* rule (scripts/csp.mjs ran), and
//   stays within Cloudflare Pages' 100-rule limit;
// - dist/_routes.json is valid, sends everything through Functions except hashed assets, and stays
//   within the 100-rule limit;
// - the pages the routers rely on exist: index, 404, sitemap.xml, build.json, domains.json, every
//   legal page, and a /sitemaps/<slug>.xml for every /c/<slug> page;
// - every public page has one absolute https canonical link, and its JSON-LD parses;
// - no public page shows a GSTIN or the word "GSTIN" (owner decision: never displayed);
// - build.json and domains.json have the shapes the admin and the router read.
// With --live (scripts/setup.mjs --live runs it before switching to live keys):
// - no Razorpay test key id (rzp_test_…) anywhere in dist;
// - no demo ribbon on any page, and no admin page loads the browser demo store.
//
// Exit code 1 with one line per problem.

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const live = args.includes("--live");
const dist = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(root, "dist"));
const LEGAL_PAGES = ["terms", "refunds", "privacy", "delivery"];
const GSTIN_RE = /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;

const problems = [];
const fail = (msg) => problems.push(msg);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const rel = (file) => path.relative(dist, file).split(path.sep).join("/");

/** Pages that are personal or operational: not checked for canonical/SEO. */
const isPrivatePage = (r) => /^(admin|learn|account|signin)(\/|\.html$)/.test(r) || /^(thank-you|payment-failed|404)\.html$/.test(r);

/** Header rules in a _headers file: lines that start a block. */
function headerRules(text) {
  return text.split(/\r?\n/).filter((l) => l.length > 0 && !/^\s/.test(l) && !l.startsWith("#"));
}

export async function checkDist() {
  if (!existsSync(dist)) {
    fail(`no build at ${dist}`);
    return;
  }

  // ---- _headers
  const headersFile = path.join(dist, "_headers");
  if (!existsSync(headersFile)) fail("dist/_headers is missing");
  else {
    const text = await readFile(headersFile, "utf8");
    const rules = headerRules(text);
    if (rules.length > 100) fail(`dist/_headers has ${rules.length} rules (Cloudflare Pages allows 100)`);
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => l.trim() === "/*" && !/^\s/.test(l));
    const block = [];
    for (let i = start + 1; start !== -1 && i < lines.length && /^\s/.test(lines[i]); i++) block.push(lines[i].trim());
    const csp = block.find((l) => l.toLowerCase().startsWith("content-security-policy:"));
    if (!csp) fail("dist/_headers: no Content-Security-Policy in the /* rule (did scripts/csp.mjs run?)");
    else {
      for (const directive of ["default-src 'self'", "object-src 'none'", "frame-ancestors", "base-uri 'self'"]) {
        if (!csp.includes(directive)) fail(`dist/_headers: the CSP lacks ${directive}`);
      }
      if (/script-src[^;]*'unsafe-inline'/.test(csp)) fail("dist/_headers: script-src must never allow 'unsafe-inline'");
    }
    for (const name of ["X-Content-Type-Options", "Strict-Transport-Security", "Referrer-Policy"]) {
      if (!block.some((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))) fail(`dist/_headers: /* lacks ${name}`);
    }
    if (block.some((l) => /^x-robots-tag:\s*noindex/i.test(l))) {
      fail("dist/_headers: a site-wide X-Robots-Tag noindex would hide every course host (pages decide per page)");
    }
  }

  // ---- _routes.json
  const routesFile = path.join(dist, "_routes.json");
  if (!existsSync(routesFile)) fail("dist/_routes.json is missing (every asset request would run Functions)");
  else {
    try {
      const routes = JSON.parse(await readFile(routesFile, "utf8"));
      if (routes.version !== 1) fail("dist/_routes.json: version must be 1");
      if (!Array.isArray(routes.include) || !routes.include.includes("/*")) fail('dist/_routes.json: include must contain "/*" (course hosts need Functions on every page)');
      if (!Array.isArray(routes.exclude) || !routes.exclude.includes("/_astro/*")) fail('dist/_routes.json: exclude should contain "/_astro/*"');
      const count = (routes.include?.length ?? 0) + (routes.exclude?.length ?? 0);
      if (count > 100) fail(`dist/_routes.json has ${count} rules (limit 100)`);
    } catch (err) {
      fail(`dist/_routes.json is not valid JSON: ${err.message}`);
    }
  }

  // ---- required files
  const required = ["index.html", "404.html", "sitemap.xml", "build.json", "domains.json", "legal.html", ...LEGAL_PAGES.map((p) => `legal/${p}.html`)];
  for (const f of required) if (!existsSync(path.join(dist, f))) fail(`dist/${f} is missing`);

  const files = await walk(dist);
  const coursePages = files.map(rel).filter((r) => /^c\/[^/]+\.html$/.test(r));
  for (const page of coursePages) {
    const slug = page.slice(2, -5);
    if (!existsSync(path.join(dist, "sitemaps", `${slug}.xml`))) fail(`dist/sitemaps/${slug}.xml is missing (course host sitemap for /c/${slug})`);
  }

  // ---- manifests
  try {
    const build = JSON.parse(await readFile(path.join(dist, "build.json"), "utf8"));
    if (!Number.isInteger(build.contentVersion) || !Number.isInteger(build.builtAt) || !["live", "seed", "url"].includes(build.snapshotSource)) {
      fail("dist/build.json doesn't match BuildInfo");
    }
  } catch {
    /* reported as missing above */
  }
  try {
    const domains = JSON.parse(await readFile(path.join(dist, "domains.json"), "utf8"));
    if (!Array.isArray(domains.active) || domains.active.some((s) => typeof s !== "string")) fail("dist/domains.json doesn't match DomainsManifest");
    for (const slug of domains.active ?? []) if (!coursePages.includes(`c/${slug}.html`)) fail(`dist/domains.json lists ${slug} but dist/c/${slug}.html doesn't exist`);
  } catch {
    /* reported as missing above */
  }

  // ---- pages
  for (const file of files) {
    const r = rel(file);
    const isHtml = r.endsWith(".html");
    const isText = isHtml || /\.(js|json|xml|txt|css)$/.test(r) || r === "_headers";
    if (!isText) continue;
    const text = await readFile(file, "utf8");

    if (live && text.includes("rzp_test_")) fail(`dist/${r}: contains a Razorpay test key id (rzp_test_…)`);
    if (!isHtml) continue;

    if (!r.startsWith("admin")) {
      const visible = text.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "");
      if (/GSTIN/i.test(visible) || GSTIN_RE.test(visible)) fail(`dist/${r}: shows a GSTIN (owner decision: never displayed)`);
    }
    if (live && text.includes("demo-ribbon")) fail(`dist/${r}: still shows the demo ribbon`);
    if (live && r.startsWith("admin") && /fbc-admin-demo/.test(text)) fail(`dist/${r}: loads the browser demo store`);

    if (isPrivatePage(r)) continue;
    const canonicals = [...text.matchAll(/<link\b[^>]*rel="canonical"[^>]*>/gi)].map((m) => /href="([^"]*)"/.exec(m[0])?.[1] ?? "");
    if (canonicals.length !== 1) fail(`dist/${r}: ${canonicals.length} canonical links (want 1)`);
    else if (!/^https:\/\//.test(canonicals[0])) fail(`dist/${r}: canonical "${canonicals[0]}" is not an absolute https URL`);

    for (const m of text.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(m[1]);
        if (/aggregateRating|"review"/i.test(m[1])) fail(`dist/${r}: JSON-LD has ratings or reviews (CLAUDE.md rule 1)`);
        void data;
      } catch {
        fail(`dist/${r}: JSON-LD doesn't parse`);
      }
    }
  }

  if (live && files.some((f) => rel(f).startsWith("_astro/") && /demo-store/.test(rel(f)))) {
    fail("dist/_astro: a demo-store chunk is still built");
  }
}

await checkDist();
if (problems.length) {
  console.error(`check-dist: ${problems.length} problem(s)${live ? " (live mode)" : ""}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-dist: ${path.relative(root, dist) || dist} is fine${live ? " for going live" : ""}.`);
