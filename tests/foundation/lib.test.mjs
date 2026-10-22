// The shared Functions library: http, config, crypto, settings, tx, audit and the stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createTestDb } from "../helpers/d1.mjs";
import { postJson, req, readJson } from "../helpers/http.mjs";
import * as http from "../../functions/_lib/http.ts";
import { config, ConfigError, razorpayMode, requireSecret } from "../../functions/_lib/config.ts";
import * as crypto from "../../functions/_lib/crypto.ts";
import { bumpContentVersionStatement, getSetting, getSettings, setSetting, setSettingStatement } from "../../functions/_lib/db/settings.ts";
import { batch, changes, chunked, placeholders, whenExists } from "../../functions/_lib/db/tx.ts";
import { auditStatement, auditStatementWhen, listAuditLog } from "../../functions/_lib/db/audit.ts";
import { ConflictError, ValidationError, isUniqueViolation } from "../../functions/_lib/db/errors.ts";
import * as v from "../../functions/_lib/db/validate.ts";
import { NotImplementedError } from "../../functions/_lib/stub.ts";
import { fulfilOrder } from "../../functions/_lib/orders.ts";
import { quote } from "../../functions/_lib/pricing.ts";
import { createSession, issueLoginToken, readSession, requireEnrollment } from "../../functions/_lib/session.ts";
import { issueCertificate } from "../../functions/_lib/certificates.ts";
import { bump, statDay } from "../../functions/_lib/analytics.ts";
import { requestRebuild } from "../../functions/_lib/rebuild.ts";
import { maybeRunDaily } from "../../functions/_lib/daily.ts";
import { buildSnapshot } from "../../functions/_lib/snapshot.ts";
import { hostRouting } from "../../functions/_lib/hosts.ts";
import { COURSE_SLUG_RE, DEFAULT_ACCESS_DAYS, MAX_DEVICES_PER_STUDENT, REFUND_WINDOW_SECONDS, isValidCourseSlug } from "../../src/shared/constants.ts";
import { MAX_SESSIONS_PER_STUDENT } from "../../functions/_lib/config.ts";

// ---------- http ----------

test("http: json, error and methodNotAllowed keep the API shape", async () => {
  const ok = http.json({ a: 1 }, 201);
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await ok.json(), { a: 1 });
  const err = http.error(400, "invalid_details", "Check.", { fields: { phone: "Bad" } });
  assert.deepEqual(await err.json(), { error: "invalid_details", message: "Check.", fields: { phone: "Bad" } });
  const m = http.methodNotAllowed();
  assert.equal(m.headers.get("Allow"), "POST");
  assert.deepEqual(await m.json(), { error: "method_not_allowed", message: "Use POST." });
  assert.equal(http.methodNotAllowed(["GET", "PUT"]).headers.get("Allow"), "GET, PUT");
});

test("http: readJson caps size and refuses non-objects", async () => {
  assert.deepEqual(await http.readJson(postJson("/api/x", { a: 1 })), { ok: true, value: { a: 1 } });
  const array = await http.readJson(req("/api/x", { method: "POST", body: "[1]", headers: { "Content-Type": "application/json" } }));
  assert.equal(array.ok, false);
  assert.equal(array.response.status, 400);
  const big = await http.readJson(postJson("/api/x", { s: "x".repeat(20_000) }));
  assert.equal(big.ok, false);
  assert.equal(big.response.status, 413);
  const small = await http.readJson(postJson("/api/x", { s: "x".repeat(5000) }), 4096);
  assert.equal(small.response.status, 413);
});

test("http: sameOrigin, isJson, redirect with cookies and security headers", () => {
  assert.equal(http.sameOrigin(postJson("/api/x", {})), true);
  assert.equal(http.sameOrigin(postJson("/api/x", {}, { origin: "https://evil.example" })), false);
  assert.equal(http.sameOrigin(req("/api/x", { method: "POST", origin: null })), true);
  assert.equal(http.isJson(postJson("/api/x", {})), true);
  const r = http.redirect(req("/api/verify", { method: "POST" }), "/welcome?o=1", ["a=1; Path=/", "b=2; Path=/"]);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("Location"), "https://courses.feelingsbeautycare.in/welcome?o=1");
  assert.deepEqual(r.headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
  assert.equal(r.headers.get("X-Content-Type-Options"), "nosniff");
  const h = http.securityHeaders(new Headers(), { frameDeny: true });
  assert.equal(h.get("X-Frame-Options"), "DENY");
  assert.equal(http.clientIp(req("/", { ip: "203.0.113.9" })), "203.0.113.9");
});

