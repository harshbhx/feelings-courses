// HTTP checks for the quality run, against the built site under `wrangler pages dev`:
//
//   security  every response (static pages, hashed assets, /app files, Function pages, APIs,
//             robots and sitemaps, the 404) carries nosniff, Referrer-Policy, Permissions-Policy,
//             HSTS and X-Frame-Options, and every HTML response a Content-Security-Policy;
//   caching   hashed assets are immutable for a year, unhashed files revalidate, HTML is never
//             cached for long, personal pages and APIs are no-store;
//   search    per host (hub, course host, dev): robots.txt, sitemap.xml, one absolute canonical
//             per public page that matches og:url, the course's JSON-LD, titles and descriptions,
//             and a real 404 status for unknown paths.
//
// The production host names are sent as the Host header, so the router classifies them as the hub
// and a course host exactly as on Cloudflare (functions/_lib/hosts.ts).
//
//   node tests/quality/headers.mjs [base]   (default http://127.0.0.1:8788)
import http from "node:http";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:8788");
const HUB_HOST = "courses.feelingsbeautycare.in";
const COURSE_HOST = "selfmakeup.feelingsbeautycare.in";
const DEV_COURSE_HOST = `selfmakeup.localhost:${base.port}`;

const problems = [];
let checks = 0;
const expect = (ok, message) => {
  checks++;
  if (!ok) problems.push(message);
};

