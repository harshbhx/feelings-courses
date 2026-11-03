// Probes the built site running under `wrangler pages dev` (real Pages routing, _headers,
// _routes.json, Functions and a local D1 and R2), the closest thing to a deploy without one.
// The Verify workflow runs it; it needs a build in dist/ first:
//
//   npx wrangler pages dev dist --d1 DB --r2 MEDIA --port 8788 &
//   node scripts/ci/smoke-local.mjs http://127.0.0.1:8788
//
// Checks: the pages answer, the static pages carry the hashed CSP from dist/_headers through the
// root middleware, the first request migrated D1 (the public snapshot lists the seed's published
// course), the admin API reports "not configured" (no secrets in CI) rather than crashing, and
// nothing answers 5xx. Read-only GETs plus one harmless POST. Exit 1 with one line per problem.

const base = (process.argv[2] ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const problems = [];
let checks = 0;
const expect = (ok, message) => {
  checks++;
  if (!ok) problems.push(message);
};

async function waitUntilUp(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/`, { redirect: "manual" });
      await res.arrayBuffer();
      return;
    } catch (err) {
      if (Date.now() > until) throw new Error(`smoke: ${base} didn't come up in ${timeoutMs / 1000} s (${err?.message ?? err})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function get(path, init = {}) {
  const res = await fetch(`${base}${path}`, { redirect: "manual", ...init });
  const body = await res.text();
  return { res, body };
}

await waitUntilUp();

// Static pages: 200, HTML, the security headers, and the build's hashed CSP (not the baseline one
// functions/_lib/hosts.ts adds to Function-made HTML).
for (const path of ["/", "/legal/terms", "/catalog", "/admin"]) {
  const { res, body } = await get(path);
  expect(res.status === 200, `GET ${path}: ${res.status} (want 200)`);
  expect((res.headers.get("content-type") ?? "").includes("text/html"), `GET ${path}: content-type ${res.headers.get("content-type")}`);
  expect(res.headers.get("x-content-type-options") === "nosniff", `GET ${path}: no X-Content-Type-Options`);
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(/script-src [^;]*'self'/.test(csp), `GET ${path}: CSP without the build's script-src (got "${csp.slice(0, 80)}")`);
  if (/<script(?![^>]*\bsrc=)(?![^>]*type="application\/(?:ld\+)?json")[^>]*>\s*\S/i.test(body)) {
    expect(/'sha256-/.test(csp), `GET ${path}: the page has inline scripts but the CSP has no hashes`);
  }
}

// Manifests the admin and router read.
for (const path of ["/build.json", "/domains.json", "/sitemap.xml", "/robots.txt"]) {
  const { res } = await get(path);
  expect(res.status === 200, `GET ${path}: ${res.status} (want 200)`);
}

// The first request ran the migrations: the snapshot has the seed's published (demo) course.
{
  const { res, body } = await get("/api/public/snapshot");
  expect(res.status === 200, `GET /api/public/snapshot: ${res.status} (want 200: did the runtime migration fail? see the wrangler log)`);
  if (res.status === 200) {
    try {
      const snap = JSON.parse(body);
      expect(Array.isArray(snap.courses) && snap.courses.length >= 1, "GET /api/public/snapshot: no published course (seed missing?)");
    } catch {
      expect(false, "GET /api/public/snapshot: not JSON");
    }
  }
}

// No secrets in CI: the admin API must say so, not crash.
{
  const { res } = await get("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ password: "not-the-password" }),
  });
  expect(res.status < 500 || res.status === 503, `POST /api/admin/login: ${res.status}`);
}

// Unknown paths: 404, never 5xx.
{
  const { res } = await get("/no-such-page-here");
  expect(res.status === 404, `GET /no-such-page-here: ${res.status} (want 404)`);
}

// The course area without a session: a redirect or a sign-in page, never 5xx.
for (const path of ["/learn", "/account", "/signin"]) {
  const { res } = await get(path);
  expect(res.status < 500, `GET ${path}: ${res.status}`);
}

if (problems.length) {
  console.error(`smoke-local: ${problems.length} of ${checks} checks failed:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`smoke-local: ${checks} checks passed against ${base}.`);
