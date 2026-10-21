// Checkout and enrollment tests. Node 22, no dependencies:
//
//   npm run test:checkout
//   (= node --experimental-strip-types --no-warnings scripts/test-checkout.mjs)
//
// Imports the real Pages Functions (functions/api/*.ts) and their library (functions/_lib/*.ts);
// Node strips the TypeScript types. Razorpay's API is never called: globalThis.fetch is replaced by
// a fake that records each request. The keys below are made up and only shaped like Razorpay's.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { onRequest as orderFn } from "../functions/api/order.ts";
import { onRequest as verifyFn } from "../functions/api/verify.ts";
import { handleOrder, handleVerify, parseBuyer, paymentMode } from "../functions/_lib/checkout.ts";
import { verifyRazorpaySignature } from "../functions/_lib/razorpay.ts";
import { timingSafeEqual } from "../functions/_lib/crypto.ts";
import {
  DEMO_ENROLL_KEY,
  ENROLL_COOKIE,
  accessDays,
  issueEnrollment,
  newEnrollment,
  verifyEnrollment,
} from "../functions/_lib/enrollment.ts";
import { course } from "../src/data/course.ts";
import { RAZORPAY_TEST_KEY_ID } from "../src/data/payments.ts";

const SITE = "https://courses.example.test";
const TEST_KEYS = { RAZORPAY_KEY_ID: "rzp_test_FakeKeyId0001", RAZORPAY_KEY_SECRET: "fake_test_secret_not_real" };
const LIVE_KEYS = { RAZORPAY_KEY_ID: "rzp_live_FakeKeyId0001", RAZORPAY_KEY_SECRET: "fake_live_secret_not_real" };
const ENROLL = { ENROLL_SECRET: "fake-enroll-secret-for-tests" };
// The built-in demo sheet: no Key Secret and no committed test Key ID either.
const NO_TEST_KEY = { testKeyId: "" };
const INSTAGRAM_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 345.0.0.0.0";
// Shaped like the id Razorpay Checkout hands its handler: "pay_" and 14 letters or digits.
const TEST_PAYMENT_ID = "pay_FakeTestPay001";

// ---------- helpers ----------

const post = (path, body, headers = {}) =>
  new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: SITE, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const postForm = (path, fields) =>
  new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://api.razorpay.com" },
    body: new URLSearchParams(fields).toString(),
  });

const withCookie = (setCookie) =>
  new Request(`${SITE}/learn`, { headers: { Cookie: `other=1; ${setCookie.split(";")[0]}; theme=x` } });

const rzpSignature = (orderId, paymentId, secret) =>
  createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

const realFetch = globalThis.fetch;

/**
 * Replaces fetch for one test. `routes` maps "METHOD /v1/path" to a JSON body (answered with 200),
 * an Error (thrown, like a network failure) or a function returning { status, body }.
 */
function fakeRazorpay(t, routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    calls.push({ key, url: u.href, init, body: init.body ? JSON.parse(init.body) : undefined });
    const route = routes[key];
    if (route === undefined) throw new Error(`unexpected fetch ${key}`);
    if (route instanceof Error) throw route;
    const { status = 200, body } = typeof route === "function" ? route(calls.at(-1)) : { body: route };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return calls;
}

const noFetch = (t) => fakeRazorpay(t, {});

const payment = (overrides = {}) => ({
  id: "pay_FakePayment001",
  entity: "payment",
  order_id: "order_FakeOrder0001",
  amount: course.price.amount,
  currency: course.price.currency,
  status: "captured",
  ...overrides,
});

const signedIds = (secret = TEST_KEYS.RAZORPAY_KEY_SECRET, orderId = "order_FakeOrder0001", paymentId = "pay_FakePayment001") => ({
  razorpay_order_id: orderId,
  razorpay_payment_id: paymentId,
  razorpay_signature: rzpSignature(orderId, paymentId, secret),
});

const assertNoSecrets = (text) => {
  for (const secret of [TEST_KEYS.RAZORPAY_KEY_SECRET, LIVE_KEYS.RAZORPAY_KEY_SECRET, ENROLL.ENROLL_SECRET, DEMO_ENROLL_KEY]) {
    assert.ok(!text.includes(secret), "a secret leaked into a response");
  }
};

// ---------- Razorpay signature ----------