test("http: errorResponse maps the library's errors", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    const v400 = http.errorResponse(new ValidationError("phone", "Enter a phone."));
    assert.equal(v400.status, 400);
    assert.deepEqual((await readJson(v400)).fields, { phone: "Enter a phone." });
    assert.equal(http.errorResponse(new ConflictError("slug_taken", "Taken")).status, 409);
    assert.equal(http.errorResponse(new ConfigError("APP_SECRET")).status, 503);
    assert.equal(http.errorResponse(new NotImplementedError("x", "W2")).status, 501);
    const s500 = http.errorResponse(new Error("secret detail"));
    assert.equal(s500.status, 500);
    assert.doesNotMatch(JSON.stringify(await s500.json()), /secret detail/);
  } finally {
    console.error = quiet;
  }
});

// ---------- config ----------

test("config: safe defaults, payment mode from the key prefix, secrets required", () => {
  const c = config({});
  assert.equal(c.appEnv, "production", "unknown env counts as production (dev features stay off)");
  assert.equal(c.hubHost, "courses.feelingsbeautycare.in");
  assert.equal(c.apexDomain, "feelingsbeautycare.in");
  assert.equal(c.paymentMode, null);
  assert.equal(config({ APP_ENV: "preview", HUB_HOST: "Hub.Example.test" }).hubHost, "hub.example.test");
  assert.equal(config({ HUB_HOST: "evil/path" }).hubHost, "courses.feelingsbeautycare.in");
  assert.equal(razorpayMode("rzp_test_Abc123"), "test");
  assert.equal(razorpayMode("rzp_live_Abc123"), "live");
  assert.equal(razorpayMode("rzp_other"), null);
  assert.throws(() => requireSecret({}, "APP_SECRET"), ConfigError);
  assert.throws(() => requireSecret({ APP_SECRET: "short" }, "APP_SECRET"), ConfigError);
  assert.equal(requireSecret({ APP_SECRET: " a-long-enough-secret-value " }, "APP_SECRET"), "a-long-enough-secret-value");
});

test("constants: course slugs follow the CHECK and the reserved list", () => {
  for (const ok of ["selfmakeup", "ab", "soft-glam", "x".repeat(40)]) assert.ok(isValidCourseSlug(ok), ok);
  for (const bad of ["a", "-x", "x-", "a--b", "Up", "x".repeat(41), "www", "courses", "admin"]) assert.ok(!isValidCourseSlug(bad), bad);
  assert.ok(COURSE_SLUG_RE.test("www"), "reserved names are format-valid, refused by the list");
});

test("owner decisions (plan section 10) are the configured values", () => {
  assert.equal(REFUND_WINDOW_SECONDS, 24 * 3600);
  assert.equal(DEFAULT_ACCESS_DAYS, 365);
  assert.equal(MAX_DEVICES_PER_STUDENT, 2);
  assert.equal(MAX_SESSIONS_PER_STUDENT, 2);
});

// ---------- crypto ----------

test("crypto: hashes and HMAC match Node's, tokens have the right shape", async () => {
  assert.equal(await crypto.sha256Hex("abc"), createHash("sha256").update("abc").digest("hex"));
  assert.equal(await crypto.hmacSha256Hex("k", "m"), createHmac("sha256", "k").update("m").digest("hex"));
  assert.equal(crypto.timingSafeEqual("abc", "abc"), true);
  assert.equal(crypto.timingSafeEqual("abc", "abd"), false);
  assert.equal(crypto.timingSafeEqual("abc", "abcd"), false);
  assert.match(crypto.randomToken(), /^[A-Za-z0-9_-]{43}$/);
  assert.match(crypto.randomHex(16), /^[0-9a-f]{32}$/);
  assert.match(crypto.randomDigits(6), /^\d{6}$/);
  assert.match(crypto.randomCrockford(10), /^[0-9A-HJKMNP-TV-Z]{10}$/);
});

// ---------- settings, tx, audit ----------

