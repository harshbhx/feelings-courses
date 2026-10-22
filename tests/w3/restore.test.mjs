// W3 restore on a new device (functions/_lib/restore.ts) and POST /api/auth/restore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { contactMatches, normalizeContact, normalizePaymentId, restoreAccess } from "../../functions/_lib/restore.ts";
import { handleRestore } from "../../functions/_lib/student-api.ts";
import { readSession } from "../../functions/_lib/session.ts";
import { SESSION_COOKIE } from "../../functions/_lib/config.ts";
import { cookiesFrom, postJson, readJson, req } from "../helpers/http.mjs";
import { fakeRazorpay, paymentEntity } from "../helpers/razorpay.mjs";
import { ASHA, BINA, DAY, env, ERASED, NOW, setupDb, TEST_KEYS } from "./fixtures.mjs";

let ipCounter = 0;
/** A request from a fresh IP, so the per-IP limit doesn't interfere unless a test wants it to. */
const from = (ip = `203.0.113.${++ipCounter % 250}`) => req("/api/auth/restore", { method: "POST", ip });

test("normalizeContact: phones to E.164, emails lowercased; junk refused", () => {
  assert.equal(normalizeContact("98765 43210"), "+919876543210");
  assert.equal(normalizeContact("+91 98765-43210"), "+919876543210");
  assert.equal(normalizeContact("09876543210"), "+919876543210");
  assert.equal(normalizeContact(" Asha@Example.COM "), "asha@example.com");
  for (const bad of ["", "12345", "not an email@", null, 42]) assert.throws(() => normalizeContact(bad), /contact|phone|email/i);
});

test("normalizePaymentId: only pay_ ids", () => {
  assert.equal(normalizePaymentId(" pay_AshaPayment0001 "), "pay_AshaPayment0001");
  for (const bad of ["order_AshaOrder00001", "pay_", "pay_short", "pay_has space1", "pay_" + "a".repeat(41), null]) {
    assert.throws(() => normalizePaymentId(bad), /payment ID/);
  }
});

test("contactMatches compares every slot and matches any one of them", async () => {
  assert.equal(await contactMatches("+919876543210", ["+919876543210", null, null, null]), true);
  assert.equal(await contactMatches("+919876543210", [null, null, "9876543210", null]), true, "payer contact typed without +91");
  assert.equal(await contactMatches("asha@example.com", [null, "ASHA@example.com", null, null]), true);
  assert.equal(await contactMatches("+919876543210", ["+919876543211", "a@b.co", null, null]), false);
  assert.equal(await contactMatches("+919876543210", []), false);
});

test("restore succeeds with the phone, the account email or what was typed into Razorpay", async () => {
  const db = await setupDb();
  for (const contact of ["9876543210", "asha@example.com", "asha.pay@example.com", "+91 98765 43210"]) {
    const result = await restoreAccess(env(db), from(), { contact, paymentId: ASHA.payment }, NOW);
    assert.deepEqual(result, { ok: true, studentId: ASHA.id, orderId: 1, via: "order" }, contact);
  }
});

test("restore: every failure is the same 'no_match' (no enumeration)", async () => {
  const db = await setupDb();
  const cases = [
    { contact: "9812345678", paymentId: ASHA.payment, why: "another student's phone" },
    { contact: "9876543210", paymentId: "pay_DoesNotExist0001", why: "unknown payment, no Razorpay keys" },
    { contact: BINA.phone, paymentId: BINA.payment, why: "refunded order" },
    { contact: "+919811111111", paymentId: ERASED.payment, why: "erased student" },
    { contact: "someone@example.com", paymentId: ASHA.payment, why: "wrong email" },
  ];
  for (const c of cases) {
    const result = await restoreAccess(env(db), from(), c, NOW);
    assert.deepEqual(result, { ok: false, reason: "no_match" }, c.why);
  }
  assert.equal(db.get("SELECT count(*) AS n FROM sessions").n, 0);
});