test("signature: a good signature verifies", async () => {
  const sig = rzpSignature("order_ABC123", "pay_XYZ789", "s3cret");
  assert.equal(await verifyRazorpaySignature("order_ABC123", "pay_XYZ789", sig, "s3cret"), true);
  assert.equal(await verifyRazorpaySignature("order_ABC123", "pay_XYZ789", sig.toUpperCase(), "s3cret"), true);
});

test("signature: a signature made with another secret fails", async () => {
  const sig = rzpSignature("order_ABC123", "pay_XYZ789", "someone-else");
  assert.equal(await verifyRazorpaySignature("order_ABC123", "pay_XYZ789", sig, "s3cret"), false);
});

test("signature: tampered order id, payment id or signature fails", async () => {
  const sig = rzpSignature("order_ABC123", "pay_XYZ789", "s3cret");
  assert.equal(await verifyRazorpaySignature("order_ABC124", "pay_XYZ789", sig, "s3cret"), false);
  assert.equal(await verifyRazorpaySignature("order_ABC123", "pay_XYZ780", sig, "s3cret"), false);
  const flipped = sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0");
  assert.equal(await verifyRazorpaySignature("order_ABC123", "pay_XYZ789", flipped, "s3cret"), false);
  // Swapping the two ids around the "|" is a different message.
  assert.equal(await verifyRazorpaySignature("pay_XYZ789", "order_ABC123", sig, "s3cret"), false);
});

test("signature: malformed or empty input fails", async () => {
  assert.equal(await verifyRazorpaySignature("order_A", "pay_B", "not-hex", "s3cret"), false);
  assert.equal(await verifyRazorpaySignature("order_A", "pay_B", "", "s3cret"), false);
  assert.equal(await verifyRazorpaySignature("", "pay_B", "a".repeat(64), "s3cret"), false);
  assert.equal(await verifyRazorpaySignature("order_A", "pay_B", rzpSignature("order_A", "pay_B", ""), ""), false);
});