/** GET through the local server with a chosen Host header; redirects are not followed. */
function get(path, host = base.host, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: base.hostname, port: base.port, path, method: "GET", headers: { Host: host, "Accept-Encoding": "identity", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const SECURITY = ["x-content-type-options", "referrer-policy", "permissions-policy", "strict-transport-security", "x-frame-options"];

function securityChecks(label, res) {
  for (const h of SECURITY) expect(!!res.headers[h], `${label}: no ${h}`);
  expect(res.headers["x-content-type-options"] === "nosniff", `${label}: X-Content-Type-Options is "${res.headers["x-content-type-options"]}"`);
  const type = String(res.headers["content-type"] ?? "");
  if (type.startsWith("text/html")) {
    const csp = String(res.headers["content-security-policy"] ?? "");
    expect(!!csp, `${label}: HTML without a Content-Security-Policy`);
    expect(/frame-ancestors/.test(csp), `${label}: CSP without frame-ancestors`);
    expect(/object-src 'none'|default-src 'none'/.test(csp), `${label}: CSP doesn't block plugins (object-src)`);
    expect(!/script-src[^;]*'unsafe-inline'/.test(csp), `${label}: CSP allows inline scripts`);
  }
}

const cacheOf = (res) => String(res.headers["cache-control"] ?? "");
const maxAge = (cc) => Number(/max-age=(\d+)/.exec(cc)?.[1] ?? -1);

function cacheCheck(label, res, kind) {
  const cc = cacheOf(res);
  switch (kind) {
    case "immutable":
      expect(/immutable/.test(cc) && maxAge(cc) >= 31536000, `${label}: Cache-Control "${cc}" (want a year, immutable)`);
      break;
    case "revalidate": // unhashed static files: short and revalidated, never immutable
      expect(!/immutable/.test(cc) && maxAge(cc) >= 0 && maxAge(cc) <= 86400 && /must-revalidate|stale-while-revalidate|no-cache/.test(cc), `${label}: Cache-Control "${cc}" (want a short max-age with revalidation)`);
      break;
    case "long": // files that never change in place (fonts, icons)
      expect(maxAge(cc) >= 86400 && !/no-store|private/.test(cc), `${label}: Cache-Control "${cc}" (want at least a day)`);
      break;
    case "html": // static HTML: always revalidated, so a deploy shows at once
      expect(/no-cache|max-age=0|must-revalidate/.test(cc) && maxAge(cc) <= 300 && !/immutable/.test(cc), `${label}: Cache-Control "${cc}" (want HTML revalidated on every visit)`);
      break;
    case "private":
      expect(/no-store/.test(cc), `${label}: Cache-Control "${cc}" (want no-store: personal)`);
      break;
    case "hour":
      expect(maxAge(cc) > 0 && maxAge(cc) <= 86400 && !/no-store/.test(cc), `${label}: Cache-Control "${cc}" (want a short public cache)`);
      break;
    default:
      throw new Error(kind);
  }
}

// ---------------------------------------------------------------- wait for the server

for (let i = 0; ; i++) {
  try {
    await get("/");
    break;
  } catch (err) {
    if (i > 60) throw new Error(`headers: ${base.href} is not up (${err?.message ?? err})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---------------------------------------------------------------- security and caching, every kind of response

const home = await get("/");
const asset = /\/_astro\/[^"']+\.(?:css|js)/.exec(home.body)?.[0];
expect(!!asset, "GET /: no /_astro/ asset referenced");

const responses = [
  ["/", base.host, "html"],
  ["/c/selfmakeup", base.host, "html"],
  ["/catalog", base.host, "html"],
  ["/legal/terms", base.host, "html"],
  ["/thank-you", base.host, "html"],
  ["/admin", base.host, "html"],
  ["/admin/dashboard", base.host, "html"],
  ["/", DEV_COURSE_HOST, "html"],
  ["/signin", base.host, "private"],
  ["/verify", base.host, "private"],
  ["/api/public/snapshot", base.host, null],
  ["/robots.txt", base.host, "hour"],
  ["/sitemap.xml", base.host, "hour"],
  ["/build.json", base.host, null],
  ...(asset ? [[asset, base.host, "immutable"]] : []),
  ["/app/app.css", base.host, "revalidate"],
  ["/app/learn.js", base.host, "revalidate"],
  ["/app/fonts/plus-jakarta-sans-latin-wght-normal.woff2", base.host, "long"],
  ["/favicon.svg", base.host, "long"],
  ["/favicon.ico", base.host, "long"],
  ["/apple-touch-icon.png", base.host, "long"],
  ["/og.jpg", base.host, "long"],
];
for (const [path, host, cache] of responses) {
  const res = await get(path, host);
  const label = `GET ${host === base.host ? "" : `//${host}`}${path}`;
  expect(res.status === 200, `${label}: ${res.status} (want 200)`);
  securityChecks(label, res);
  if (cache) cacheCheck(label, res, cache);
}

// Private areas: never framed, never indexed.
for (const path of ["/admin", "/signin", "/account", "/learn"]) {
  const res = await get(path);
  expect(String(res.headers["x-frame-options"]).toUpperCase() === "DENY", `GET ${path}: X-Frame-Options "${res.headers["x-frame-options"]}" (want DENY)`);
  expect(/noindex/.test(String(res.headers["x-robots-tag"] ?? "")), `GET ${path}: no X-Robots-Tag noindex`);
}

// Unknown paths: a real 404 page with the headers, not cached for long.
{
  const res = await get("/no-such-page");
  expect(res.status === 404, `GET /no-such-page: ${res.status} (want 404)`);
  expect(/<h1[^>]*>/.test(res.body), "GET /no-such-page: no 404 page body");
  securityChecks("GET /no-such-page", res);
  expect(!/immutable/.test(cacheOf(res)) && maxAge(cacheOf(res)) <= 300, `GET /no-such-page: Cache-Control "${cacheOf(res)}"`);
  const api = await get("/api/no-such-endpoint");
  expect(api.status === 404 && /json/.test(String(api.headers["content-type"])), `GET /api/no-such-endpoint: ${api.status} ${api.headers["content-type"]} (want a JSON 404)`);
}

// ---------------------------------------------------------------- search, per host

function headTags(html) {
  const head = /<head[\s\S]*?<\/head>/i.exec(html)?.[0] ?? "";
  const all = (re) => [...head.matchAll(re)].map((m) => m[1]);
  return {
    canonical: all(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/gi),
    ogUrl: all(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/gi)[0],
    title: /<title>([^<]*)<\/title>/i.exec(head)?.[1] ?? "",
    description: all(/<meta[^>]+name="description"[^>]+content="([^"]*)"/gi)[0] ?? "",
    robots: all(/<meta[^>]+name="robots"[^>]+content="([^"]*)"/gi)[0] ?? "",
    jsonLd: [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]),
  };
}

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');

// The hub, as production (Host: courses.feelingsbeautycare.in).
{
  const robots = await get("/robots.txt", HUB_HOST);
  expect(robots.status === 200, `hub robots.txt: ${robots.status}`);
  expect(/Disallow: \/admin/.test(robots.body) && /Disallow: \/api\//.test(robots.body), "hub robots.txt: doesn't keep /admin and /api/ out");
  // The scheme is the request's: https on Cloudflare, http on the local server.
  expect(new RegExp(`^Sitemap: https?://${HUB_HOST.replace(/\./g, "\\.")}/sitemap\\.xml$`, "m").test(robots.body), "hub robots.txt: no Sitemap line for the hub");
  const sitemap = await get("/sitemap.xml", HUB_HOST);
  expect(sitemap.status === 200 && /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(sitemap.body), "hub sitemap.xml: not a sitemap");
  expect(/xml/.test(String(sitemap.headers["content-type"])), `hub sitemap.xml: content-type ${sitemap.headers["content-type"]}`);
  for (const loc of [...sitemap.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])) {
    expect(loc.startsWith("https://"), `hub sitemap.xml: ${loc} isn't absolute https`);
  }

  for (const path of ["/", "/c/selfmakeup", "/catalog", "/legal", "/legal/terms", "/legal/refunds", "/legal/privacy", "/legal/delivery"]) {
    const res = await get(path, HUB_HOST);
    const label = `hub ${path}`;
    if (res.status === 301 || res.status === 302) continue; // a course on its own host: checked below
    expect(res.status === 200, `${label}: ${res.status}`);
    const t = headTags(res.body);
    expect(t.canonical.length === 1, `${label}: ${t.canonical.length} canonical links (want 1)`);
    const canonical = t.canonical[0] ?? "";
    expect(canonical.startsWith("https://"), `${label}: canonical "${canonical}" isn't absolute https`);
    expect(!t.ogUrl || decode(t.ogUrl) === decode(canonical), `${label}: og:url ${t.ogUrl} differs from the canonical ${canonical}`);
    expect(t.title.length >= 10 && t.title.length <= 70, `${label}: title is ${t.title.length} characters ("${t.title}")`);
    expect(t.description.length >= 50 && t.description.length <= 160, `${label}: description is ${t.description.length} characters`);
    for (const block of t.jsonLd) {
      try {
        JSON.parse(block);
      } catch {
        expect(false, `${label}: JSON-LD doesn't parse`);
      }
    }
  }

  // The course landing: one Course in JSON-LD, with the facts search engines need.
  const course = await get("/c/selfmakeup", HUB_HOST);
  if (course.status === 200) {
    const blocks = headTags(course.body).jsonLd.concat([...course.body.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]));
    const data = blocks.map((b) => {
      try {
        return JSON.parse(b);
      } catch {
        return null;
      }
    });
    const c = data.find((d) => d && d["@type"] === "Course");
    expect(!!c, "hub /c/selfmakeup: no schema.org Course");
    if (c) {
      expect(!!c.name && !!c.description && !!c.provider?.name, "Course JSON-LD: name, description or provider missing");
      expect(c.offers?.priceCurrency === "INR" && !!c.offers?.price, "Course JSON-LD: no INR offer");
      expect(typeof c.url === "string" && c.url.startsWith("https://"), "Course JSON-LD: url isn't absolute");
      expect(!("aggregateRating" in c) && !("review" in c), "Course JSON-LD: ratings or reviews (CLAUDE.md rule 1)");
    }
  }
}

// A course host, as production (Host: selfmakeup.feelingsbeautycare.in).
{
  const robots = await get("/robots.txt", COURSE_HOST);
  expect(robots.status === 200 && new RegExp(`^Sitemap: https?://${COURSE_HOST.replace(/\./g, "\\.")}/sitemap\\.xml$`, "m").test(robots.body), "course host robots.txt: no Sitemap line for its own host");
  const sitemap = await get("/sitemap.xml", COURSE_HOST);
  expect(sitemap.status === 200 && /<urlset/.test(sitemap.body), `course host sitemap.xml: ${sitemap.status}`);
  const page = await get("/", COURSE_HOST);
  if (page.status === 200) {
    const t = headTags(page.body);
    expect(t.canonical.length === 1 && t.canonical[0].startsWith("https://"), "course host /: no single absolute canonical");
    securityChecks("course host /", page);
  } else {
    // No active domain in the seed: the host sends visitors to the hub, which is right.
    expect([301, 302].includes(page.status), `course host /: ${page.status}`);
  }
  // Pages that live on the hub are sent there, never served on the course host.
  const admin = await get("/admin", COURSE_HOST);
  expect(admin.status === 302 && String(admin.headers.location ?? "").startsWith(`https://${HUB_HOST}/admin`), `course host /admin: ${admin.status} ${admin.headers.location}`);
}

// Dev and preview hosts: nothing indexable.
{
  const robots = await get("/robots.txt");
  expect(/Disallow: \/\s*$/m.test(robots.body), "dev robots.txt: doesn't disallow everything");
  const res = await get("/");
  expect(/noindex/.test(String(res.headers["x-robots-tag"] ?? "")), "dev /: no X-Robots-Tag noindex");
  const preview = await get("/", "feat-x.feelings-courses.pages.dev");
  expect(/noindex/.test(String(preview.headers["x-robots-tag"] ?? "")), "*.pages.dev /: no X-Robots-Tag noindex");
}

console.log(`### HTTP: security headers, caching and search\n`);
if (problems.length) {
  console.log(`${problems.length} of ${checks} checks failed:\n`);
  for (const p of problems) console.log(`- ${p}`);
  process.exitCode = 1;
} else {
  console.log(`${checks} checks passed.`);
}
