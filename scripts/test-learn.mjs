// Tests for the course area's gate (functions/learn/*), run with plain Node 22 and no packages:
//
//   node scripts/test-learn.mjs
//
// The Pages Functions are TypeScript. A small loader hook (below) compiles them as they are
// imported: with the project's own TypeScript when it is installed, otherwise with Node's built-in
// type stripping. Requests, responses and Web Crypto are Node's own, the same APIs as Workers.
//
// What is tested:
//   - every course URL (/learn, /learn/, each lesson, the .html files) redirects to the price card
//     with no cookie, a broken one, an expired one or a forged one, and the redirect is no-store;
//   - an enrolled request gets the page, marked Cache-Control: private, no-store;
//   - /learn/logout clears the cookie without needing an enrollment.
//
// Tests that need real cookies use issueEnrollment() and verifyEnrollment() from
// functions/_lib/enrollment.ts, which the checkout work implements. While those are still the stub
// they are skipped with a message saying so, and they run by themselves once the implementation is
// merged. Every other test runs now.

import { register, createRequire } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const fileUrl = (rel) => pathToFileURL(path.join(root, rel)).href;

// ---------- load TypeScript ----------

const hooks = String.raw`
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as nodeModule from "node:module";

let ts = null;
export async function initialize(data) {
  if (data && data.typescript) {
    try { ts = (await import(data.typescript)).default; } catch { ts = null; }
  }
}

// Workers bundles import "../_lib/enrollment" without an extension; Node needs the file name.
export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL || "";
  if (/^\.\.?\//.test(specifier) && parent.endsWith(".ts") && !/\.[cm]?[jt]s$/.test(specifier)) {
    for (const candidate of [specifier + ".ts", specifier + "/index.ts"]) {
      const url = new URL(candidate, parent);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
  const file = fileURLToPath(url);
  const source = await readFile(file, "utf8");
  const code = ts
    ? ts.transpileModule(source, {
        fileName: file,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
      }).outputText
    : nodeModule.stripTypeScriptTypes(source);
  return { format: "module", source: code, shortCircuit: true };
}
`;

let typescript = null;
try {
  typescript = pathToFileURL(createRequire(import.meta.url).resolve("typescript")).href;
} catch {
  // Not installed: Node's own type stripping is used instead.
}
register(`data:text/javascript,${encodeURIComponent(hooks)}`, { data: { typescript } });

const gateMod = await import(fileUrl("functions/learn/_gate.ts"));
const enrollment = await import(fileUrl("functions/_lib/enrollment.ts"));
const middlewareRoute = await import(fileUrl("functions/learn/_middleware.ts"));
const bareRoute = await import(fileUrl("functions/learn.ts"));
const htmlRoute = await import(fileUrl("functions/learn.html.ts"));
const logoutRoute = await import(fileUrl("functions/learn/logout.ts"));
const { course } = await import(fileUrl("src/data/course.ts"));
const { lessons } = await import(fileUrl("src/data/lessons.ts"));

const { LOCKED_LOCATION, GATED_CACHE_CONTROL, gate, learnMiddleware } = gateMod;
const { ENROLL_COOKIE, issueEnrollment, verifyEnrollment } = enrollment;

// ---------- helpers ----------

const ORIGIN = "https://feat-learn.feelings-courses.pages.dev";
const SECRET = "test-only-enroll-secret";
const PAGE_BODY = "<!doctype html><title>course page</title>";
const HOUR = 3600;
const now = () => Math.floor(Date.now() / 1000);

/** A fake Pages EventContext. next() stands in for the static page and counts its calls. */
function context(pathname, { cookie, env = { ENROLL_SECRET: SECRET }, method = "GET", data = {} } = {}) {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("Cookie", cookie);
  const ctx = {
    request: new Request(new URL(pathname, ORIGIN), { method, headers }),
    env,
    data,
    params: {},
    functionPath: pathname,
    waitUntil() {},
    passThroughOnException() {
      throw new Error("the gate must never fail open");
    },
    nextCalls: 0,
    async next() {
      ctx.nextCalls++;
      return new Response(PAGE_BODY, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=600" },
      });
    },
  };
  return ctx;
}

function assertLocked(response, ctx, what) {
  assert.equal(response.status, 302, `${what}: expected a 302`);
  assert.equal(response.headers.get("Location"), LOCKED_LOCATION, `${what}: wrong Location`);
  assert.equal(response.headers.get("Cache-Control"), GATED_CACHE_CONTROL, `${what}: redirect must be no-store`);
  assert.equal(ctx.nextCalls, 0, `${what}: the page must not be served`);
}