test("timingSafeEqual compares whole strings", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

// ---------- enrollment cookie ----------

test("enrollment: access period comes from course.access", () => {
  assert.equal(accessDays("12 months"), 365);
  assert.equal(accessDays("6 months"), 183);
  assert.equal(accessDays("90 days"), 90);
  assert.equal(accessDays("1 year"), 365);
  assert.equal(accessDays("lifetime"), 365);
  const e = newEnrollment("pay_X", 1_700_000_000_000);
  assert.equal(e.courseSlug, course.slug);
  assert.equal(e.expires, 1_700_000_000 + accessDays(course.access) * 86400);
});

test("enrollment: roundtrip with the right cookie flags", async () => {
  const enrollment = newEnrollment("pay_FakePayment001");
  const setCookie = await issueEnrollment(ENROLL, enrollment);
  assert.match(setCookie, new RegExp(`^${ENROLL_COOKIE}=${course.slug}\\.\\d+\\.pay_FakePayment001\\.[0-9a-f]{64};`));
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(setCookie.includes(`; ${flag}`), flag);
  const maxAge = Number(/Max-Age=(\d+)/.exec(setCookie)[1]);
  assert.ok(Math.abs(maxAge - accessDays() * 86400) <= 2, `Max-Age ${maxAge}`);
  assert.deepEqual(await verifyEnrollment(ENROLL, withCookie(setCookie)), enrollment);
});

test("enrollment: works with the demo key while ENROLL_SECRET is unset (demo)", async () => {
  assert.equal(course.demo, true, "these tests expect the demo course");
  const setCookie = await issueEnrollment({}, newEnrollment("demo_0123456789abcdef01234567"));
  assert.ok(await verifyEnrollment({}, withCookie(setCookie)));
  // …but a demo-key cookie is worthless once a real ENROLL_SECRET is set.
  assert.equal(await verifyEnrollment(ENROLL, withCookie(setCookie)), null);
});

test("enrollment: an expired cookie is refused", async () => {
  const past = { courseSlug: course.slug, expires: Math.floor(Date.now() / 1000) - 1, paymentRef: "pay_Old" };
  const setCookie = await issueEnrollment(ENROLL, past);
  assert.match(setCookie, /Max-Age=0;/);
  assert.equal(await verifyEnrollment(ENROLL, withCookie(setCookie)), null);
});

test("enrollment: forged cookies are refused", async () => {
  const setCookie = await issueEnrollment(ENROLL, newEnrollment("pay_FakePayment001"));
  const value = setCookie.split(";")[0].slice(ENROLL_COOKIE.length + 1);
  const [slug, expires, ref, mac] = value.split(".");
  const forge = (v) => new Request(`${SITE}/learn`, { headers: { Cookie: `${ENROLL_COOKIE}=${v}` } });

  // Longer access, another payment, another course, all with the original MAC.
  assert.equal(await verifyEnrollment(ENROLL, forge(`${slug}.${Number(expires) + 86400 * 365}.${ref}.${mac}`)), null);
  assert.equal(await verifyEnrollment(ENROLL, forge(`${slug}.${expires}.pay_SomeoneElse.${mac}`)), null);
  assert.equal(await verifyEnrollment(ENROLL, forge(`other-course.${expires}.${ref}.${mac}`)), null);
  // A MAC made with another key, a flipped MAC, junk and a missing cookie.
  const otherMac = createHmac("sha256", "guessed-secret").update(`${slug}.${expires}.${ref}`).digest("hex");
  assert.equal(await verifyEnrollment(ENROLL, forge(`${slug}.${expires}.${ref}.${otherMac}`)), null);
  const flipped = mac.slice(0, -1) + (mac.endsWith("0") ? "1" : "0");
  assert.equal(await verifyEnrollment(ENROLL, forge(`${slug}.${expires}.${ref}.${flipped}`)), null);
  assert.equal(await verifyEnrollment(ENROLL, forge("garbage")), null);
  assert.equal(await verifyEnrollment(ENROLL, forge(`${value}.extra`)), null);
  assert.equal(await verifyEnrollment(ENROLL, new Request(`${SITE}/learn`)), null);
  // The genuine cookie still passes.
  assert.ok(await verifyEnrollment(ENROLL, forge(value)));
});

test("enrollment: payment refs that could break the cookie format are refused", async () => {
  await assert.rejects(issueEnrollment(ENROLL, { courseSlug: course.slug, expires: 2e9, paymentRef: "pay.X" }));
  await assert.rejects(issueEnrollment(ENROLL, { courseSlug: course.slug, expires: 2e9, paymentRef: "pay;X" }));
});

// ---------- modes ----------

test("mode: no keys + demo course → the demo sheet (committed key switched off), or razorpay-test when passed one; live course → off", () => {
  assert.deepEqual(paymentMode({}, true), { kind: "demo" });
  assert.deepEqual(paymentMode({}, true, RAZORPAY_TEST_KEY_ID), { kind: "razorpay-test", keyId: RAZORPAY_TEST_KEY_ID });
  assert.equal(paymentMode({}, true, "").kind, "demo");
  assert.equal(paymentMode({}, false).kind, "off");
  assert.equal(paymentMode({}, false, "").kind, "off");
});

test("mode: half-set or odd keys turn payments off (a test Key ID alone on the demo is razorpay-test)", () => {
  assert.deepEqual(paymentMode({ RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID }, true), {
    kind: "razorpay-test",
    keyId: TEST_KEYS.RAZORPAY_KEY_ID,
  });
  assert.equal(paymentMode({ RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID }, false).kind, "off");
  assert.equal(paymentMode({ RAZORPAY_KEY_SECRET: "x" }, true).kind, "off");
  assert.equal(paymentMode({ RAZORPAY_KEY_ID: "pk_test_123", RAZORPAY_KEY_SECRET: "x" }, true).kind, "off");
  assert.equal(paymentMode({ RAZORPAY_KEY_ID: "pk_test_123" }, true).kind, "off");
});

test("order: live keys are refused while the course is a demo", async (t) => {
  const calls = noFetch(t);
  const res = await orderFn({ request: post("/api/order", { name: "Asha Patel", phone: "9876543210" }), env: LIVE_KEYS });
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.equal(JSON.parse(text).error, "live_keys_in_demo");
  assert.match(JSON.parse(text).message, /demo/i);
  assertNoSecrets(text);
  assert.equal(calls.length, 0, "Razorpay must not be called with live keys in a demo");
});

test("order: test keys are refused on the live course, and live needs ENROLL_SECRET", async (t) => {
  noFetch(t);
  const testOnLive = await handleOrder(post("/api/order", {}), TEST_KEYS, { demo: false });
  assert.equal(testOnLive.status, 503);
  assert.equal((await testOnLive.json()).error, "test_keys_on_live");
  const noSecret = await handleOrder(post("/api/order", {}), LIVE_KEYS, { demo: false });
  assert.equal(noSecret.status, 503);
  assert.equal((await noSecret.json()).error, "enroll_secret_missing");
  assert.equal(paymentMode({ ...LIVE_KEYS, ...ENROLL }, false).kind, "razorpay");
});

test("verify: demo payments are refused when Razorpay keys exist", async (t) => {
  const calls = noFetch(t);
  const res = await verifyFn({ request: post("/api/verify", { demo_order_id: "demo_0123456789abcdef01234567" }), env: TEST_KEYS });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "demo_disabled");
  assert.equal(res.headers.get("Set-Cookie"), null);
  assert.equal(calls.length, 0);
});

