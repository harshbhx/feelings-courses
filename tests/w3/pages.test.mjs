// W3 pages rendered by Functions: /signin, /auth/continue, /account, the D1 course area behind the
// gate (functions/learn/_gate.ts), /learn/logout and /verify.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleAccount } from "../../functions/_lib/pages/account.ts";
import { handleContinue, handleLogout, handleSignin, nextPath } from "../../functions/_lib/pages/auth.ts";
import { escapeHtml, formatRupees, html, markup } from "../../functions/_lib/pages/html.ts";
import { learnSegments } from "../../functions/_lib/pages/learn.ts";
import { handleVerifyPage } from "../../functions/_lib/pages/verify.ts";
import { siteMiddleware, coursePath } from "../../functions/learn/_gate.ts";
import { issueCertificate } from "../../functions/_lib/certificates.ts";
import { issueLoginToken, readSession } from "../../functions/_lib/session.ts";
import { LEGACY_ENROLL_COOKIE, SESSION_COOKIE } from "../../functions/_lib/config.ts";
import { context, cookiesFrom, postForm, req } from "../helpers/http.mjs";
import { fakeMailer } from "../helpers/mailer.mjs";
import { ASHA, completeCourse, env, NOW, sessionCookie, setupDb } from "./fixtures.mjs";

const cookieOf = (res) => {
  const c = cookiesFrom(res)[SESSION_COOKIE];
  return c ? `${SESSION_COOKIE}=${c.value}` : null;
};