test("restore rate limits: 5 tries per IP per 15 minutes, counted before the lookup", async () => {
  const db = await setupDb();
  const ip = "198.51.100.7";
  for (let i = 0; i < 5; i++) {
    const r = await restoreAccess(env(db), from(ip), { contact: "9876543210", paymentId: "pay_WrongPayment0001" }, NOW);
    assert.equal(r.reason, "no_match");
  }
  const blocked = await restoreAccess(env(db), from(ip), { contact: "9876543210", paymentId: ASHA.payment }, NOW);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "rate_limited", "even the right details are refused while limited");
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 900);
  // Malformed attempts count too.
  await assert.rejects(restoreAccess(env(db), from("198.51.100.8"), { contact: "x", paymentId: "y" }, NOW));
  // (The phone has used up its own daily tries above, so the email is used here.)
  const ok = await restoreAccess(env(db), from(ip), { contact: "asha@example.com", paymentId: ASHA.payment }, NOW + 16 * 60);
  assert.equal(ok.ok, true, "the same IP works again in the next window");
});

test("restore rate limits per contact and per payment ID, across IPs (5 a day)", async () => {
  const db = await setupDb();
  for (let i = 0; i < 5; i++) {
    await restoreAccess(env(db), from(), { contact: "9876543210", paymentId: `pay_Guess${String(i).padStart(10, "0")}` }, NOW);
  }
  const contactBlocked = await restoreAccess(env(db), from(), { contact: "9876543210", paymentId: ASHA.payment }, NOW);
  assert.equal(contactBlocked.reason, "rate_limited", "per contact");

  for (let i = 0; i < 5; i++) {
    await restoreAccess(env(db), from(), { contact: `98000000${String(10 + i)}`, paymentId: ASHA.payment }, NOW + DAY);
  }
  const paymentBlocked = await restoreAccess(env(db), from(), { contact: "asha@example.com", paymentId: ASHA.payment }, NOW + DAY);
  assert.equal(paymentBlocked.reason, "rate_limited", "per payment ID");

  const buckets = db.rows("SELECT bucket FROM rate_limits").map((r) => r.bucket).join(" ");
  assert.equal(buckets.includes("9876543210"), false, "no phone number in rate_limits");
  assert.equal(buckets.includes(ASHA.payment), false, "no payment id in rate_limits");
});

test("restore fallback: a captured payment D1 hasn't recorded is checked against Razorpay", async (t) => {
  const db = await setupDb();
  // Order 4 (student 2, ₹1,000) is still 'created': the browser closed before verify.
  const payment = paymentEntity({ id: "pay_LateWebhook00001", order_id: "order_UnpaidOrder001", amount: 100000, contact: BINA.phone, email: "" });
  const { calls } = fakeRazorpay(t, { "GET /v1/payments/pay_LateWebhook00001": payment });
  const result = await restoreAccess(env(db, TEST_KEYS), from(), { contact: BINA.phone, paymentId: "pay_LateWebhook00001" }, NOW);
  assert.equal(calls.length, 1, "Razorpay was asked");
  assert.equal(calls[0].auth.keyId, TEST_KEYS.RAZORPAY_KEY_ID);
  // fulfilOrder belongs to W2; until it is merged it throws NotImplementedError, which is a quiet no_match.
  assert.deepEqual(result, { ok: false, reason: "no_match" });
});

test("restore fallback refuses: not captured, wrong amount, wrong contact, other mode, unknown order", async (t) => {
  const db = await setupDb();
  const base = { id: "pay_LateWebhook00002", order_id: "order_UnpaidOrder001", amount: 100000, contact: BINA.phone };
  const variants = {
    pay_NotCaptured00001: { ...base, id: "pay_NotCaptured00001", status: "authorized" },
    pay_WrongAmount00001: { ...base, id: "pay_WrongAmount00001", amount: 100 },
    pay_WrongOrder000001: { ...base, id: "pay_WrongOrder000001", order_id: "order_Nope000000001" },
    pay_RightOne00000001: { ...base, id: "pay_RightOne00000001" },
  };
  const routes = Object.fromEntries(Object.entries(variants).map(([id, p]) => [`GET /v1/payments/${id}`, paymentEntity(p)]));
  routes["GET /v1/payments/pay_Missing000000001"] = () => ({ status: 400, body: { error: { description: "The id provided does not exist" } } });
  fakeRazorpay(t, routes);
  for (const id of ["pay_NotCaptured00001", "pay_WrongAmount00001", "pay_WrongOrder000001", "pay_Missing000000001"]) {
    const r = await restoreAccess(env(db, TEST_KEYS), from(), { contact: BINA.phone, paymentId: id }, NOW);
    assert.deepEqual(r, { ok: false, reason: "no_match" }, id);
  }
  const wrongContact = await restoreAccess(env(db, TEST_KEYS), from(), { contact: "9800000099", paymentId: "pay_RightOne00000001" }, NOW);
  assert.deepEqual(wrongContact, { ok: false, reason: "no_match" });
  const live = await restoreAccess(
    env(db, { ...TEST_KEYS, RAZORPAY_KEY_ID: "rzp_live_FakeKeyId00001" }),
    from(),
    { contact: BINA.phone, paymentId: "pay_RightOne00000001" },
    NOW,
  );
  assert.deepEqual(live, { ok: false, reason: "no_match" }, "a test-mode order can't be restored with live keys");
  assert.equal(db.get("SELECT status FROM orders WHERE id = 4").status, "created", "nothing was fulfilled");
});