test("verify: demo payments are refused on the live course", async () => {
  const res = await handleVerify(post("/api/verify", { demo_order_id: "demo_0123456789abcdef01234567" }), {}, { demo: false });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Set-Cookie"), null);
});

// ---------- amount ----------

test("order (demo): the amount comes from course.ts, whatever the browser sends", async () => {
  const res = await handleOrder(
    post("/api/order", { name: "Asha", phone: "9876543210", amount: 100, currency: "USD", price: { amount: 1 } }),
    {},
    NO_TEST_KEY,
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.mode, "demo");
  assert.equal(data.amount, course.price.amount);
  assert.equal(data.currency, course.price.currency);
  assert.match(data.orderId, /^demo_[0-9a-f]{24}$/);
});

test("order (Razorpay): the order is created for the course.ts amount, with Basic auth and no secret in the reply", async (t) => {
  const calls = fakeRazorpay(t, {
    "POST /v1/orders": ({ body }) => ({ body: { id: "order_FakeOrder0001", entity: "order", status: "created", ...body } }),
  });
  const res = await orderFn({
    request: post("/api/order", { name: "  Asha   Patel ", phone: "+91 98765-43210", email: "asha@example.com", amount: 1, currency: "USD" }),
    env: TEST_KEYS,
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assertNoSecrets(text);
  const data = JSON.parse(text);

  assert.equal(calls.length, 1);
  const sent = calls[0];
  assert.equal(sent.url, "https://api.razorpay.com/v1/orders");
  assert.equal(sent.body.amount, course.price.amount);
  assert.equal(sent.body.currency, course.price.currency);
  assert.equal(sent.body.notes.course, course.slug);
  assert.ok(sent.body.receipt.length <= 40);
  assert.equal(JSON.stringify(sent.body.notes).includes("Asha"), false, "no buyer details in the order notes");
  const auth = `Basic ${Buffer.from(`${TEST_KEYS.RAZORPAY_KEY_ID}:${TEST_KEYS.RAZORPAY_KEY_SECRET}`).toString("base64")}`;
  assert.equal(sent.init.headers.Authorization, auth);

  assert.deepEqual(
    { mode: data.mode, keyId: data.keyId, orderId: data.orderId, amount: data.amount, currency: data.currency },
    { mode: "razorpay", keyId: TEST_KEYS.RAZORPAY_KEY_ID, orderId: "order_FakeOrder0001", amount: course.price.amount, currency: "INR" },
  );
  assert.equal(data.description, course.title);
  assert.deepEqual(data.prefill, { name: "Asha Patel", contact: "+919876543210", email: "asha@example.com" });
});

test("order (Razorpay): Razorpay down → 502 with a calm message", async (t) => {
  fakeRazorpay(t, { "POST /v1/orders": () => ({ status: 401, body: { error: { description: "Authentication failed" } } }) });
  const res = await orderFn({ request: post("/api/order", {}), env: TEST_KEYS });
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.equal(JSON.parse(text).error, "razorpay_unavailable");
  assertNoSecrets(text);
});

// ---------- verify (Razorpay) ----------

test("verify (Razorpay): good signature + captured payment → cookie and redirect", async (t) => {
  const calls = fakeRazorpay(t, { "GET /v1/payments/pay_FakePayment001": payment() });
  const res = await verifyFn({ request: post("/api/verify", signedIds()), env: { ...TEST_KEYS, ...ENROLL } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, redirect: "/thank-you" });
  assert.equal(calls.length, 1);
  const setCookie = res.headers.get("Set-Cookie");
  const enrollment = await verifyEnrollment(ENROLL, withCookie(setCookie));
  assert.equal(enrollment.paymentRef, "pay_FakePayment001");
});

test("verify (Razorpay): an authorized (not yet captured) payment also counts", async (t) => {
  fakeRazorpay(t, { "GET /v1/payments/pay_FakePayment001": payment({ status: "authorized" }) });
  const res = await verifyFn({ request: post("/api/verify", signedIds()), env: TEST_KEYS });
  assert.equal(res.status, 200);
});

test("verify (Razorpay): a bad or tampered signature is refused before Razorpay is asked", async (t) => {
  const calls = noFetch(t);
  const forged = signedIds("guessed-secret");
  const res = await verifyFn({ request: post("/api/verify", forged), env: TEST_KEYS });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "signature_invalid");
  assert.equal(res.headers.get("Set-Cookie"), null);

  const tampered = { ...signedIds(), razorpay_payment_id: "pay_SomeoneElse01" };
  const res2 = await verifyFn({ request: post("/api/verify", tampered), env: TEST_KEYS });
  assert.equal(res2.status, 400);
  assert.equal(calls.length, 0);
});

test("verify (Razorpay): wrong amount, failed status or another order is refused", async (t) => {
  for (const bad of [{ amount: 100 }, { status: "failed" }, { order_id: "order_Other000001" }, { currency: "USD" }]) {
    const calls = fakeRazorpay(t, { "GET /v1/payments/pay_FakePayment001": payment(bad) });
    const res = await verifyFn({ request: post("/api/verify", signedIds()), env: TEST_KEYS });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).error, "payment_not_confirmed");
    assert.equal(res.headers.get("Set-Cookie"), null);
    assert.equal(calls.length, 1);
  }
});

