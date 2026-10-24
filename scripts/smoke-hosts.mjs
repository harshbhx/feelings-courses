// Post-deploy smoke check of the hosts (W1): does every host answer as docs/platform/HOSTS.md says,
// with the security headers? Read-only GET/HEAD requests; it changes nothing.
//
//   node scripts/smoke-hosts.mjs                         # the hub only
//   node scripts/smoke-hosts.mjs selfmakeup diploma      # plus these course hosts
//   HUB_HOST=… APEX_DOMAIN=… node scripts/smoke-hosts.mjs
//
// Exit code 1 when a check fails, with one line per problem. Run it after attaching a course
// domain in the Pages dashboard, and after any change to functions/_lib/hosts.ts or _headers.

const hub = process.env.HUB_HOST?.trim() || "courses.feelingsbeautycare.in";
const apex = process.env.APEX_DOMAIN?.trim() || "feelingsbeautycare.in";
const slugs = process.argv.slice(2).filter((s) => /^[a-z0-9-]{2,40}$/.test(s));

const REQUIRED = {
  "x-content-type-options": /^nosniff$/,
  "referrer-policy": /strict-origin-when-cross-origin/,
  "strict-transport-security": /max-age=\d+/,
  "x-frame-options": /^(SAMEORIGIN|DENY)$/,
};

const problems = [];
let checks = 0;

async function get(url, method = "GET") {
  return fetch(url, { method, redirect: "manual", headers: { "User-Agent": "feelings-courses-smoke/1" }, signal: AbortSignal.timeout(15_000) });
}

function expect(ok, message) {
  checks++;
  if (!ok) problems.push(message);
}

function securityHeaders(res, url, { html = false } = {}) {
  for (const [name, re] of Object.entries(REQUIRED)) {
    const value = res.headers.get(name);
    expect(value !== null && re.test(value), `${url}: ${name} is ${value === null ? "missing" : `"${value}"`}`);
  }
  if (html) {
    const csp = res.headers.get("content-security-policy");
    expect(!!csp && /default-src 'self'/.test(csp), `${url}: full Content-Security-Policy missing (got ${csp ? `"${csp.slice(0, 60)}…"` : "none"})`);
  }
}

async function checkHub() {
  const base = `https://${hub}`;
  const home = await get(`${base}/`);
  expect(home.status === 200, `${base}/ answered ${home.status}`);
  securityHeaders(home, `${base}/`, { html: true });

  const robots = await get(`${base}/robots.txt`);
  const text = await robots.text();
  expect(robots.status === 200 && /Sitemap: /.test(text), `${base}/robots.txt has no Sitemap line`);

  const sitemap = await get(`${base}/sitemap.xml`);
  expect(sitemap.status === 200 && /<urlset/.test(await sitemap.text()), `${base}/sitemap.xml is not a sitemap`);

  const admin = await get(`${base}/admin`);
  expect(admin.headers.get("x-frame-options") === "DENY", `${base}/admin is frameable (X-Frame-Options ${admin.headers.get("x-frame-options")})`);
  expect(/noindex/.test(admin.headers.get("x-robots-tag") ?? ""), `${base}/admin has no X-Robots-Tag noindex`);

  const missing = await get(`${base}/c/this-course-does-not-exist`);
  expect(missing.status === 404, `${base}/c/<unknown> answered ${missing.status}, expected 404`);

  const snapshot = await get(`${base}/api/public/snapshot`, "HEAD");
  expect([200, 404].includes(snapshot.status), `${base}/api/public/snapshot answered ${snapshot.status} (a 5xx fails every build)`);

  for (const page of ["terms", "refunds", "privacy", "delivery"]) {
    const res = await get(`${base}/legal/${page}`, "HEAD");
    expect(res.status === 200, `${base}/legal/${page} answered ${res.status}`);
  }
}

async function checkCourse(slug) {
  const base = `https://${slug}.${apex}`;
  const home = await get(`${base}/`);
  expect(home.status === 200, `${base}/ answered ${home.status}`);
  securityHeaders(home, `${base}/`, { html: true });
  const body = await home.text();
  expect(body.includes('rel="canonical"'), `${base}/ has no canonical link`);

  const learn = await get(`${base}/learn`);
  expect(learn.status === 302 && learn.headers.get("location") === `https://${hub}/learn`, `${base}/learn should 302 to the hub (got ${learn.status} ${learn.headers.get("location")})`);

  const terms = await get(`${base}/terms`, "HEAD");
  expect(terms.status === 200, `${base}/terms answered ${terms.status}`);

  const robots = await (await get(`${base}/robots.txt`)).text();
  expect(robots.includes(`Sitemap: ${base}/sitemap.xml`), `${base}/robots.txt doesn't point at its own sitemap`);

  const fromHub = await get(`https://${hub}/c/${slug}`);
  expect(
    fromHub.status === 301 && fromHub.headers.get("location")?.startsWith(`${base}/`),
    `https://${hub}/c/${slug} should 301 to ${base}/ once the domain is active (got ${fromHub.status})`,
  );
}

try {
  await checkHub();
  for (const slug of slugs) await checkCourse(slug);
} catch (err) {
  problems.push(`request failed: ${err?.message ?? err}`);
}

if (problems.length) {
  console.error(`smoke-hosts: ${problems.length} problem(s) in ${checks} checks:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`smoke-hosts: ${checks} checks passed (hub${slugs.length ? ` + ${slugs.join(", ")}` : ""}).`);
