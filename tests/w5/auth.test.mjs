// W5 admin sign-in: password forms, rate limits and lock, session cookie, idle/absolute expiry,
// logout, password change, and the middleware's gate (Origin, JSON, host, headers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/d1.mjs";
import { cookiesFrom, readJson, req } from "../helpers/http.mjs";
import {
  LOCKOUT_BUCKET,
  hashAdminPassword,
  login,
  readAdminSession,
  verifyAdminPassword,
} from "../../functions/_lib/admin/auth.ts";
import { loginRoute, logoutRoute, meRoute, passwordRoute, coursesRoute } from "../../functions/_lib/admin/routes.ts";
import { ADMIN_ABSOLUTE_TTL, ADMIN_IDLE_TTL } from "../../functions/_lib/config.ts";
import { APP_SECRET, PASSWORD, PASSWORD_HASH, adminEnv, callRoute, signIn } from "./fixtures.mjs";

test("verifyAdminPassword accepts the setup script's HMAC hash and the stretched form", async () => {
  assert.equal(await verifyAdminPassword(APP_SECRET, PASSWORD, PASSWORD_HASH), true);
  assert.equal(await verifyAdminPassword(APP_SECRET, PASSWORD, PASSWORD_HASH.toUpperCase()), true);
  assert.equal(await verifyAdminPassword(APP_SECRET, `${PASSWORD}x`, PASSWORD_HASH), false);
  assert.equal(await verifyAdminPassword("b".repeat(64), PASSWORD, PASSWORD_HASH), false, "the pepper matters");

  const stretched = await hashAdminPassword(APP_SECRET, "a new long passphrase", 1_000);
  assert.match(stretched, /^pbkdf2-sha256\$1000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await verifyAdminPassword(APP_SECRET, "a new long passphrase", stretched), true);
  assert.equal(await verifyAdminPassword(APP_SECRET, "a new long passphrase!", stretched), false);
  assert.notEqual(await hashAdminPassword(APP_SECRET, "same", 1_000), await hashAdminPassword(APP_SECRET, "same", 1_000), "salted");

  // Tampered or unknown forms never match (and never cost more than the cap).
  const [, , salt, hash] = stretched.split("$");
  assert.equal(await verifyAdminPassword(APP_SECRET, "a new long passphrase", `pbkdf2-sha256$100001$${salt}$${hash}`), false);
  assert.equal(await verifyAdminPassword(APP_SECRET, PASSWORD, ""), false);
  assert.equal(await verifyAdminPassword(APP_SECRET, PASSWORD, `plain$${PASSWORD}`), false);
});

test("login sets a host-only, HttpOnly, SameSite=Strict cookie and stores only the token's hash", async () => {
  const db = await createTestDb();
  const env = adminEnv(db);
  const res = await callRoute(loginRoute, env, "POST", "/api/admin/login", { body: { password: PASSWORD } });
  assert.equal(res.status, 200);
  assert.deepEqual(await readJson(res), { ok: true });
  const cookie = cookiesFrom(res)["__Host-fbc_admin"];
  assert.ok(cookie, "the __Host- cookie is set");
  assert.match(cookie.value, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(cookie.attributes.httponly, true);
  assert.equal(cookie.attributes.secure, true);
  assert.equal(cookie.attributes.samesite, "Strict");
  assert.equal(cookie.attributes.path, "/");
  assert.equal(cookie.attributes.domain, undefined);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(res.headers.get("X-Frame-Options"), "DENY");

  const row = db.get("SELECT token_hash, ip FROM admin_sessions");
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.token_hash, cookie.value);
  assert.equal(db.get("SELECT count(*) AS n FROM audit_log WHERE action = 'admin.login'").n, 1);

  const me = await callRoute(meRoute, env, "GET", "/api/admin/me", { cookie: `__Host-fbc_admin=${cookie.value}` });
  assert.equal(me.status, 200);
  const body = await readJson(me);
  assert.equal(body.ok, true);
  assert.equal(body.appEnv, "production");
  assert.equal(body.paymentMode, "not_configured");
});

test("every admin route but login needs a session", async () => {
  const db = await createTestDb();
  const env = adminEnv(db);
  const none = await callRoute(coursesRoute, env, "GET", "/api/admin/courses");
  assert.equal(none.status, 401);
  assert.equal((await readJson(none)).error, "unauthorized");

  const forged = await callRoute(coursesRoute, env, "GET", "/api/admin/courses", { cookie: `__Host-fbc_admin=${"x".repeat(43)}` });
  assert.equal(forged.status, 401);
  assert.match(forged.headers.get("Set-Cookie") ?? "", /Max-Age=0/, "a dead cookie is cleared");

  const cookie = await signIn(env);
  assert.equal((await callRoute(coursesRoute, env, "GET", "/api/admin/courses", { cookie })).status, 200);
});