test("verify (Razorpay): Razorpay unreachable → no cookie, retryable error", async (t) => {
  fakeRazorpay(t, { "GET /v1/payments/pay_FakePayment001": new TypeError("network down") });
  const res = await verifyFn({ request: post("/api/verify", signedIds()), env: TEST_KEYS });
  assert.equal(res.status, 504);
  assert.equal(res.headers.get("Set-Cookie"), null);
});

test("verify (Razorpay callback form, in-app browsers): success → 303 /thank-you with cookie", async (t) => {
  fakeRazorpay(t, { "GET /v1/payments/pay_FakePayment001": payment() });
  const res = await verifyFn({ request: postForm("/api/verify", signedIds()), env: TEST_KEYS });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("Location"), `${SITE}/thank-you`);
  assert.ok(await verifyEnrollment({}, withCookie(res.headers.get("Set-Cookie"))));
});

test("verify (Razorpay callback form): a failure or a forgery → 303 /payment-failed, no cookie", async (t) => {
  noFetch(t);
  const failed = await verifyFn({
    request: postForm("/api/verify", { "error[code]": "BAD_REQUEST_ERROR", "error[description]": "Payment failed" }),
    env: TEST_KEYS,
  });
  assert.equal(failed.status, 303);
  assert.equal(failed.headers.get("Location"), `${SITE}/payment-failed`);
  const forged = await verifyFn({ request: postForm("/api/verify", signedIds("guessed")), env: TEST_KEYS });
  assert.equal(forged.headers.get("Location"), `${SITE}/payment-failed`);
  assert.equal(forged.headers.get("Set-Cookie"), null);
  // Without keys there is no callback flow at all.
  const demo = await verifyFn({ request: postForm("/api/verify", signedIds()), env: {} });
  assert.equal(demo.headers.get("Location"), `${SITE}/payment-failed`);
  assert.equal(demo.headers.get("Set-Cookie"), null);
});

// ---------- verify (demo) ----------

test("verify (demo): a demo order gets a demo enrollment", async () => {
  const order = await (await handleOrder(post("/api/order", {}), {}, NO_TEST_KEY)).json();
  assert.equal(order.mode, "demo");
  const res = await verifyFn({ request: post("/api/verify", { demo_order_id: order.orderId }), env: {} });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, redirect: "/thank-you" });
  const enrollment = await verifyEnrollment({}, withCookie(res.headers.get("Set-Cookie")));
  assert.equal(enrollment.paymentRef, order.orderId);
});

test("verify (demo): malformed demo ids and Razorpay ids without keys are refused", async () => {
  for (const id of ["demo_xyz", "order_123", 42, ""]) {
    const res = await verifyFn({ request: post("/api/verify", { demo_order_id: id }), env: {} });
    assert.equal(res.status, 400, String(id));
    assert.equal(res.headers.get("Set-Cookie"), null);
  }
  const res = await verifyFn({ request: post("/api/verify", signedIds()), env: {} });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("Set-Cookie"), null);
});

// A test Key ID set in Cloudflare, the way the owner turns on Razorpay's test Checkout.
const TEST_KEY_ENV = { RAZORPAY_KEY_ID: RAZORPAY_TEST_KEY_ID };

