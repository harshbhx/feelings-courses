// W8 integration: what a course host (<slug>.feelingsbeautycare.in) does with every Functions route
// of W1 to W7. The table below is a snapshot: a new route file fails this test until it is added
// here with a decision, so no route reaches course hosts by accident.
//
//   serve  the course host answers it itself (checkout, public reads, media)
//   hub    302 to the same path on the hub (pages with the student's or the admin's cookie)
//   404    an API that only the hub answers (never a cross-origin redirect for an API call)
import { test } from "node:test";
import assert from "node:assert/strict";
import { hostRouting, resetHostState } from "../../functions/_lib/hosts.ts";
import { req } from "../helpers/http.mjs";
import { findRoute, routeFiles } from "./site.mjs";

const EXPECTED = {
  "account.ts": "hub",
  "api/admin/audit.ts": "404",
  "api/admin/backup/index.ts": "404",
  "api/admin/backup/run.ts": "404",
  "api/admin/batches/[id].ts": "404",
  "api/admin/coupons/[id].ts": "404",
  "api/admin/coupons/index.ts": "404",
  "api/admin/courses/[id]/archive.ts": "404",
  "api/admin/courses/[id]/batches.ts": "404",
  "api/admin/courses/[id]/domain/check.ts": "404",
  "api/admin/courses/[id]/index.ts": "404",
  "api/admin/courses/[id]/outline.ts": "404",
  "api/admin/courses/[id]/publish.ts": "404",
  "api/admin/courses/[id]/unpublish.ts": "404",
  "api/admin/courses/index.ts": "404",
  "api/admin/enrollments/[id].ts": "404",
  "api/admin/login.ts": "404",
  "api/admin/logout.ts": "404",
  "api/admin/me.ts": "404",
  "api/admin/media.ts": "404",
  "api/admin/orders.csv.ts": "404",
  "api/admin/orders/[id]/index.ts": "404",
  "api/admin/orders/[id]/refund.ts": "404",
  "api/admin/orders/[id]/sync.ts": "404",
  "api/admin/orders/index.ts": "404",
  "api/admin/password.ts": "404",
  "api/admin/publish/index.ts": "404",
  "api/admin/publish/status.ts": "404",
  "api/admin/settings.ts": "404",
  "api/admin/stats.ts": "404",
  "api/admin/students.csv.ts": "404",
  "api/admin/students/[id]/access-link.ts": "404",
  "api/admin/students/[id]/certificate.ts": "404",
  "api/admin/students/[id]/enrollments.ts": "404",
  "api/admin/students/[id]/erase.ts": "404",
  "api/admin/students/[id]/index.ts": "404",
  "api/admin/students/[id]/signout-all.ts": "404",
  "api/admin/students/index.ts": "404",
  "api/admin/uploads/[id]/complete.ts": "404",
  "api/admin/uploads/[id]/index.ts": "404",
  "api/admin/uploads/[id]/parts/[n].ts": "404",
  "api/admin/uploads/index.ts": "404",
  "api/admin/webhooks/[id]/replay.ts": "404",
  "api/admin/webhooks/index.ts": "404",
  "api/auth/restore.ts": "404",
  "api/auth/signout.ts": "404",
  "api/certificates/[code].ts": "404",
  "api/coupon/quote.ts": "serve",
  "api/learn/[slug]/certificate.ts": "404",
  "api/learn/[slug]/index.ts": "404",
  "api/learn/[slug]/lessons/[lessonId]/play.ts": "404",
  "api/learn/progress.ts": "404",
  "api/me/index.ts": "404",
  "api/me/orders/[id].ts": "404",
  "api/me/orders/index.ts": "404",
  "api/me/sessions/[id].ts": "404",
  "api/me/sessions/index.ts": "404",
  "api/order.ts": "serve",
  "api/public/preview/[lessonId].ts": "serve",
  "api/public/snapshot.ts": "serve",
  // The webhook is registered with Razorpay on the hub only.
  "api/razorpay/webhook.ts": "404",
  "api/t.ts": "serve",
  "api/verify.ts": "serve",
  "auth/continue.ts": "hub",
  "learn.html.ts": "hub",
  "learn.ts": "hub",
  "learn/logout.ts": "hub",
  "media/c/[lessonId].ts": "serve",
  "media/i/[[key]].ts": "serve",
  "media/v/[lessonId].ts": "serve",
  "receipt/[id].ts": "hub",
  "signin.ts": "hub",
  "verify/[code].ts": "hub",
  "verify/index.ts": "hub",
};

/** A concrete path for a route file: parameters get sample values. */
function samplePath(file) {
  const parts = file.replace(/\.ts$/, "").split("/");
  if (parts.at(-1) === "index") parts.pop();
  return `/${parts.map((p) => (/^\[\[\w+\]\]$/.test(p) ? "images/x.png" : /^\[\w+\]$/.test(p) ? "7" : p)).join("/")}`;
}

test("every Functions route has a decision for course hosts", () => {
  const routes = routeFiles().filter((f) => !f.endsWith("_middleware.ts"));
  const missing = routes.filter((f) => !(f in EXPECTED));
  const gone = Object.keys(EXPECTED).filter((f) => !routes.includes(f));
  assert.deepEqual(missing, [], "new route files: add them to EXPECTED with serve, hub or 404");
  assert.deepEqual(gone, [], "route files that no longer exist");
  for (const file of routes) assert.equal(findRoute(samplePath(file))?.file, file, `the test router finds ${file}`);
});

test("course hosts: serve, send to the hub, or 404, as the snapshot says", async () => {
  resetHostState();
  for (const [file, expected] of Object.entries(EXPECTED)) {
    const path = samplePath(file);
    const api = path.startsWith("/api/");
    const method = api && expected !== "serve" ? "POST" : "GET";
    const request = req(`https://glow.feelingsbeautycare.in${path}`, { method, body: method === "POST" ? {} : undefined });
    const res = await hostRouting(
      { request, env: {}, data: {}, next: async () => new Response("x") },
      async () => new Response("served", { status: 200 }),
    );
    const got = res.status === 200 && (await res.text()) === "served" ? "serve" : res.status === 302 ? "hub" : String(res.status);
    assert.equal(got, expected, `${method} ${path} (${file})`);
    if (got === "hub") assert.equal(res.headers.get("Location"), `https://courses.feelingsbeautycare.in${path}`);
  }
});

test("the hub serves every route itself", async () => {
  resetHostState();
  for (const file of Object.keys(EXPECTED)) {
    const path = samplePath(file);
    const res = await hostRouting(
      { request: req(path), env: {}, data: {}, next: async () => new Response("x") },
      async () => new Response("served", { status: 200 }),
    );
    assert.equal(res.status, 200, `${path} on the hub`);
  }
});