test("a wrong password is 401; the 6th try from one IP in 15 minutes is 429 even when right", async () => {
  const db = await createTestDb();
  const env = adminEnv(db);
  const ip = "203.0.113.5";
  for (let i = 0; i < 5; i++) {
    const res = await callRoute(loginRoute, env, "POST", "/api/admin/login", { body: { password: `wrong-${i}` }, ip });
    assert.equal(res.status, 401);
    assert.equal((await readJson(res)).error, "wrong_password");
  }
  const sixth = await callRoute(loginRoute, env, "POST", "/api/admin/login", { body: { password: PASSWORD }, ip });
  assert.equal(sixth.status, 429);
  assert.equal((await readJson(sixth)).error, "rate_limited");
  assert.ok(Number(sixth.headers.get("Retry-After")) > 0);
  assert.equal(db.get("SELECT count(*) AS n FROM admin_sessions").n, 0);

  // Another IP is not affected.
  assert.equal((await callRoute(loginRoute, env, "POST", "/api/admin/login", { body: { password: PASSWORD }, ip: "203.0.113.6" })).status, 200);
  assert.equal(db.get("SELECT count(*) AS n FROM audit_log WHERE action = 'admin.login_failed'").n, 5);
});

test("over 20 wrong passwords a day lock sign-in for everyone for an hour", async () => {
  const db = await createTestDb();
  const env = adminEnv(db);
  const now = 1_800_000_000;
  const request = (ip) => req("/api/admin/login", { method: "POST", body: { password: "nope" }, ip });
  for (let i = 0; i < 20; i++) {
    const result = await login(env, request(`192.0.2.${i}`), "nope", now + i);
    assert.equal(result.code, "wrong_password");
  }
  assert.equal(db.get("SELECT count(*) AS n FROM rate_limits WHERE bucket = ?", LOCKOUT_BUCKET).n, 0, "20 is still allowed");
  await login(env, request("192.0.2.200"), "nope", now + 30);
  assert.ok(db.get("SELECT expires_at FROM rate_limits WHERE bucket = ?", LOCKOUT_BUCKET).expires_at > now);

  const locked = await login(env, request("192.0.2.201"), PASSWORD, now + 60);
  assert.equal(locked.ok, false);
  assert.equal(locked.code, "admin_locked");
  assert.ok(locked.retryAfter > 3000 && locked.retryAfter <= 3600);

  // An hour later the right password works again.
  const later = await login(env, request("192.0.2.202"), PASSWORD, now + 30 + 3601);
  assert.equal(later.ok, true);
});

test("sessions end after 12 hours idle or 7 days in all, and on logout", async () => {
  const db = await createTestDb();
  const env = adminEnv(db);
  const cookie = await signIn(env);
  const request = req("/api/admin/me", { cookie });
  const created = db.get("SELECT created_at FROM admin_sessions").created_at;

  assert.ok(await readAdminSession(db, request, created + 60));
  // Used again after 11 hours: still valid, and the idle clock restarts.
  assert.ok(await readAdminSession(db, request, created + 11 * 3600));
  assert.ok(await readAdminSession(db, request, created + 22 * 3600));
  assert.equal(await readAdminSession(db, request, created + 22 * 3600 + ADMIN_IDLE_TTL + 1), null, "idle too long");

  // Kept busy, it still ends at the absolute limit.
  const cookie2 = await signIn(env, { ip: "198.51.100.2" });
  const request2 = req("/api/admin/me", { cookie: cookie2 });
  const start = db.get("SELECT max(created_at) AS t FROM admin_sessions").t;
  for (let t = start; t < start + ADMIN_ABSOLUTE_TTL; t += 6 * 3600) assert.ok(await readAdminSession(db, request2, t));
  assert.equal(await readAdminSession(db, request2, start + ADMIN_ABSOLUTE_TTL + 1), null, "absolute limit");

  const cookie3 = await signIn(env, { ip: "198.51.100.3" });
  const out = await callRoute(logoutRoute, env, "POST", "/api/admin/logout", { cookie: cookie3 });
  assert.equal(out.status, 204);
  assert.match(out.headers.get("Set-Cookie"), /Max-Age=0/);
  assert.equal((await callRoute(meRoute, env, "GET", "/api/admin/me", { cookie: cookie3 })).status, 401);
});

