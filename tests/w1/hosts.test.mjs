// functions/_lib/hosts.ts: routing by host, robots.txt, the domains manifest and security headers.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHost,
  coursePath,
  finish,
  hostRouting,
  isPrivatePath,
  legalShortPath,
  resetHostState,
  robotsTxt,
  BASELINE_CSP,
} from "../../functions/_lib/hosts.ts";
import { onRequest } from "../../functions/_middleware.ts";
import { context, fakeAssets, req, postJson } from "../helpers/http.mjs";

const HUB = "courses.feelingsbeautycare.in";
const APEX = "feelingsbeautycare.in";

const PAGES = {
  "/c/selfmakeup": "<h1>course</h1>",
  "/c/diploma": "<h1>diploma</h1>",
  "/legal/terms": "<h1>terms</h1>",
  "/legal/refunds": "<h1>refunds</h1>",
  "/sitemaps/selfmakeup.xml": "<urlset/>",
  "/domains.json": JSON.stringify({ active: ["diploma", "BAD SLUG", "www"] }),
};

/** Runs hostRouting for a request; `next` answers 200 "next" (an HTML page) unless given. */
async function route(request, { env = {}, next } = {}) {
  const assets = env.ASSETS ?? fakeAssets(PAGES);
  const ctx = context({ request, env: { ...env, ASSETS: assets } });
  const nextFn = next ?? (async () => new Response("next", { headers: { "Content-Type": "text/html; charset=utf-8" } }));
  let nextCalls = 0;
  const res = await hostRouting(ctx, async () => {
    nextCalls++;
    return nextFn();
  });
  return { res, nextCalls, assets };
}

beforeEach(() => resetHostState());

test("classifyHost: hub, course, preview, dev and other hosts", () => {
  assert.deepEqual(classifyHost(HUB, HUB, APEX), { kind: "hub", host: HUB });
  assert.deepEqual(classifyHost("Courses.FeelingsBeautyCare.in.", HUB, APEX), { kind: "hub", host: HUB });
  assert.deepEqual(classifyHost("selfmakeup.feelingsbeautycare.in", HUB, APEX), {
    kind: "course",
    host: "selfmakeup.feelingsbeautycare.in",
    slug: "selfmakeup",
    dev: false,
  });
  // Reserved labels and invalid slugs are never course hosts.
  for (const host of ["www.feelingsbeautycare.in", "admin.feelingsbeautycare.in", "a.feelingsbeautycare.in", "x--y.feelingsbeautycare.in", "a.b.feelingsbeautycare.in"]) {
    assert.equal(classifyHost(host, HUB, APEX).kind, "other", host);
  }
  assert.equal(classifyHost("feelingsbeautycare.in", HUB, APEX).kind, "other");
  assert.equal(classifyHost("evil-feelingsbeautycare.in", HUB, APEX).kind, "other", "suffix must be a whole label");
  assert.equal(classifyHost("feelings-courses.pages.dev", HUB, APEX).kind, "preview");
  assert.equal(classifyHost("abc123.feelings-courses.pages.dev", HUB, APEX).kind, "preview");
  assert.equal(classifyHost("localhost", HUB, APEX).kind, "dev");
  assert.deepEqual(classifyHost("diploma.localhost", HUB, APEX), { kind: "course", host: "diploma.localhost", slug: "diploma", dev: true });
  assert.equal(classifyHost("www.localhost", HUB, APEX).kind, "dev");
});

test("path helpers", () => {
  assert.equal(legalShortPath("/terms"), "terms");
  assert.equal(legalShortPath("/privacy.html"), "privacy");
  assert.equal(legalShortPath("/refunds/"), "refunds");
  assert.equal(legalShortPath("/delivery"), "delivery");
  assert.equal(legalShortPath("/termsx"), null);
  assert.equal(legalShortPath("/legal/terms"), null);
  assert.deepEqual(coursePath("/c/diploma"), { slug: "diploma", rest: "" });
  assert.deepEqual(coursePath("/c/diploma/"), { slug: "diploma", rest: "/" });
  assert.deepEqual(coursePath("/c/diploma.html"), { slug: "diploma", rest: "" });
  assert.equal(coursePath("/c/www"), null, "reserved");
  assert.equal(coursePath("/c/"), null);
  assert.equal(coursePath("/catalog"), null);
  for (const p of ["/admin", "/admin/courses", "/admin.html", "/learn", "/learn/x", "/account", "/api/me", "/auth/continue", "/signin", "/ADMIN"]) {
    assert.ok(isPrivatePath(p), p);
  }
  for (const p of ["/", "/administrator", "/c/selfmakeup", "/legal/terms", "/learning-tips"]) assert.ok(!isPrivatePath(p), p);
});