async function assertServed(response, ctx, what) {
  assert.equal(response.status, 200, `${what}: expected the page (200), got ${response.status} ${response.headers.get("Location") ?? ""}`);
  assert.equal(ctx.nextCalls, 1, `${what}: next() should run once`);
  assert.equal(response.headers.get("Cache-Control"), GATED_CACHE_CONTROL, `${what}: page must be private, no-store`);
  assert.equal(await response.text(), PAGE_BODY, `${what}: page body must pass through unchanged`);
}

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** A cookie value built from the documented format, `<slug>.<expires>.<ref>.<hmacHex>`. */
async function contractCookie(secret, { courseSlug = course.slug, expires, paymentRef = "pay_test123" }) {
  const payload = `${courseSlug}.${expires}.${paymentRef}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${payload}.${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)))}`;
}

/** The cookie value out of a Set-Cookie header from issueEnrollment(). */
async function issue(env, fields = {}) {
  const setCookie = await issueEnrollment(env, {
    courseSlug: course.slug,
    expires: now() + 30 * 24 * HOUR,
    paymentRef: "pay_test123",
    ...fields,
  });
  const pair = setCookie.split(";")[0].trim();
  assert.ok(pair.startsWith(`${ENROLL_COOKIE}=`), `issueEnrollment() should set ${ENROLL_COOKIE}, got "${pair}"`);
  return pair.slice(ENROLL_COOKIE.length + 1);
}