test("changing the password stretches it into settings and ends every other session", async () => {
  const db = await createTestDb();
  const env = adminEnv(db);
  const cookie = await signIn(env);
  const other = await signIn(env, { ip: "198.51.100.9" });
  const next = "correct horse battery staple 42";

  const wrong = await callRoute(passwordRoute, env, "POST", "/api/admin/password", { cookie, body: { current: "nope", next } });
  assert.equal(wrong.status, 401);
  const short = await callRoute(passwordRoute, env, "POST", "/api/admin/password", { cookie, body: { current: PASSWORD, next: "short" } });
  assert.equal(short.status, 400);
  assert.equal((await readJson(short)).fields.next.includes("14"), true);
  const repetitive = await callRoute(passwordRoute, env, "POST", "/api/admin/password", {
    cookie,
    body: { current: PASSWORD, next: "aaaaaaaaaaaaaaaaaaaa" },
  });
  assert.equal(repetitive.status, 400);

  const ok = await callRoute(passwordRoute, env, "POST", "/api/admin/password", { cookie, body: { current: PASSWORD, next } });
  assert.equal(ok.status, 200);
  const fresh = `__Host-fbc_admin=${cookiesFrom(ok)["__Host-fbc_admin"].value}`;
  const stored = JSON.parse(db.get("SELECT value FROM settings WHERE key = 'admin_password_hash'").value);
  assert.match(stored, /^pbkdf2-sha256\$100000\$/);
  assert.equal(JSON.stringify(db.rows("SELECT data FROM audit_log")).includes(next), false, "never logged");

  assert.equal((await callRoute(meRoute, env, "GET", "/api/admin/me", { cookie })).status, 401, "old session ended");
  assert.equal((await callRoute(meRoute, env, "GET", "/api/admin/me", { cookie: other })).status, 401, "other device ended");
  assert.equal((await callRoute(meRoute, env, "GET", "/api/admin/me", { cookie: fresh })).status, 200);

  // The setup password no longer works; the new one does.
  const old = await callRoute(loginRoute, env, "POST", "/api/admin/login", { body: { password: PASSWORD }, ip: "198.51.100.20" });
  assert.equal(old.status, 401);
  assert.equal((await callRoute(loginRoute, env, "POST", "/api/admin/login", { body: { password: next }, ip: "198.51.100.21" })).status, 200);
});

test("the gate: Origin, JSON, host, DB and secrets", async () => {
  const db = await createTestDb();
  const env = adminEnv(db);
  const cookie = await signIn(env);

  const cross = await callRoute(coursesRoute, env, "POST", "/api/admin/courses", { cookie, body: { title: "x" }, origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  assert.equal((await readJson(cross)).error, "cross_origin");
  const noOrigin = await callRoute(coursesRoute, env, "POST", "/api/admin/courses", { cookie, body: { title: "x" }, origin: null });
  assert.equal(noOrigin.status, 403);

  const form = await callRoute(coursesRoute, env, "POST", "/api/admin/courses", {
    cookie,
    body: "title=x",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert.equal(form.status, 415);

  const courseHost = await callRoute(meRoute, env, "GET", "https://selfmakeup.feelingsbeautycare.in/api/admin/me", { cookie });
  assert.equal(courseHost.status, 404, "production admin answers on the hub only");
  const preview = await callRoute(meRoute, { ...env, APP_ENV: "preview" }, "GET", "https://abc.feelings-courses.pages.dev/api/admin/me", { cookie });
  assert.equal(preview.status, 200, "preview deployments use their own host");

  const noDb = await callRoute(meRoute, { APP_SECRET }, "GET", "/api/admin/me");
  assert.equal(noDb.status, 503);
  assert.equal((await readJson(noDb)).error, "platform_not_configured");

  const noSecrets = await callRoute(loginRoute, { DB: db, APP_ENV: "production" }, "POST", "/api/admin/login", {
    body: { password: PASSWORD },
    ip: "198.51.100.50",
  });
  assert.equal(noSecrets.status, 503);

  const badJson = await callRoute(loginRoute, env, "POST", "/api/admin/login", {
    body: "{nope",
    headers: { "Content-Type": "application/json" },
    ip: "198.51.100.51",
  });
  assert.equal(badJson.status, 400);
  const method = await callRoute(loginRoute, env, "GET", "/api/admin/login", { cookie });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "POST");
  assert.equal(method.headers.get("X-Robots-Tag"), "noindex, nofollow");
});