function assertPageHeaders(res) {
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.match(res.headers.get("Content-Security-Policy"), /script-src 'self'; style-src 'self'/);
  assert.match(res.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal(res.headers.get("Referrer-Policy"), "same-origin");
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  assert.match(res.headers.get("X-Robots-Tag"), /noindex/);
}

test("html``: escapes interpolations; helpers", () => {
  const name = `<script>alert("x")</script>&'`;
  const out = markup(html`<p title="${name}">${name}</p>`);
  assert.equal(out.includes("<script>"), false);
  assert.ok(out.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;"));
  assert.equal(markup(html`<ul>${["a", "<b>"].map((x) => html`<li>${x}</li>`)}</ul>`), "<ul><li>a</li><li>&lt;b&gt;</li></ul>");
  assert.equal(escapeHtml(null), "");
  assert.equal(formatRupees(299900), "₹2,999");
  assert.equal(formatRupees(12345650), "₹1,23,456.50");
  assert.equal(nextPath("//evil.example"), "/account");
  assert.equal(nextPath("/signin?next=/x"), "/account", "no loops");
  assert.equal(nextPath("/learn/selfmakeup"), "/learn/selfmakeup");
});

test("GET /signin: a plain form; signed-in visitors go straight on", async () => {
  const db = await setupDb();
  const res = await handleSignin(req("/signin?next=/learn/selfmakeup"), env(db), NOW);
  assert.equal(res.status, 200);
  assertPageHeaders(res);
  const body = await res.text();
  assert.ok(body.includes('action="/signin"'));
  assert.ok(body.includes('value="/learn/selfmakeup"'));
  assert.equal(/<script(?![^>]*src=)/.test(body), false, "no inline script");
  assert.equal(/ style=/.test(body), false, "no inline style");

  const cookie = await sessionCookie(db, ASHA.id);
  const again = await handleSignin(req("/signin?next=/learn/selfmakeup", { cookie }), env(db), NOW);
  assert.equal(again.status, 302);
  assert.equal(again.headers.get("Location"), "/learn/selfmakeup");
});

test("POST /signin: emails a one-time link (landing on next); the same page for an unknown address", async () => {
  const db = await setupDb();
  const mail = fakeMailer();
  const known = await handleSignin(postForm("/signin", { email: " Asha@Example.com ", next: "/learn/selfmakeup" }, { ip: "192.0.2.10" }), env(db, mail.env), NOW);
  assert.equal(known.status, 200);
  assertPageHeaders(known);
  assert.equal(cookieOf(known), null, "asking for a link signs nobody in");
  const knownBody = await known.text();
  assert.ok(knownBody.includes("Check your email"));
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, ASHA.email);
  const link = mail.lastLink(ASHA.email);
  assert.match(link, /^https:\/\/courses\.feelingsbeautycare\.in\/auth\/continue\?t=[A-Za-z0-9_-]{43}$/);
  const row = db.get("SELECT purpose, redirect_path, expires_at, created_at FROM login_tokens");
  assert.deepEqual([row.purpose, row.redirect_path, row.expires_at - row.created_at], ["admin_link", "/learn/selfmakeup", 15 * 60]);

  const unknown = await handleSignin(postForm("/signin", { email: "nobody@example.com", next: "/learn/selfmakeup" }, { ip: "192.0.2.10" }), env(db, mail.env), NOW);
  assert.equal(unknown.status, 200);
  const unknownBody = await unknown.text();
  assert.equal(unknownBody.replaceAll("nobody@example.com", "X"), knownBody.replaceAll("asha@example.com", "X"), "the same page, whatever the address");
  assert.equal(mail.sent.length, 1, "no mail to an address without an account");

  // The link: Continue, then signed in on this device, the demo cookie cleared, landing on next.
  const go = await handleContinue(postForm("/auth/continue", { t: mail.tokenOf(link) }), env(db), NOW + 60);
  assert.equal(go.status, 303);
  assert.equal(go.headers.get("Location"), "/learn/selfmakeup");
  const cookies = cookiesFrom(go);
  assert.equal(cookies[LEGACY_ENROLL_COOKIE].attributes["max-age"], "0");
  assert.equal((await readSession(env(db), req("/", { cookie: cookieOf(go) }), NOW + 60)).studentId, ASHA.id);
});

test("POST /signin: errors re-render the form (escaped), cross-site posts are refused", async () => {
  const db = await setupDb();
  const mail = fakeMailer();
  const wrong = await handleSignin(postForm("/signin", { email: "asha at example" }, { ip: "192.0.2.11" }), env(db, mail.env), NOW);
  assert.equal(wrong.status, 400);
  assert.ok((await wrong.text()).includes("Enter an email like"));

  const xss = await handleSignin(postForm("/signin", { email: `"><script>x</script>` }, { ip: "192.0.2.12" }), env(db, mail.env), NOW);
  assert.equal(xss.status, 400);
  const body = await xss.text();
  assert.equal(body.includes("<script>x</script>"), false);
  assert.ok(body.includes('aria-invalid="true"'));

  const cross = await handleSignin(postForm("/signin", { email: ASHA.email }, { origin: "https://evil.example" }), env(db, mail.env), NOW);
  assert.equal(cross.status, 403);
  const fetchSite = await handleSignin(
    postForm("/signin", { email: ASHA.email }, { origin: null, headers: { "Sec-Fetch-Site": "cross-site" } }),
    env(db, mail.env),
    NOW,
  );
  assert.equal(fetchSite.status, 403);
  assert.equal(mail.sent.length, 0, "nothing sent for refused requests");
});

test("POST /signin: rate limited per IP and per address", async () => {
  const db = await setupDb();
  const mail = fakeMailer();
  let last;
  for (let i = 0; i < 11; i++) {
    last = await handleSignin(postForm("/signin", { email: `someone${i}@example.com` }, { ip: "192.0.2.13" }), env(db, mail.env), NOW);
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("Retry-After")) > 0);
  assert.ok((await last.text()).includes("Too many tries"));
  // Per address: 3 links in 15 minutes, from any IP.
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await handleSignin(postForm("/signin", { email: ASHA.email }, { ip: `198.51.100.${i + 1}` }), env(db, mail.env), NOW)).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  assert.equal(mail.sent.length, 3);
});

test("/auth/continue: the payment handoff signs in at once and lands on its path", async () => {
  const db = await setupDb();
  const token = await issueLoginToken(db, ASHA.id, "handoff", "/account?paid=1", NOW);
  const res = await handleContinue(req(`/auth/continue?t=${token}`), env(db), NOW + 5);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), "/account?paid=1");
  assert.equal(res.headers.get("Referrer-Policy"), "same-origin");
  assert.ok(cookieOf(res));
  const again = await handleContinue(req(`/auth/continue?t=${token}`), env(db), NOW + 6);
  assert.equal(again.status, 410, "single use");
});