/** Runs fn with the clock moved forward (Date and Date.now), to age a cookie past its expiry. */
async function withClockAhead(seconds, fn) {
  const RealDate = Date;
  const offset = seconds * 1000;
  class FutureDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = FutureDate;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// The real cookie functions are written by the checkout work. Until then issueEnrollment() throws
// "not implemented" and verifyEnrollment() returns null, and the tests that need them are skipped.
let implemented = false;
try {
  await issueEnrollment({ ENROLL_SECRET: SECRET }, { courseSlug: course.slug, expires: now() + HOUR, paymentRef: "probe" });
  implemented = true;
} catch (error) {
  if (!/not implemented/i.test(String(error?.message))) implemented = true; // a real error: let the tests show it
}
const NEEDS_REAL =
  "skipped: needs the real issueEnrollment()/verifyEnrollment() from functions/_lib/enrollment.ts " +
  "(checkout part; still the stub on this branch). Runs automatically once it is merged.";
const real = implemented ? {} : { skip: NEEDS_REAL };

/** Every URL the gate must cover. */
const lessonUrls = lessons.flatMap((l) => [l.href, `${l.href}.html`, `${l.href}/`]);
const middlewareUrls = ["/learn", "/learn/", ...lessonUrls, "/learn/does-not-exist", "/learn/logout.html"];

/** Runs a request through the route that Pages would pick for it, with the real verifyEnrollment(). */
async function viaRoute(pathname, options = {}) {
  const ctx = context(pathname, options);
  let response;
  if (pathname === "/learn.html") {
    response = await htmlRoute.onRequest(ctx);
  } else if (pathname === "/learn") {
    // Pages runs the middleware first, then the bare route's handler.
    response = await middlewareRoute.onRequest({ ...ctx, next: () => bareRoute.onRequestGet(ctx) });
  } else {
    response = await middlewareRoute.onRequest(ctx);
  }
  return { response, ctx };
}

// ---------- the gate's own logic (runs now) ----------

test("route files export the gate for every path they cover", () => {
  assert.equal(typeof middlewareRoute.onRequest, "function", "functions/learn/_middleware.ts onRequest");
  assert.equal(typeof htmlRoute.onRequest, "function", "functions/learn.html.ts onRequest");
  assert.equal(typeof logoutRoute.onRequest, "function", "functions/learn/logout.ts onRequest");
  for (const method of ["Get", "Head", "Post", "Put", "Patch", "Delete", "Options"]) {
    assert.equal(typeof bareRoute[`onRequest${method}`], "function", `functions/learn.ts onRequest${method}`);
  }
  // A plain onRequest in learn.ts would be merged with the middleware and drop /learn from _routes.json.
  assert.equal(bareRoute.onRequest, undefined, "functions/learn.ts must not export a plain onRequest");
});

test("no cookie: every course URL redirects to the price card", async () => {
  for (const url of [...middlewareUrls, "/learn.html"]) {
    const { response, ctx } = await viaRoute(url);
    assertLocked(response, ctx, url);
  }
  for (const method of ["Get", "Head", "Post", "Put", "Patch", "Delete", "Options"]) {
    const ctx = context("/learn", { method: method.toUpperCase() });
    assertLocked(await bareRoute[`onRequest${method}`](ctx), ctx, `${method.toUpperCase()} /learn (functions/learn.ts)`);
  }
});

test("no ENROLL_SECRET (demo) and no cookie: still redirects", async () => {
  const { response, ctx } = await viaRoute("/learn", { env: {} });
  assertLocked(response, ctx, "/learn without a secret");
});

test("broken cookies redirect", async () => {
  const broken = [
    `${ENROLL_COOKIE}=`,
    `${ENROLL_COOKIE}=garbage`,
    `${ENROLL_COOKIE}=a.b.c`,
    `${ENROLL_COOKIE}=${course.slug}.notanumber.pay_x.${"0".repeat(64)}`,
    `${ENROLL_COOKIE}=${"x".repeat(5000)}`,
    `other=1`,
  ];
  for (const cookie of broken) {
    for (const url of ["/learn", lessons[0].href]) {
      const { response, ctx } = await viaRoute(url, { cookie });
      assertLocked(response, ctx, `${url} with cookie "${cookie.slice(0, 40)}"`);
    }
  }
});

test("forged cookie (signed with the wrong key) redirects", async () => {
  const value = await contractCookie("not-the-secret", { expires: now() + 30 * 24 * HOUR });
  for (const url of ["/learn", "/learn.html", lessons[0].href, `${lessons[0].href}.html`]) {
    const { response, ctx } = await viaRoute(url, { cookie: `${ENROLL_COOKIE}=${value}` });
    assertLocked(response, ctx, `${url} with a forged cookie`);
  }
});

test("expired cookie (documented format, right key, past expiry) redirects", async () => {
  const value = await contractCookie(SECRET, { expires: now() - HOUR });
  for (const url of ["/learn", lessons[0].href]) {
    const { response, ctx } = await viaRoute(url, { cookie: `${ENROLL_COOKIE}=${value}` });
    assertLocked(response, ctx, `${url} with an expired cookie`);
  }
});

test("enrolled (verifier says yes): serves the page as private, no-store", async () => {
  const verify = async () => ({ courseSlug: course.slug, expires: now() + HOUR, paymentRef: "pay_fake" });
  for (const url of ["/learn", lessons[0].href, `${lessons[0].href}.html`]) {
    const ctx = context(url);
    await assertServed(await learnMiddleware(ctx, verify), ctx, url);
    assert.equal(ctx.data.enrollment?.paymentRef, "pay_fake", "the enrollment is shared with later functions");
  }
});

test("a verifier that returns an already expired enrollment is not trusted", async () => {
  const verify = async () => ({ courseSlug: course.slug, expires: now() - 1, paymentRef: "pay_fake" });
  const ctx = context("/learn");
  assertLocked(await gate(ctx, verify), ctx, "expired enrollment from the verifier");
});

test("a verifier that throws fails closed", async () => {
  const verify = async () => {
    throw new Error("boom");
  };
  const ctx = context(lessons[0].href);
  const quiet = console.error;
  console.error = () => {};
  try {
    assertLocked(await learnMiddleware(ctx, verify), ctx, "throwing verifier");
  } finally {
    console.error = quiet;
  }
});

test("/learn is checked once: the bare route trusts the middleware's result", async () => {
  // The middleware stored the enrollment; the stub verifier would say no, so a second check would redirect.
  const ctx = context("/learn", { data: { enrollment: { courseSlug: course.slug, expires: now() + HOUR, paymentRef: "pay_fake" } } });
  await assertServed(await bareRoute.onRequestGet(ctx), ctx, "/learn after the middleware");
});

test("a 304 from the static files passes through without a body", async () => {
  const verify = async () => ({ courseSlug: course.slug, expires: now() + HOUR, paymentRef: "pay_fake" });
  const ctx = context("/learn");
  ctx.next = async () => new Response(null, { status: 304, headers: { ETag: '"abc"' } });
  const response = await gate(ctx, verify);
  assert.equal(response.status, 304);
  assert.equal(response.headers.get("Cache-Control"), GATED_CACHE_CONTROL);
});

test("/learn/logout clears the cookie and goes home, without needing an enrollment", async () => {
  let verified = 0;
  const verify = async () => {
    verified++;
    return null;
  };
  for (const [method, status] of [["GET", 302], ["POST", 303]]) {
    const ctx = context("/learn/logout", { method, cookie: `${ENROLL_COOKIE}=expired-or-broken` });
    // The middleware lets it through to the logout route.
    ctx.next = async () => logoutRoute.onRequest(ctx);
    const response = await learnMiddleware(ctx, verify);
    assert.equal(response.status, status, `${method} /learn/logout status`);
    assert.equal(response.headers.get("Location"), "/");
    assert.equal(response.headers.get("Cache-Control"), GATED_CACHE_CONTROL);
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    assert.match(setCookie, new RegExp(`^${ENROLL_COOKIE}=;`), "empties the cookie");
    assert.match(setCookie, /Max-Age=0/);
    assert.match(setCookie, /Path=\//);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
  }
  assert.equal(verified, 0, "logout must not depend on the enrollment check");
});

// ---------- with the real enrollment functions (skipped until checkout is merged) ----------

test("valid cookie: every course URL serves the page as private, no-store", real, async () => {
  const value = await issue({ ENROLL_SECRET: SECRET });
  for (const url of [...middlewareUrls.filter((u) => u !== "/learn/logout.html"), "/learn.html"]) {
    const { response, ctx } = await viaRoute(url, { cookie: `${ENROLL_COOKIE}=${value}` });
    await assertServed(response, ctx, `${url} with a valid cookie`);
  }
});

test("valid cookie among other cookies is found", real, async () => {
  const value = await issue({ ENROLL_SECRET: SECRET });
  const { response, ctx } = await viaRoute(lessons[0].href, { cookie: `theme=light; ${ENROLL_COOKIE}=${value}; _ga=GA1.1.1` });
  await assertServed(response, ctx, "valid cookie between others");
});

test("issued cookie follows the documented format", real, async () => {
  const value = await issue({ ENROLL_SECRET: SECRET });
  const parts = value.split(".");
  assert.equal(parts.length, 4, `expected <slug>.<expires>.<ref>.<hmacHex>, got "${value}"`);
  assert.equal(parts[0], course.slug);
  assert.match(parts[1], /^\d+$/);
  assert.match(parts[3], /^[0-9a-f]{64}$/i);
  const parsed = await verifyEnrollment({ ENROLL_SECRET: SECRET }, context("/learn", { cookie: `${ENROLL_COOKIE}=${value}` }).request);
  assert.equal(parsed?.courseSlug, course.slug);
  assert.equal(parsed?.paymentRef, "pay_test123");
});

test("expired cookie: a valid cookie redirects once its time is up", real, async () => {
  const value = await issue({ ENROLL_SECRET: SECRET }, { expires: now() + HOUR });
  await withClockAhead(2 * HOUR, async () => {
    for (const url of ["/learn", "/learn.html", lessons[0].href]) {
      const { response, ctx } = await viaRoute(url, { cookie: `${ENROLL_COOKIE}=${value}` });
      assertLocked(response, ctx, `${url} two hours after expiry`);
    }
  });
});

test("forged cookies: any edit to a valid cookie redirects", real, async () => {
  const value = await issue({ ENROLL_SECRET: SECRET });
  const [slug, expires, ref, mac] = value.split(".");
  const flip = (s) => s.slice(0, -1) + (s.at(-1) === "0" ? "1" : "0");
  const forged = {
    "signature changed": [slug, expires, ref, flip(mac)].join("."),
    "expiry pushed a year": [slug, String(Number(expires) + 365 * 24 * HOUR), ref, mac].join("."),
    "payment ref swapped": [slug, expires, "pay_someone_else", mac].join("."),
    "course swapped": ["another-course", expires, ref, mac].join("."),
    "signature dropped": [slug, expires, ref].join("."),
    "signed with another secret": await issue({ ENROLL_SECRET: "some-other-secret" }),
  };
  for (const [what, cookieValue] of Object.entries(forged)) {
    const { response, ctx } = await viaRoute(lessons[0].href, { cookie: `${ENROLL_COOKIE}=${cookieValue}` });
    assertLocked(response, ctx, `forged cookie (${what})`);
  }
});

test("demo key: works while no ENROLL_SECRET is set, never once one is", real, async () => {
  const demoValue = await issue({});
  const demo = await viaRoute("/learn", { env: {}, cookie: `${ENROLL_COOKIE}=${demoValue}` });
  await assertServed(demo.response, demo.ctx, "demo cookie on a site without a secret");
  const live = await viaRoute("/learn", { env: { ENROLL_SECRET: SECRET }, cookie: `${ENROLL_COOKIE}=${demoValue}` });
  assertLocked(live.response, live.ctx, "demo cookie on a site with ENROLL_SECRET set");
});