test("POST /api/auth/restore: session cookie and redirect on success", async () => {
  const db = await setupDb();
  const res = await handleRestore(
    postJson("/api/auth/restore", { contact: "9876543210", paymentId: ASHA.payment, next: "/learn/selfmakeup" }, { ip: "192.0.2.1" }),
    env(db),
    NOW,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await readJson(res), { ok: true, redirect: "/learn/selfmakeup" });
  const cookie = cookiesFrom(res)[SESSION_COOKIE];
  assert.ok(cookie?.value);
  const session = await readSession(env(db), req("/", { cookie: `${SESSION_COOKIE}=${cookie.value}` }), NOW);
  assert.equal(session.studentId, ASHA.id);
  const audit = db.get("SELECT * FROM audit_log WHERE action = 'student.restore'");
  assert.equal(audit.actor, "student:1");
  assert.equal(audit.data.includes("9876543210"), false, "no contact detail in the audit log");
});

test("POST /api/auth/restore: same message for every mismatch, 429 with Retry-After, open redirects refused", async () => {
  const db = await setupDb();
  const a = await handleRestore(postJson("/api/auth/restore", { contact: "9812345678", paymentId: ASHA.payment }, { ip: "192.0.2.2" }), env(db), NOW);
  const b = await handleRestore(postJson("/api/auth/restore", { contact: "9876543210", paymentId: "pay_Unknown00000001" }, { ip: "192.0.2.3" }), env(db), NOW);
  assert.equal(a.status, 400);
  assert.equal(b.status, 400);
  assert.deepEqual(await readJson(a), await readJson(b));
  assert.equal(cookiesFrom(a)[SESSION_COOKIE], undefined);

  const ip = "192.0.2.4";
  let last;
  for (let i = 0; i < 6; i++) {
    last = await handleRestore(postJson("/api/auth/restore", { contact: "9876543210", paymentId: "pay_Unknown00000001" }, { ip }), env(db), NOW);
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("Retry-After")) > 0);

  const evil = await handleRestore(
    postJson("/api/auth/restore", { contact: "asha@example.com", paymentId: ASHA.payment, next: "//evil.example/x" }, { ip: "192.0.2.5" }),
    env(db),
    NOW,
  );
  assert.equal((await readJson(evil)).redirect, "/account");
});

test("POST /api/auth/restore: CSRF and input checks", async () => {
  const db = await setupDb();
  const body = { contact: "9876543210", paymentId: ASHA.payment };
  const cross = await handleRestore(postJson("/api/auth/restore", body, { origin: "https://evil.example" }), env(db), NOW);
  assert.equal(cross.status, 403);
  const form = await handleRestore(
    req("/api/auth/restore", { method: "POST", body: "contact=1", headers: { "Content-Type": "application/x-www-form-urlencoded" } }),
    env(db),
    NOW,
  );
  assert.equal(form.status, 415);
  const get = await handleRestore(req("/api/auth/restore"), env(db), NOW);
  assert.equal(get.status, 405);
  const bad = await handleRestore(postJson("/api/auth/restore", { contact: "9876543210", paymentId: "order_x" }, { ip: "192.0.2.6" }), env(db), NOW);
  assert.equal(bad.status, 400);
  assert.equal((await readJson(bad)).error, "invalid_details");
  const noDb = await handleRestore(postJson("/api/auth/restore", body), {}, NOW);
  assert.equal(noDb.status, 503);
});