test("/auth/continue: an admin link asks first (link previews can't use it up), then signs in once", async () => {
  const db = await setupDb();
  const token = await issueLoginToken(db, ASHA.id, "admin_link", "/account", NOW);
  const preview = await handleContinue(req(`/auth/continue?t=${token}`, { headers: { "User-Agent": "WhatsApp/2.23" } }), env(db), NOW);
  assert.equal(preview.status, 200);
  assertPageHeaders(preview);
  assert.equal(cookieOf(preview), null);
  const page = await preview.text();
  assert.ok(page.includes('action="/auth/continue"'));
  assert.ok(page.includes(`name="t" value="${token}"`));
  assert.equal(db.get("SELECT used_at FROM login_tokens").used_at, null, "GET didn't use the token");

  const cross = await handleContinue(postForm("/auth/continue", { t: token }, { origin: "https://evil.example" }), env(db), NOW);
  assert.equal(cross.status, 403);

  const go = await handleContinue(postForm("/auth/continue", { t: token }), env(db), NOW + 60);
  assert.equal(go.status, 303);
  assert.equal(go.headers.get("Location"), "/account");
  assert.ok(cookieOf(go));
  assert.equal(db.get("SELECT action FROM audit_log WHERE action LIKE 'student.%signin'").action, "student.link_signin");
  const twice = await handleContinue(postForm("/auth/continue", { t: token }), env(db), NOW + 61);
  assert.equal(twice.status, 410);
  const junk = await handleContinue(req("/auth/continue?t=%3Cscript%3E"), env(db), NOW);
  assert.equal(junk.status, 410);
});

test("/account: courses, devices, payments; signs other devices out", async () => {
  const db = await setupDb();
  const anon = await handleAccount(req("/account"), env(db), NOW);
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("Location"), "/signin?next=/account");

  const laptop = await sessionCookie(db, ASHA.id, { now: NOW - 10, userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0" });
  const phone = await sessionCookie(db, ASHA.id);
  const res = await handleAccount(req("/account", { cookie: phone }), env(db), NOW);
  assert.equal(res.status, 200);
  assertPageHeaders(res);
  const body = await res.text();
  for (const text of ["Hello, Asha", "Self Makeup Masterclass", "Access ended", "November mornings", "Signed in on 2 of 2 devices", "Chrome on Windows", "This device", ASHA.payment, "₹2,999"]) {
    assert.ok(body.includes(text), `shows ${text}`);
  }
  assert.ok(body.includes('href="/learn/selfmakeup"'));
  assert.equal(body.includes('href="/learn/old-class"'), false, "no link to an expired course");
  assert.equal(body.includes("Gone Class"), false);

  const others = await handleAccount(postForm("/account", { action: "signout_others" }, { cookie: phone }), env(db), NOW);
  assert.equal(others.status, 303);
  assert.equal(await readSession(env(db), req("/", { cookie: laptop }), NOW), null);
  assert.ok(await readSession(env(db), req("/", { cookie: phone }), NOW));

  const rename = await handleAccount(postForm("/account", { action: "name", name: "<b>Asha</b>" }, { cookie: phone }), env(db), NOW);
  assert.equal(rename.status, 303);
  const after = await (await handleAccount(req("/account?done=name", { cookie: phone }), env(db), NOW)).text();
  assert.ok(after.includes("Hello, &lt;b&gt;Asha&lt;/b&gt;"));
  assert.ok(after.includes("Your name is saved."));

  const cross = await handleAccount(postForm("/account", { action: "signout_others" }, { cookie: phone, origin: "https://evil.example" }), env(db), NOW);
  assert.equal(cross.status, 403);
});

test("gate with D1: /learn pages need a session and an active enrollment; never the static files", async () => {
  const db = await setupDb();
  const run = async (path, opts = {}) => {
    const ctx = context({ request: req(path, opts), env: env(db) });
    const res = await siteMiddleware(ctx);
    assert.equal(ctx.nextCalls.length, 0, `${path} never reaches the static course pages`);
    return res;
  };
  const anon = await run("/learn/selfmakeup");
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("Location"), "/signin?next=%2Flearn%2Fselfmakeup");
  assert.equal((await run("/%6cearn/selfmakeup")).status, 302, "odd spellings are gated too");
  assert.equal((await run("/learn/know-your-skin-type")).status, 302, "the demo's static lesson paths too");

  const cookie = await sessionCookie(db, ASHA.id);
  const course = await run("/learn/selfmakeup", { cookie });
  assert.equal(course.status, 200);
  assertPageHeaders(course);
  const page = await course.text();
  assert.ok(page.includes("Know your skin type"));
  assert.ok(page.includes('href="/learn/selfmakeup/know-your-skin-type"'));
  assert.ok(page.includes("0 of 9 lessons done"));

  assert.equal((await run("/learn", { cookie })).headers.get("Location"), "/account");
  assert.equal((await run("/learn/old-class", { cookie })).status, 403, "expired: says so");
  assert.ok((await (await run("/learn/old-class", { cookie })).text()).includes("Your access ended on"));
  assert.equal((await run("/learn/diploma", { cookie })).status, 404);
  assert.equal((await run("/learn/selfmakeup/no-such-lesson", { cookie })).status, 404);
  assert.equal((await run("/learn/a/b/c", { cookie })).status, 404);
  assert.equal((await run("/LEARN/SelfMakeup.html", { cookie })).status, 200, "case and .html twins resolve");

  const bina = await sessionCookie(db, 2);
  assert.equal((await run("/learn/selfmakeup", { cookie: bina })).status, 403, "refunded and revoked");
});