// ---------- razorpay-test (Razorpay's test Checkout without an order) ----------

test("mode: every combination of keys, course state and committed test key", () => {
  const cases = [
    // [env, demo, committed test key id, expected kind (and code when off)]
    [{}, true, RAZORPAY_TEST_KEY_ID, "razorpay-test"],
    [{}, true, "", "demo"],
    [{}, true, "rzp_live_Committed01", "demo"], // a committed live id is never used
    [{}, false, RAZORPAY_TEST_KEY_ID, "off:payments_not_configured"],
    [{}, false, "", "off:payments_not_configured"],
    [{ RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID }, true, RAZORPAY_TEST_KEY_ID, "razorpay-test"],
    [{ RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID }, true, "", "razorpay-test"],
    [{ RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID }, false, RAZORPAY_TEST_KEY_ID, "off:payments_misconfigured"],
    [{ RAZORPAY_KEY_ID: LIVE_KEYS.RAZORPAY_KEY_ID }, true, RAZORPAY_TEST_KEY_ID, "off:live_keys_in_demo"],
    [{ RAZORPAY_KEY_ID: LIVE_KEYS.RAZORPAY_KEY_ID }, false, RAZORPAY_TEST_KEY_ID, "off:payments_misconfigured"],
    [{ RAZORPAY_KEY_ID: "pk_test_123" }, true, RAZORPAY_TEST_KEY_ID, "off:payments_misconfigured"],
    [{ RAZORPAY_KEY_SECRET: "x" }, true, RAZORPAY_TEST_KEY_ID, "off:payments_misconfigured"],
    [{ RAZORPAY_KEY_SECRET: "x" }, false, RAZORPAY_TEST_KEY_ID, "off:payments_misconfigured"],
    [TEST_KEYS, true, RAZORPAY_TEST_KEY_ID, "razorpay"],
    [TEST_KEYS, true, "", "razorpay"],
    [TEST_KEYS, false, RAZORPAY_TEST_KEY_ID, "off:test_keys_on_live"],
    [LIVE_KEYS, true, RAZORPAY_TEST_KEY_ID, "off:live_keys_in_demo"],
    [LIVE_KEYS, false, RAZORPAY_TEST_KEY_ID, "off:enroll_secret_missing"],
    [{ ...LIVE_KEYS, ...ENROLL }, false, RAZORPAY_TEST_KEY_ID, "razorpay"],
    [{ ...LIVE_KEYS, ...ENROLL }, false, "", "razorpay"],
    // Blank values count as unset.
    [{ RAZORPAY_KEY_ID: "  ", RAZORPAY_KEY_SECRET: "" }, true, RAZORPAY_TEST_KEY_ID, "razorpay-test"],
  ];
  for (const [env, demo, testKeyId, expected] of cases) {
    const mode = paymentMode(env, demo, testKeyId);
    const got = mode.kind === "off" ? `off:${mode.code}` : mode.kind;
    assert.equal(got, expected, JSON.stringify({ env, demo, testKeyId }));
    if (mode.kind === "razorpay-test" || mode.kind === "demo") assert.equal(demo, true, "only on the demo course");
  }
  // The env Key ID wins over the committed one, and the committed one is used when env has none.
  assert.equal(paymentMode({ RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID }, true).keyId, TEST_KEYS.RAZORPAY_KEY_ID);
  // The committed key is switched off (USE_COMMITTED_TEST_KEY): no keys at all means the demo sheet.
  assert.equal(paymentMode({}, true).kind, "demo");
});

test("razorpay-test: never possible on the live course, whatever the env", () => {
  const envs = [{}, { RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID }, { RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID, ...ENROLL }, ENROLL];
  for (const env of envs) {
    for (const testKeyId of [RAZORPAY_TEST_KEY_ID, "", "rzp_test_Another0001"]) {
      const kind = paymentMode(env, false, testKeyId).kind;
      assert.notEqual(kind, "razorpay-test", JSON.stringify(env));
      assert.notEqual(kind, "demo", JSON.stringify(env));
    }
  }
});