test("robots.txt: indexable hosts list the sitemap; previews disallow everything", () => {
  const hub = robotsTxt({ kind: "hub", host: HUB }, `https://${HUB}`);
  assert.match(hub, /^User-agent: \*$/m);
  assert.match(hub, /^Disallow: \/admin$/m);
  assert.match(hub, /^Disallow: \/api\/$/m);
  assert.match(hub, /^Sitemap: https:\/\/courses\.feelingsbeautycare\.in\/sitemap\.xml$/m);
  assert.doesNotMatch(hub, /^Disallow: \/$/m);
  const course = robotsTxt({ kind: "course", host: "diploma.feelingsbeautycare.in", slug: "diploma", dev: false }, "https://diploma.feelingsbeautycare.in");
  assert.match(course, /^Sitemap: https:\/\/diploma\.feelingsbeautycare\.in\/sitemap\.xml$/m);
  for (const kind of ["preview", "dev"]) assert.match(robotsTxt({ kind, host: "x" }, "https://x"), /^Disallow: \/$/m);
});

test("hub: pages pass through with security headers", async () => {
  const { res, nextCalls } = await route(req("/"));
  assert.equal(nextCalls, 1);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "next");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(res.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(res.headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.equal(res.headers.get("X-Robots-Tag"), null, "public hub pages are indexable (pages decide with meta robots)");
  assert.equal(res.headers.get("Content-Security-Policy"), BASELINE_CSP, "HTML without a policy gets the baseline");
});

test("hub: private areas are never framed or indexed", async () => {
  const { res } = await route(req("/admin/courses"));
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(res.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
});

test("hub: a static SAMEORIGIN on a private page becomes DENY", async () => {
  const next = async () => new Response("<p>x</p>", { headers: { "Content-Type": "text/html", "X-Frame-Options": "SAMEORIGIN" } });
  const { res } = await route(req("/admin"), { next });
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
});

test("hub: an existing CSP and other headers are kept", async () => {
  const next = async () =>
    new Response("<p>x</p>", { headers: { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'self'", "X-Frame-Options": "DENY" } });
  const { res } = await route(req("/catalog"), { next });
  assert.equal(res.headers.get("Content-Security-Policy"), "default-src 'self'");
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
});

test("hub: /c/<slug> moves to the course host once its domain is active, keeping the query", async () => {
  const { res, nextCalls } = await route(req("/c/diploma?utm_source=instagram"));
  assert.equal(nextCalls, 0);
  assert.equal(res.status, 301);
  assert.equal(res.headers.get("Location"), "https://diploma.feelingsbeautycare.in/?utm_source=instagram");

  const inactive = await route(req("/c/selfmakeup"));
  assert.equal(inactive.nextCalls, 1, "no active domain: the hub serves the page");

  const post = await route(postJson("/c/diploma", {}));
  assert.equal(post.nextCalls, 1, "only GET/HEAD redirect");
});

test("hub: the domains manifest is read once per isolate and a broken one means none", async () => {
  const assets = fakeAssets(PAGES);
  await route(req("/c/diploma"), { env: { ASSETS: assets } });
  await route(req("/c/diploma"), { env: { ASSETS: assets } });
  assert.equal(assets.requests.filter((p) => p === "/domains.json").length, 1);

  resetHostState();
  const broken = fakeAssets({ "/domains.json": "{not json" });
  const { res } = await route(req("/c/diploma"), { env: { ASSETS: broken } });
  assert.equal(res.status, 200);
});

test("preview and dev hosts: noindex everywhere, no subdomain redirect, robots disallow all", async () => {
  const preview = await route(req("/c/diploma", { host: "abc.feelings-courses.pages.dev" }));
  assert.equal(preview.nextCalls, 1);
  assert.equal(preview.res.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const robots = await route(req("/robots.txt", { host: "feelings-courses.pages.dev" }));
  assert.equal(robots.res.status, 200);
  assert.match(await robots.res.text(), /^Disallow: \/$/m);
});

test("hub and course hosts: /terms and friends serve the hub's legal pages in place", async () => {
  for (const host of [HUB, "selfmakeup.feelingsbeautycare.in"]) {
    const { res, nextCalls } = await route(req("/terms", { host }));
    assert.equal(nextCalls, 0);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<h1>terms</h1>");
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  }
});

test("course host: / is the course's landing page, the URL stays /", async () => {
  const { res, nextCalls, assets } = await route(req("/?utm_source=ig", { host: "selfmakeup.feelingsbeautycare.in" }));
  assert.equal(nextCalls, 0);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "<h1>course</h1>");
  assert.ok(assets.requests.includes("/c/selfmakeup"));
  assert.equal(res.headers.get("X-Frame-Options"), "SAMEORIGIN");
  assert.equal(res.headers.get("Strict-Transport-Security"), "max-age=31536000");
});

test("course host: an unknown course goes to the hub's catalog", async () => {
  const { res } = await route(req("/", { host: "nosuchcourse.feelingsbeautycare.in" }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "https://courses.feelingsbeautycare.in/");
});

test("course host: /c/<own slug> → /, /c/<other> → hub, account pages → hub, APIs stay or 404", async () => {
  const host = "selfmakeup.feelingsbeautycare.in";
  let r = await route(req("/c/selfmakeup?x=1", { host }));
  assert.equal(r.res.status, 301);
  assert.equal(r.res.headers.get("Location"), "/?x=1");

  r = await route(req("/c/diploma", { host }));
  assert.equal(r.res.status, 302);
  assert.equal(r.res.headers.get("Location"), "https://courses.feelingsbeautycare.in/c/diploma");

  for (const path of ["/learn", "/learn/soft-glam", "/admin", "/account", "/signin", "/catalog", "/verify/ABCDEFGHJK"]) {
    r = await route(req(path, { host }));
    assert.equal(r.res.status, 302, path);
    assert.equal(r.res.headers.get("Location"), `https://courses.feelingsbeautycare.in${path}`, path);
    assert.equal(r.nextCalls, 0, path);
  }

  for (const path of ["/api/order", "/api/verify", "/api/coupon/quote", "/api/t", "/api/public/snapshot"]) {
    r = await route(postJson(path, {}, { host }));
    assert.equal(r.nextCalls, 1, path);
  }
  for (const path of ["/api/me", "/api/admin/courses", "/api/auth/email-link"]) {
    r = await route(postJson(path, {}, { host }));
    assert.equal(r.res.status, 404, path);
    assert.equal(r.nextCalls, 0, path);
  }
  r = await route(postJson("/learn", {}, { host }));
  assert.equal(r.res.status, 404, "no cross-origin redirect for a POST");
});

test("course host: assets, media and legal pages pass through", async () => {
  const host = "selfmakeup.feelingsbeautycare.in";
  for (const path of ["/_astro/a.css", "/favicon.svg", "/og.jpg", "/media/i/covers/a.webp", "/legal/privacy", "/thank-you"]) {
    const r = await route(req(path, { host }));
    assert.equal(r.nextCalls, 1, path);
  }
});

test("course host: sitemap and robots are the course's own", async () => {
  const host = "selfmakeup.feelingsbeautycare.in";
  const s = await route(req("/sitemap.xml", { host }));
  assert.equal(s.res.status, 200);
  assert.equal(await s.res.text(), "<urlset/>");
  const r = await route(req("/robots.txt", { host }));
  assert.match(await r.res.text(), /^Sitemap: https:\/\/selfmakeup\.feelingsbeautycare\.in\/sitemap\.xml$/m);
});

test("dev course host (<slug>.localhost) points back at localhost and is noindex", async () => {
  const request = new Request("http://selfmakeup.localhost:8788/learn");
  const { res } = await route(request);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "http://localhost:8788/learn");
  assert.equal(res.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("other hosts redirect to the hub", async () => {
  const { res } = await route(req("/x?y=1", { host: "www.feelingsbeautycare.in" }));
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "https://courses.feelingsbeautycare.in/x?y=1");
});

test("finish(): copies immutable responses and never gives a 304 a body", async () => {
  const immutable = Response.redirect("https://example.com/", 302);
  const out = finish(immutable);
  assert.equal(out.status, 302);
  assert.equal(out.headers.get("X-Content-Type-Options"), "nosniff");
  const notModified = finish(new Response(null, { status: 304 }));
  assert.equal(notModified.status, 304);
});

test("the root middleware routes course hosts before the learn gate", async () => {
  const ctx = context({ request: req("/learn", { host: "selfmakeup.feelingsbeautycare.in" }), env: { ASSETS: fakeAssets(PAGES) } });
  const res = await onRequest(ctx);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("Location"), "https://courses.feelingsbeautycare.in/learn");
  // On the hub the gate still answers, now with the security headers.
  const hub = await onRequest(context({ request: req("/learn"), env: {} }));
  assert.equal(hub.status, 302);
  assert.equal(hub.headers.get("Location"), "/?locked=1#pricing");
  assert.equal(hub.headers.get("X-Frame-Options"), "DENY");
});

test("hub: an unknown API path is a JSON 404, a page 404 stays HTML", async () => {
  const html404 = async () => new Response("<h1>Not found</h1>", { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
  let r = await route(req("/api/no-such-endpoint", { host: HUB }), { next: html404 });
  assert.equal(r.res.status, 404);
  assert.match(r.res.headers.get("Content-Type") ?? "", /application\/json/);
  assert.equal((await r.res.json()).error, "not_found");
  assert.equal(r.res.headers.get("Cache-Control"), "no-store");

  r = await route(req("/no-such-page", { host: HUB }), { next: html404 });
  assert.equal(r.res.status, 404);
  assert.match(r.res.headers.get("Content-Type") ?? "", /text\/html/);

  // A Function's own JSON 404 passes through untouched.
  const json404 = async () => new Response(JSON.stringify({ error: "not_found", message: "No such order." }), { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } });
  r = await route(req("/api/me/orders/9", { host: HUB }), { next: json404 });
  assert.equal((await r.res.json()).message, "No such order.");
});