test("gate with D1: lesson page, mark as done, next lesson, notes escaped", async () => {
  const db = await setupDb();
  const cookie = await sessionCookie(db, ASHA.id);
  const run = (request) => siteMiddleware(context({ request, env: env(db) }));

  const lesson = await run(req("/learn/evening-class/lights", { cookie }));
  assert.equal(lesson.status, 200);
  const body = await lesson.text();
  assert.ok(body.includes("Second &lt;b&gt;paragraph&lt;/b&gt;."), "notes are text, never HTML");
  assert.ok(body.includes("can&#39;t be played right now"), "W4's playback is a stub here: a calm placeholder");
  assert.ok(body.includes('src="/app/learn.js"'));

  const done = await run(postForm("/learn/evening-class/lights", { action: "done" }, { cookie }));
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("Location"), "/learn/evening-class/colour");
  assert.ok(db.get("SELECT completed_at FROM lesson_progress WHERE lesson_id = 2001").completed_at);

  const cross = await run(postForm("/learn/evening-class/colour", { action: "done" }, { cookie, origin: "https://evil.example" }));
  assert.equal(cross.status, 403);
  assert.equal(db.get("SELECT count(*) AS n FROM lesson_progress WHERE lesson_id = 2002").n, 0);

  const last = await run(postForm("/learn/evening-class/colour", { action: "done" }, { cookie }));
  assert.equal(last.headers.get("Location"), "/learn/evening-class");
  const home = await (await run(req("/learn/evening-class", { cookie }))).text();
  assert.ok(home.includes("2 of 2 lessons done"));
  assert.equal(home.includes("Certificate"), false, "no wording, no certificate card");
});

test("gate with D1: certificate claim flow ends on the public verify page", async () => {
  const db = await setupDb();
  const cookie = await sessionCookie(db, ASHA.id);
  const run = (request) => siteMiddleware(context({ request, env: env(db) }));
  const early = await (await run(req("/learn/selfmakeup/certificate", { cookie }))).text();
  assert.ok(early.includes("Finish every lesson"));

  completeCourse(db, ASHA.id, 1);
  const form = await (await run(req("/learn/selfmakeup/certificate", { cookie }))).text();
  assert.ok(form.includes('value="Asha Patel"'), "prefilled with the student's name");
  const bad = await run(postForm("/learn/selfmakeup/certificate", { name: "A" }, { cookie }));
  assert.equal(bad.status, 400);
  const ok = await run(postForm("/learn/selfmakeup/certificate", { name: "Asha <Patel>" }, { cookie }));
  assert.equal(ok.status, 303);
  const location = ok.headers.get("Location");
  assert.match(location, /^\/verify\/[0-9A-HJKMNP-TV-Z]{10}$/);

  const verify = await handleVerifyPage(req(location), env(db), location.split("/").pop(), NOW);
  assert.equal(verify.status, 200);
  assertPageHeaders(verify);
  const page = await verify.text();
  assert.ok(page.includes("Asha &lt;Patel&gt;"));
  assert.ok(page.includes("Self Makeup Masterclass"));
  assert.ok(page.includes("Certificate of completion from Feelings Beauty Care"));
  assert.ok(page.includes("23 October 2026"));
  assert.equal(page.includes(ASHA.phone), false, "no contact details");
  assert.equal(page.includes(ASHA.email), false);
});