test("order (razorpay-test): Checkout details without an order id, the amount from course.ts, no call to Razorpay", async (t) => {
  const calls = noFetch(t);
  const res = await orderFn({
    request: post("/api/order", {
      name: " Asha  Patel ",
      phone: "98765 43210",
      email: "asha@example.com",
      amount: 100,
      currency: "USD",
      order_id: "order_FromBrowser1",
      keyId: "rzp_test_FromBrowser",
    }),
    env: TEST_KEY_ENV,
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assertNoSecrets(text);
  assert.deepEqual(JSON.parse(text), {
    mode: "razorpay-test",
    keyId: RAZORPAY_TEST_KEY_ID,
    amount: course.price.amount,
    currency: course.price.currency,
    name: "Feelings Beauty Care",
    description: course.title,
    prefill: { name: "Asha Patel", contact: "+919876543210", email: "asha@example.com" },
  });
  assert.equal(calls.length, 0, "no Key Secret, so Razorpay's API is never called");
});

test("order (razorpay-test): a test Key ID set in env is used instead of the committed one", async (t) => {
  noFetch(t);
  const res = await orderFn({ request: post("/api/order", {}), env: { RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID } });
  const data = await res.json();
  assert.equal(data.mode, "razorpay-test");
  assert.equal(data.keyId, TEST_KEYS.RAZORPAY_KEY_ID);
  assert.equal(data.orderId, undefined);
  assert.equal(data.amount, course.price.amount);
});

test("order (razorpay-test): Instagram's and Facebook's in-app browsers get the demo sheet instead", async () => {
  const uas = [
    INSTAGRAM_UA,
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) [FBAN/FB4A;FBAV/450.0.0.0;]",
    "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36",
  ];
  for (const ua of uas) {
    const res = await orderFn({ request: post("/api/order", { amount: 1 }, { "User-Agent": ua }), env: TEST_KEY_ENV });
    const data = await res.json();
    assert.equal(data.mode, "demo", ua);
    assert.equal(data.fallback, "in_app_browser");
    assert.match(data.orderId, /^demo_[0-9a-f]{24}$/);
    assert.equal(data.amount, course.price.amount);
    // …and that demo order is accepted in this mode.
    const verify = await verifyFn({ request: post("/api/verify", { demo_order_id: data.orderId }), env: TEST_KEY_ENV });
    assert.equal(verify.status, 200);
    assert.ok(await verifyEnrollment({}, withCookie(verify.headers.get("Set-Cookie"))));
  }
  // A normal phone or desktop browser still gets Razorpay's test Checkout.
  const chrome = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
  const res = await orderFn({ request: post("/api/order", {}, { "User-Agent": chrome }), env: TEST_KEY_ENV });
  assert.equal((await res.json()).mode, "razorpay-test");
});

test("order (razorpay-test): refused on the live course", async () => {
  for (const env of [{}, { RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID }]) {
    const res = await handleOrder(post("/api/order", {}), env, { demo: false });
    assert.equal(res.status, 503, JSON.stringify(env));
    assert.notEqual((await res.json()).mode, "razorpay-test");
  }
});

test("verify (razorpay-test): a well-formed payment id → enrollment for that id and /thank-you", async (t) => {
  const calls = noFetch(t);
  const body = { mode: "razorpay-test", razorpay_payment_id: TEST_PAYMENT_ID };
  const res = await verifyFn({ request: post("/api/verify", body), env: { ...ENROLL, ...TEST_KEY_ENV } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, redirect: "/thank-you" });
  const enrollment = await verifyEnrollment(ENROLL, withCookie(res.headers.get("Set-Cookie")));
  assert.equal(enrollment.paymentRef, TEST_PAYMENT_ID);
  assert.equal(calls.length, 0, "nothing to ask Razorpay without a Key Secret");

  // Without ENROLL_SECRET the demo key signs it, as for demo orders.
  const demoKey = await verifyFn({ request: post("/api/verify", body), env: TEST_KEY_ENV });
  assert.equal(demoKey.status, 200);
  assert.ok(await verifyEnrollment({}, withCookie(demoKey.headers.get("Set-Cookie"))));
});

test("verify (razorpay-test): a bad payment id is refused", async () => {
  const bad = [
    undefined,
    "",
    42,
    ["pay_FakeTestPay001"],
    "pay_Short1",
    "pay_FakeTestPay0012", // 15 characters
    "pay_FakeTest-ay001",
    "pay_FakeTestPay00 ",
    "PAY_FakeTestPay001",
    "order_FakeTestPa01",
    "demo_0123456789abcdef01234567",
    "pay_FakeTestPay001.x",
  ];
  for (const id of bad) {
    const res = await verifyFn({ request: post("/api/verify", { mode: "razorpay-test", razorpay_payment_id: id }), env: TEST_KEY_ENV });
    assert.equal(res.status, 400, JSON.stringify(id));
    assert.equal((await res.json()).error, "invalid_payment");
    assert.equal(res.headers.get("Set-Cookie"), null);
  }
  // Without mode "razorpay-test", order-and-signature ids can't be checked here (no Key Secret).
  const signed = await verifyFn({ request: post("/api/verify", signedIds()), env: TEST_KEY_ENV });
  assert.equal(signed.status, 400);
  assert.equal(signed.headers.get("Set-Cookie"), null);
});

test("verify (razorpay-test): refused on the live course, with a Key Secret, or without a test Key ID", async (t) => {
  const calls = noFetch(t);
  const body = { mode: "razorpay-test", razorpay_payment_id: TEST_PAYMENT_ID };
  const attempts = [
    // [env, options, expected status]
    [{}, { demo: false }, 503],
    [{ RAZORPAY_KEY_ID: TEST_KEYS.RAZORPAY_KEY_ID, ...ENROLL }, { demo: false }, 503],
    [{ ...LIVE_KEYS, ...ENROLL }, { demo: false }, 403],
    [TEST_KEYS, {}, 403],
    [{ RAZORPAY_KEY_SECRET: "x" }, {}, 503],
    [{ RAZORPAY_KEY_ID: LIVE_KEYS.RAZORPAY_KEY_ID }, {}, 503],
    [{}, NO_TEST_KEY, 403],
  ];
  for (const [env, options, status] of attempts) {
    const res = await handleVerify(post("/api/verify", body), env, options);
    assert.equal(res.status, status, JSON.stringify({ env, options }));
    assert.equal(res.headers.get("Set-Cookie"), null);
  }
  // The in-app redirect flow doesn't exist in this mode.
  const form = await verifyFn({ request: postForm("/api/verify", { razorpay_payment_id: TEST_PAYMENT_ID }), env: {} });
  assert.equal(form.status, 303);
  assert.equal(form.headers.get("Location"), `${SITE}/payment-failed`);
  assert.equal(form.headers.get("Set-Cookie"), null);
  assert.equal(calls.length, 0);
});

test("verify (razorpay-test): cross-site posts are refused", async () => {
  const body = { mode: "razorpay-test", razorpay_payment_id: TEST_PAYMENT_ID };
  const res = await verifyFn({ request: post("/api/verify", body, { Origin: "https://evil.example" }), env: {} });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Set-Cookie"), null);
});

// ---------- request hygiene ----------

test("buyer details: trimmed and validated", () => {
  assert.deepEqual(parseBuyer({ name: " Urmi  Mengar ", phone: "098765 43210", email: "" }), {
    ok: true,
    buyer: { name: "Urmi Mengar", phone: "+919876543210" },
  });
  assert.deepEqual(parseBuyer({ name: "ઉર્મિ", phone: "+44 7911 123456" }).buyer, { name: "ઉર્મિ", phone: "+447911123456" });
  assert.deepEqual(parseBuyer(undefined), { ok: true, buyer: {} });
  const bad = parseBuyer({ name: "<script>", phone: "12345", email: "nope" });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ["email", "name", "phone"]);
  assert.equal(parseBuyer({ phone: 9876543210 }).ok, false);
});