test("settings: typed get, set, batch upsert and content version bump", async () => {
  const db = await createTestDb();
  assert.equal(await getSetting(db, "last_backup_at"), null);
  await setSetting(db, "last_backup_at", 123);
  assert.equal(await getSetting(db, "last_backup_at"), 123);
  await batch(db, [setSettingStatement(db, "legal_confirmed", true), bumpContentVersionStatement(db)]);
  const many = await getSettings(db, ["legal_confirmed", "content_version", "published_version"]);
  assert.deepEqual(many, { legal_confirmed: true, content_version: 2 });
});

test("tx: batch skips empty slots, rolls back on error; helpers", async () => {
  const db = await createTestDb({ only: ["0001_init.sql"] });
  const ins = (k) => db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, '1', 1)").bind(k);
  const results = await batch(db, [ins("a"), false, null, ins("b")]);
  assert.equal(results.length, 2);
  assert.equal(changes(results[0]), 1);
  await assert.rejects(batch(db, [ins("c"), ins("a")]), (e) => isUniqueViolation(e, "settings.key"));
  assert.equal(db.get("SELECT count(*) AS n FROM settings WHERE key = 'c'").n, 0, "the whole batch rolled back");
  assert.deepEqual(await batch(db, []), []);
  assert.equal(placeholders(3), "?, ?, ?");
  assert.throws(() => placeholders(0));
  assert.deepEqual(chunked([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(whenExists("orders", "id = ?", [1]), { sql: "EXISTS (SELECT 1 FROM orders WHERE id = ?)", params: [1] });
  assert.throws(() => whenExists("orders; DROP", "1", []));
});

test("audit: statements go in batches; conditional entries only when the condition holds", async () => {
  const db = await createTestDb({ only: ["0001_init.sql"] });
  await batch(db, [
    auditStatement(db, { actor: "admin", action: "course.publish", entity: "course", entityId: 1, data: { a: 1 }, now: 10 }),
    auditStatementWhen(db, { action: "order.paid", entity: "order", entityId: 9, now: 11 }, whenExists("settings", "key = ?", ["nope"])),
  ]);
  const log = await listAuditLog(db);
  assert.equal(log.length, 1);
  assert.deepEqual(log[0], { id: 1, actor: "admin", action: "course.publish", entity: "course", entityId: "1", data: { a: 1 }, createdAt: 10 });
  assert.throws(() => auditStatement(db, { action: "Bad Action", entity: "course" }), ValidationError);
});

test("validate: phone, email, coupon and slug normalisation", () => {
  assert.equal(v.phone("98765 43210"), "+919876543210");
  assert.equal(v.email(" Asha@Example.COM "), "asha@example.com");
  assert.equal(v.couponCode(" diwali20 "), "DIWALI20");
  assert.equal(v.slug("Soft-Glam"), "soft-glam");
  assert.throws(() => v.paise(10.5, "amount"), ValidationError);
});

// ---------- stubs ----------

test("stubs: frozen signatures that throw NotImplementedError until their workstream lands", async () => {
  const env = {};
  const pending = [
    () => fulfilOrder(env, { orderId: 1, payment: { id: "pay_x", amount: 100, currency: "INR", status: "captured", order_id: null } }),
    () => quote({}, { courseSlug: "x", now: 0 }),
    () => createSession({}, 1, req("/")),
    () => readSession(env, req("/")),
    () => issueLoginToken({}, 1, "handoff", "/learn"),
    () => requireEnrollment(env, req("/"), "x"),
    () => issueCertificate(env, { studentId: 1, courseId: 1, name: "A" }),
    () => requestRebuild(env, { waitUntil() {} }),
    () => maybeRunDaily(env, { waitUntil() {} }),
    () => buildSnapshot(env),
  ];
  for (const fn of pending) await assert.rejects(fn(), NotImplementedError);
  // signMediaUrl and playLesson (W4) are real now: tests/w4/.
  assert.throws(() => bump({}, "2026-10-23", 1, "views"), NotImplementedError);
  // statDay is real: India time.
  assert.equal(statDay(Date.UTC(2026, 9, 22, 19, 0, 0) / 1000), "2026-10-23");
  // hostRouting is a pass-through until W1.
  const res = await hostRouting({ request: req("/"), env: {}, data: {}, next: async () => new Response("x") }, async () => new Response("passed"));
  assert.equal(await res.text(), "passed");
});