test("/verify: lookup form, canonical redirect, not found, withdrawn, rate limit", async () => {
  const db = await setupDb();
  const cert = await issueCertificate(env(db), { studentId: ASHA.id, courseId: 1, name: "Asha", now: NOW });
  const form = await handleVerifyPage(req("/verify"), env(db), null, NOW);
  assert.equal(form.status, 200);
  const typed = await handleVerifyPage(req(`/verify?code=${cert.code.toLowerCase()}`), env(db), null, NOW);
  assert.equal(typed.status, 302);
  assert.equal(typed.headers.get("Location"), `/verify/${cert.code}`);
  const lower = await handleVerifyPage(req(`/verify/${cert.code.toLowerCase()}`), env(db), cert.code.toLowerCase(), NOW);
  assert.equal(lower.status, 301);
  assert.equal((await handleVerifyPage(req("/verify/ZZZZZZZZZZ"), env(db), "ZZZZZZZZZZ", NOW)).status, 404);
  db.sqlite.exec(`UPDATE certificates SET revoked_at = ${NOW}`);
  const withdrawn = await handleVerifyPage(req(`/verify/${cert.code}`), env(db), cert.code, NOW);
  assert.equal(withdrawn.status, 404);
  const text = await withdrawn.text();
  assert.ok(text.includes("withdrawn"));
  assert.equal(text.includes("Asha"), false);

  let last;
  for (let i = 0; i < 31; i++) last = await handleVerifyPage(req("/verify/ZZZZZZZZZZ", { ip: "203.0.113.77" }), env(db), "ZZZZZZZZZZ", NOW);
  assert.equal(last.status, 429);
});

test("/learn/logout with D1: GET only asks; POST revokes this device and clears both cookies", async () => {
  const db = await setupDb();
  const cookie = await sessionCookie(db, ASHA.id);
  const ask = await handleLogout(req("/learn/logout", { cookie }), env(db), NOW);
  assert.equal(ask.status, 200);
  assert.ok(await readSession(env(db), req("/", { cookie }), NOW), "GET changes nothing");
  const out = await siteMiddleware(context({ request: postForm("/learn/logout", {}, { cookie }), env: env(db) }));
  assert.equal(out.status, 303);
  const cookies = cookiesFrom(out);
  assert.equal(cookies[SESSION_COOKIE].attributes["max-age"], "0");
  assert.equal(cookies[LEGACY_ENROLL_COOKIE].attributes["max-age"], "0");
  assert.equal(await readSession(env(db), req("/", { cookie }), NOW), null);
});

test("coursePath and learnSegments agree on what is the course area", () => {
  assert.equal(coursePath("/learn"), "/learn");
  assert.equal(coursePath("/%6cearn//x/./y/../z"), "/learn/x/z");
  assert.equal(coursePath("/learning"), null);
  assert.equal(coursePath("/app/learn.js"), null);
  assert.deepEqual(learnSegments("/learn"), []);
  assert.deepEqual(learnSegments("/learn/Course/Lesson.html"), ["course", "lesson"]);
  assert.equal(learnSegments("/learn/a/b/c"), null);
  assert.equal(learnSegments("/learn/<x>"), null);
});

test("before setup (no D1): the account pages say so instead of failing", async () => {
  for (const handler of [handleSignin, handleAccount, handleContinue, handleLogout]) {
    const get = await handler(req("/signin"), {}, NOW);
    assert.equal(get.status, 503);
    const post = await handler(postForm("/signin", { contact: "9876543210", paymentId: ASHA.payment }), {}, NOW);
    assert.equal(post.status, 503);
  }
});