test("order: invalid details → 400 with field messages", async () => {
  const res = await orderFn({ request: post("/api/order", { name: "A", phone: "123" }), env: {} });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.fields.name && data.fields.phone);
});

test("order/verify: cross-site posts, other methods, bad JSON and big bodies are refused", async () => {
  const cross = await orderFn({ request: post("/api/order", {}, { Origin: "https://evil.example" }), env: {} });
  assert.equal(cross.status, 403);
  const crossVerify = await verifyFn({
    request: post("/api/verify", { demo_order_id: "demo_0123456789abcdef01234567" }, { Origin: "https://evil.example" }),
    env: {},
  });
  assert.equal(crossVerify.status, 403);
  assert.equal(crossVerify.headers.get("Set-Cookie"), null);

  const get = await orderFn({ request: new Request(`${SITE}/api/order`), env: {} });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("Allow"), "POST");
  assert.equal((await orderFn({ request: post("/api/order", "{not json"), env: {} })).status, 400);
  assert.equal((await orderFn({ request: post("/api/order", "[1,2]"), env: {} })).status, 400);
  assert.equal((await orderFn({ request: post("/api/order", { name: "x".repeat(5000) }), env: {} })).status, 413);
  // Every JSON reply is uncacheable.
  assert.equal(cross.headers.get("Cache-Control"), "no-store");
});
