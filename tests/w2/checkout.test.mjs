// W2: POST /api/order and POST /api/verify on D1 (functions/_lib/payments.ts), with a fake Razorpay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleLiveOrder, handleLiveVerify, routeOrder, routeVerify, handleCouponQuote } from "../../functions/_lib/payments.ts";
import { fulfilOrderDb } from "../../functions/_lib/orders.ts";
import { postForm, postJson, readJson } from "../helpers/http.mjs";
import { DAY, LIVE_ENV, NOW, TEST_ENV, envFor, orderBody, orderRequest, paymentEntity, razorpay, setupDb, signPayment, verifyBody } from "./fixtures.mjs";

const createOrder = async (t, db, { env = envFor(db), body = orderBody(), now = NOW, ...rest } = {}) => {
  const fake = rest.fake ?? razorpay(t);
  const res = await handleLiveOrder(orderRequest(body), env, now);
  return { res, data: await readJson(res), fake };
};

test("order: the amount comes from D1, whatever the browser sends", async (t) => {
  const db = await setupDb();
  const { res, data, fake } = await createOrder(t, db, {
    body: orderBody({ amount: 100, amountPaise: 100, price: 1, currency: "USD", mode: "live", coupon: "SAVE20" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    { mode: data.mode, keyId: data.keyId, orderId: data.orderId, amount: data.amount, currency: data.currency, testMode: data.testMode },
    { mode: "razorpay", keyId: TEST_ENV.RAZORPAY_KEY_ID, orderId: "order_Fake0001", amount: 120000, currency: "INR", testMode: true },
  );
  assert.deepEqual(data.prefill, { name: "Asha Patel", email: "asha@example.com", contact: "+919876543210" });
  assert.equal(JSON.stringify(data).includes(TEST_ENV.RAZORPAY_KEY_SECRET), false);
  // Razorpay was asked for exactly the server's amount, with our order id as the receipt.
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].body, { amount: 120000, currency: "INR", receipt: `order_${data.ref}`, notes: { order_id: String(data.ref), course: "online-basics" } });
  assert.equal(fake.calls[0].auth.keyId, TEST_ENV.RAZORPAY_KEY_ID);
  const row = db.get("SELECT * FROM orders WHERE id = ?", data.ref);
  assert.equal(row.razorpay_order_id, "order_Fake0001");
  assert.deepEqual([row.mode, row.status, row.list_price_paise, row.discount_paise, row.amount_paise, row.coupon_id], ["test", "created", 149999, 29999, 120000, 1]);
  assert.equal(row.invoice_no, null);
  const student = db.get("SELECT * FROM students WHERE id = ?", row.student_id);
  assert.deepEqual([student.name, student.phone, student.email], ["Asha Patel", "+919876543210", "asha@example.com"]);
});

test("order: checks the request and the buyer", async (t) => {
  const db = await setupDb();
  razorpay(t);
  const env = envFor(db);
  const bad = await handleLiveOrder(orderRequest(orderBody({ phone: "123", consent: false, name: "" })), env, NOW);
  assert.equal(bad.status, 400);
  const body = await readJson(bad);
  assert.equal(body.error, "invalid_details");
  assert.ok(body.fields.phone && body.fields.consent);
  // The email is the account: required. The phone is optional.
  const noEmail = await readJson(await handleLiveOrder(orderRequest(orderBody({ email: "" })), env, NOW));
  assert.ok(noEmail.fields.email, "an order needs an email");
  const badEmail = await readJson(await handleLiveOrder(orderRequest(orderBody({ email: "asha at example" })), env, NOW));
  assert.ok(badEmail.fields.email);
  const cross = await handleLiveOrder(postJson("/api/order", orderBody(), { origin: "https://evil.example" }), env, NOW);
  assert.equal(cross.status, 403);
  const form = await handleLiveOrder(postForm("/api/order", { course: "online-basics" }), env, NOW);
  assert.equal(form.status, 415);
  assert.equal((await handleLiveOrder(orderRequest(orderBody({ course: "nope" })), env, NOW)).status, 404);
  assert.equal((await handleLiveOrder(orderRequest(orderBody({ course: "diploma" })), env, NOW)).status, 409);
  const coupon = await handleLiveOrder(orderRequest(orderBody({ coupon: "OLD10" })), env, NOW);
  assert.equal(coupon.status, 400);
  assert.equal((await readJson(coupon)).error, "invalid_coupon");
  const full = await handleLiveOrder(orderRequest(orderBody({ course: "studio-batch", batchId: 112 })), env, NOW);
  assert.equal((await readJson(full)).error, "batch_full");
  // None of that wrote an order.
  assert.equal(db.get("SELECT COUNT(*) AS n FROM orders").n, 0);
});

test("order: keys, demo course and the legal gate", async (t) => {
  razorpay(t);
  const db = await setupDb({ legal: false });
  const noKeys = await handleLiveOrder(orderRequest(), { DB: db }, NOW);
  assert.equal(noKeys.status, 503);
  assert.equal((await readJson(noKeys)).error, "payments_not_configured");
  const demoLive = await handleLiveOrder(orderRequest(orderBody({ course: "selfmakeup" })), envFor(db, LIVE_ENV), NOW);
  assert.equal(demoLive.status, 403);
  assert.equal((await readJson(demoLive)).error, "live_keys_on_demo");
  const legal = await handleLiveOrder(orderRequest(), envFor(db, LIVE_ENV), NOW);
  assert.equal(legal.status, 503);
  assert.equal((await readJson(legal)).error, "legal_not_confirmed");
  // Test keys may sell the demo course and need no legal confirmation.
  assert.equal((await handleLiveOrder(orderRequest(orderBody({ course: "selfmakeup" })), envFor(db), NOW)).status, 200);
  db.sqlite.exec("UPDATE settings SET value = 'true' WHERE key = 'legal_confirmed'");
  const live = await handleLiveOrder(orderRequest(), envFor(db, LIVE_ENV), NOW);
  assert.equal(live.status, 200);
  const data = await readJson(live);
  assert.equal(data.testMode, false);
  assert.equal(db.get("SELECT mode FROM orders WHERE id = ?", data.ref).mode, "live");
});

test("order: rate limited per IP", async (t) => {
  const db = await setupDb();
  razorpay(t);
  const env = envFor(db);
  let last;
  for (let i = 0; i < 11; i++) {
    last = await handleLiveOrder(orderRequest(orderBody({ email: `buyer${i}@example.com` })), env, NOW);
  }
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("Retry-After")) > 0);
});

test("order: Razorpay down marks our order failed and says so", async (t) => {
  const db = await setupDb();
  razorpay(t, { routes: { "POST /v1/orders": new Error("network down") } });
  const res = await handleLiveOrder(orderRequest(), envFor(db), NOW);
  assert.equal(res.status, 502);
  assert.equal((await readJson(res)).error, "razorpay_unavailable");
  assert.equal(db.get("SELECT status FROM orders").status, "failed");
});

test("order: the account is found by email; a checkout never changes it; the phone never finds one", async (t) => {
  const db = await setupDb();
  const fake = razorpay(t);
  db.sqlite.exec(`INSERT INTO students (id, name, phone, email, created_at, updated_at) VALUES
    (70, 'Phone Owner', '+919876543210', 'owner@example.com', ${NOW}, ${NOW}), (71, 'Real Name', NULL, 'asha@example.com', ${NOW}, ${NOW})`);
  // asha@example.com with student 70's phone: the order goes to the email's account (71), whose
  // name and phone stay as they are; student 70 is untouched.
  const { res, data } = await createOrder(t, db, { fake, body: orderBody({ name: "Someone Else" }) });
  assert.equal(res.status, 200);
  assert.equal(db.get("SELECT student_id FROM orders WHERE id = ?", data.ref).student_id, 71);
  assert.deepEqual({ ...db.get("SELECT name, phone, email FROM students WHERE id = 71") }, { name: "Real Name", phone: null, email: "asha@example.com" });
  assert.deepEqual({ ...db.get("SELECT name, phone, email FROM students WHERE id = 70") }, { name: "Phone Owner", phone: "+919876543210", email: "owner@example.com" });
  // A new email with a phone someone else has: a new account, without that phone (it's unique, and it never links accounts).
  const fresh = await createOrder(t, db, { fake, body: orderBody({ email: "Bina@Example.com", name: "Bina" }) });
  assert.equal(fresh.res.status, 200, JSON.stringify(fresh.data));
  const bina = db.get("SELECT * FROM students WHERE id = (SELECT student_id FROM orders WHERE id = ?)", fresh.data.ref);
  assert.deepEqual([bina.email, bina.phone, bina.name], ["bina@example.com", null, "Bina"]);
  // A new email with a free phone keeps it as a contact detail; no phone at all is fine.
  const chet = await createOrder(t, db, { fake, body: orderBody({ email: "chet@example.com", phone: "9811111111" }) });
  assert.equal(db.get("SELECT phone FROM students WHERE email = 'chet@example.com'").phone, "+919811111111");
  assert.equal(chet.res.status, 200);
  const dev = await createOrder(t, db, { fake, body: { ...orderBody({ email: "dev@example.com" }), phone: undefined } });
  assert.equal(dev.res.status, 200);
  assert.equal(db.get("SELECT phone FROM students WHERE email = 'dev@example.com'").phone, null);
  assert.deepEqual(dev.data.prefill, { name: "Asha Patel", email: "dev@example.com" });
});

test("verify: signature + Razorpay's record → paid, enrolled for 365 days, receipt link", async (t) => {
  const db = await setupDb();
  const env = envFor(db);
  const fake = razorpay(t, { payments: { pay_Paid00000001: { order_id: "order_Fake0001", amount: 120000 } } });
  const order = await readJson(await handleLiveOrder(orderRequest(orderBody({ coupon: "SAVE20" })), env, NOW));
  const res = await handleLiveVerify(postJson("/api/verify", verifyBody(order.orderId, "pay_Paid00000001")), env, NOW + 60);
  assert.equal(res.status, 200);
  const data = await readJson(res);
  assert.match(data.receipt, new RegExp(`^https://courses\\.feelingsbeautycare\\.in/receipt/${order.ref}\\?k=[0-9a-f]{32}$`));
  // W3's handoff (integration): a one-time sign-in on the hub that lands on the receipt.
  assert.match(data.redirect, /^https:\/\/courses\.feelingsbeautycare\.in\/auth\/continue\?t=[A-Za-z0-9_-]{43}$/);
  const handoff = db.get("SELECT purpose, student_id, redirect_path FROM login_tokens");
  assert.deepEqual([handoff.purpose, handoff.redirect_path], ["handoff", new URL(data.receipt).pathname + new URL(data.receipt).search]);
  const row = db.get("SELECT * FROM orders WHERE id = ?", order.ref);
  assert.deepEqual([row.status, row.razorpay_payment_id, row.paid_at, row.method, row.payer_contact], ["paid", "pay_Paid00000001", NOW + 60, "upi", "+919876543210"]);
  assert.equal(row.invoice_no, null); // test mode: no number from the real series
  const enrollment = db.get("SELECT * FROM enrollments WHERE order_id = ?", order.ref);
  assert.deepEqual([enrollment.source, enrollment.mode, enrollment.starts_at, enrollment.expires_at], ["payment", "test", NOW + 60, NOW + 60 + 365 * DAY]);
  assert.equal(db.get("SELECT used_count FROM coupons WHERE id = 1").used_count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM coupon_redemptions WHERE order_id = ?", order.ref).n, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.paid'").n, 1);
  assert.equal(fake.calls.filter((c) => c.method === "GET").length, 1);

  // Again (a double click, a retry): same answer, nothing applied twice.
  const again = await handleLiveVerify(postJson("/api/verify", verifyBody(order.orderId, "pay_Paid00000001")), env, NOW + 120);
  assert.equal(again.status, 200);
  assert.equal(db.get("SELECT used_count FROM coupons WHERE id = 1").used_count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.paid'").n, 1);
  assert.equal(db.get("SELECT paid_at FROM orders WHERE id = ?", order.ref).paid_at, NOW + 60);

  // A second order for the same course is refused while access lasts.
  const second = await handleLiveOrder(orderRequest(), env, NOW + 300);
  assert.equal(second.status, 409);
  assert.equal((await readJson(second)).error, "already_enrolled");
});

test("verify: a forged signature never reaches Razorpay or D1", async (t) => {
  const db = await setupDb();
  const env = envFor(db);
  const fake = razorpay(t, { payments: { pay_Paid00000001: { order_id: "order_Fake0001", amount: 149999 } } });
  const order = await readJson(await handleLiveOrder(orderRequest(), env, NOW));
  const forged = verifyBody(order.orderId, "pay_Paid00000001", "not-the-secret");
  const res = await handleLiveVerify(postJson("/api/verify", forged), env, NOW);
  assert.equal(res.status, 400);
  assert.equal((await readJson(res)).error, "signature_invalid");
  assert.equal(fake.calls.filter((c) => c.method === "GET").length, 0);
  assert.equal(db.get("SELECT status FROM orders").status, "created");
  // Malformed ids are refused before any crypto.
  const junk = await handleLiveVerify(postJson("/api/verify", { razorpay_order_id: "order_x'--", razorpay_payment_id: "pay_1", razorpay_signature: "zz" }), env, NOW);
  assert.equal((await readJson(junk)).error, "invalid_payment");
});

test("verify: a payment for another amount or order doesn't enroll", async (t) => {
  const db = await setupDb();
  const env = envFor(db);
  razorpay(t, {
    payments: {
      pay_Cheap0000001: { order_id: "order_Fake0001", amount: 100 },
      pay_Other0000001: { order_id: "order_SomeoneElse", amount: 149999 },
      pay_Failed000001: { order_id: "order_Fake0001", amount: 149999, status: "failed" },
    },
  });
  const order = await readJson(await handleLiveOrder(orderRequest(), env, NOW));
  for (const pay of ["pay_Cheap0000001", "pay_Other0000001", "pay_Failed000001"]) {
    const res = await handleLiveVerify(postJson("/api/verify", verifyBody(order.orderId, pay)), env, NOW);
    assert.equal(res.status, 400, pay);
    assert.equal((await readJson(res)).error, "payment_not_confirmed");
  }
  assert.equal(db.get("SELECT status FROM orders").status, "created");
  assert.equal(db.get("SELECT COUNT(*) AS n FROM enrollments WHERE course_id = 10").n, 0);
});

test("verify: an authorized payment is captured first", async (t) => {
  const db = await setupDb();
  const env = envFor(db);
  const fake = razorpay(t, {
    payments: { pay_Auth00000001: { order_id: "order_Fake0001", amount: 149999, status: "authorized", captured: false } },
    routes: { "POST /v1/payments/pay_Auth00000001/capture": paymentEntity({ id: "pay_Auth00000001", order_id: "order_Fake0001", amount: 149999 }) },
  });
  const order = await readJson(await handleLiveOrder(orderRequest(), env, NOW));
  const res = await handleLiveVerify(postJson("/api/verify", verifyBody(order.orderId, "pay_Auth00000001")), env, NOW);
  assert.equal(res.status, 200);
  const capture = fake.calls.find((c) => c.path.endsWith("/capture"));
  assert.deepEqual(capture.body, { amount: 149999, currency: "INR" });
  assert.equal(db.get("SELECT status FROM orders").status, "paid");
});

test("verify: Razorpay unreachable → a clear 504, the order stays open for the webhook", async (t) => {
  const db = await setupDb();
  const env = envFor(db);
  razorpay(t, { routes: { "GET /v1/payments/pay_Paid00000001": new Error("timeout") } });
  const order = await readJson(await handleLiveOrder(orderRequest(), env, NOW));
  const res = await handleLiveVerify(postJson("/api/verify", verifyBody(order.orderId, "pay_Paid00000001")), env, NOW);
  assert.equal(res.status, 504);
  assert.equal((await readJson(res)).error, "razorpay_unavailable");
  assert.equal(db.get("SELECT status FROM orders").status, "created");
});

test("verify: Razorpay's callback form (in-app browsers) redirects", async (t) => {
  const db = await setupDb();
  const env = envFor(db);
  razorpay(t, { payments: { pay_Paid00000001: { order_id: "order_Fake0001", amount: 149999 } } });
  const order = await readJson(await handleLiveOrder(orderRequest(), env, NOW));
  const good = await handleLiveVerify(postForm("/api/verify", verifyBody(order.orderId, "pay_Paid00000001"), { origin: "https://api.razorpay.com" }), env, NOW);
  assert.equal(good.status, 303);
  // W3's handoff signs the buyer in on the hub, then lands on the receipt.
  assert.match(good.headers.get("Location"), /^https:\/\/courses\.feelingsbeautycare\.in\/auth\/continue\?t=[A-Za-z0-9_-]{43}$/);
  assert.match(db.get("SELECT redirect_path FROM login_tokens").redirect_path, /^\/receipt\/\d+\?k=[0-9a-f]{32}$/);
  const bad = await handleLiveVerify(postForm("/api/verify", { ...verifyBody(order.orderId, "pay_Paid00000001"), razorpay_signature: "0".repeat(64) }), env, NOW);
  assert.equal(bad.status, 303);
  assert.equal(new URL(bad.headers.get("Location")).pathname, "/payment-failed");
});

test("verify: live payments get consecutive invoice numbers per financial year", async (t) => {
  const db = await setupDb();
  const env = envFor(db, LIVE_ENV);
  const payments = {};
  for (let i = 1; i <= 4; i++) payments[`pay_Live0000000${i}`] = { order_id: `order_Fake000${i}`, amount: 149999 };
  razorpay(t, { payments });
  const pay = async (i, email, now) => {
    const order = await readJson(await handleLiveOrder(orderRequest(orderBody({ email })), env, now));
    const res = await handleLiveVerify(postJson("/api/verify", verifyBody(order.orderId, `pay_Live0000000${i}`, LIVE_ENV.RAZORPAY_KEY_SECRET)), env, now);
    assert.equal(res.status, 200);
    return db.get("SELECT invoice_no FROM orders WHERE id = ?", order.ref).invoice_no;
  };
  assert.equal(await pay(1, "b1@example.com", NOW), "FBC/26-27/00001");
  assert.equal(await pay(2, "b2@example.com", NOW + 10), "FBC/26-27/00002");
  // 31 Mar 2027 23:59 IST, then 1 Apr 2027 00:01 IST: a new year starts at 1.
  const march31 = Date.UTC(2027, 2, 31, 18, 29) / 1000;
  assert.equal(await pay(3, "b3@example.com", march31), "FBC/26-27/00003");
  assert.equal(await pay(4, "b4@example.com", march31 + 120), "FBC/27-28/00001");
  assert.deepEqual(db.rows("SELECT fy, last FROM invoice_counters ORDER BY fy").map((r) => ({ ...r })), [
    { fy: "2026-27", last: 3 },
    { fy: "2027-28", last: 1 },
  ]);
  const stats = db.get("SELECT SUM(paid_orders) AS n, SUM(revenue_paise) AS r FROM daily_stats");
  assert.deepEqual({ ...stats }, { n: 4, r: 4 * 149999 });
});

test("fulfil: racing fulfils (verify and webhook at once) apply once", async (t) => {
  const db = await setupDb();
  const env = envFor(db, LIVE_ENV);
  razorpay(t);
  db.sqlite.exec("UPDATE settings SET value = 'true' WHERE key = 'legal_confirmed'");
  const order = await readJson(await handleLiveOrder(orderRequest(orderBody({ course: "studio-batch", batchId: 111, coupon: "SAVE20" })), env, NOW));
  const payment = { ...paymentEntity({ id: "pay_Race00000001", order_id: order.orderId, amount: 100000 }) };
  const results = await Promise.all([1, 2, 3].map(() => fulfilOrderDb(db, { orderId: order.ref, payment, now: NOW })));
  assert.equal(results.filter((r) => r.ok && !r.alreadyPaid).length, 1);
  assert.equal(results.filter((r) => r.ok && r.alreadyPaid).length, 2);
  assert.equal(db.get("SELECT seats_taken FROM batches WHERE id = 111").seats_taken, 1);
  assert.equal(db.get("SELECT used_count FROM coupons WHERE id = 1").used_count, 1);
  assert.equal(db.get("SELECT last FROM invoice_counters").last, 1);
  assert.equal(db.get("SELECT paid_orders FROM daily_stats").paid_orders, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM enrollments WHERE course_id = 11").n, 1);
  // The deposit order: in-person, no access expiry.
  assert.equal(db.get("SELECT expires_at FROM enrollments WHERE course_id = 11").expires_at, null);
  assert.equal(db.get("SELECT payment_kind FROM orders WHERE id = ?", order.ref).payment_kind, "deposit");
});

test("fulfil: a second paid order for an active enrollment is flagged, not double-enrolled", async (t) => {
  const db = await setupDb();
  const env = envFor(db);
  razorpay(t);
  const a = await readJson(await handleLiveOrder(orderRequest(), env, NOW));
  const b = await readJson(await handleLiveOrder(orderRequest(), env, NOW)); // second tab, before paying the first
  const pay = (order, id) => fulfilOrderDb(db, { orderId: order.ref, payment: paymentEntity({ id, order_id: order.orderId, amount: 149999 }), now: NOW });
  assert.equal((await pay(a, "pay_A00000000001")).ok, true);
  assert.equal((await pay(b, "pay_B00000000001")).ok, true);
  assert.equal(db.get("SELECT order_id FROM enrollments WHERE course_id = 10").order_id, a.ref);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.duplicate_payment' AND entity_id = ?", String(b.ref)).n, 1);
  // A wrong payment for a paid order is refused.
  assert.deepEqual(await pay(a, "pay_C00000000001"), { ok: false, reason: "order_mismatch" });
});

test("free: a 100% allow_free coupon enrolls without Razorpay, once", async (t) => {
  const db = await setupDb();
  const env = envFor(db);
  const fake = razorpay(t);
  const res = await handleLiveOrder(orderRequest(orderBody({ coupon: "FREEPASS" })), env, NOW);
  assert.equal(res.status, 200);
  const free = await readJson(res);
  assert.equal(free.mode, "free");
  // W3's handoff (integration): signed in on the hub, straight into the course.
  assert.match(free.redirect, /^https:\/\/courses\.feelingsbeautycare\.in\/auth\/continue\?t=[A-Za-z0-9_-]{43}$/);
  assert.match(db.get("SELECT redirect_path FROM login_tokens").redirect_path, /^\/learn\/[a-z0-9-]+$/);
  assert.equal(fake.calls.length, 0);
  const e = db.get("SELECT * FROM enrollments WHERE course_id = 10");
  assert.deepEqual([e.source, e.mode, e.order_id, e.expires_at], ["coupon_free", "live", null, NOW + 365 * DAY]);
  assert.equal(db.get("SELECT used_count FROM coupons WHERE id = 3").used_count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM orders").n, 0);
  // max_uses 1: the next student can't use it.
  const other = await handleLiveOrder(orderRequest(orderBody({ coupon: "FREEPASS", email: "b@example.com" })), env, NOW);
  assert.equal(other.status, 400);
  assert.equal((await readJson(other)).error, "invalid_coupon");
  // A free course enrolls with no coupon and no keys at all.
  const intro = await handleLiveOrder(orderRequest(orderBody({ course: "free-intro", email: "c@example.com" })), { DB: db }, NOW);
  assert.equal((await readJson(intro)).mode, "free");
});

test("coupon quote endpoint", async () => {
  const db = await setupDb();
  const env = envFor(db);
  const ok = await handleCouponQuote(postJson("/api/coupon/quote", { course: "online-basics", code: "save20" }), env, NOW);
  assert.deepEqual(await readJson(ok), { ok: true, listPaise: 149999, discountPaise: 29999, amountPaise: 120000, label: "20% off", free: false });
  const bad = await handleCouponQuote(postJson("/api/coupon/quote", { course: "online-basics", code: "OLD10" }), env, NOW);
  assert.deepEqual(await readJson(bad), { ok: false, reason: "coupon_expired" });
  const cross = await handleCouponQuote(postJson("/api/coupon/quote", { course: "online-basics", code: "SAVE20" }, { origin: "https://evil.example" }), env, NOW);
  assert.equal(cross.status, 403);
  let last;
  for (let i = 0; i < 21; i++) last = await handleCouponQuote(postJson("/api/coupon/quote", { course: "online-basics", code: `TRY${i}X` }, { ip: "198.51.100.1" }), env, NOW);
  assert.equal(last.status, 429);
});

test("routing: the demo checkout still answers without D1 or without a course", async (t) => {
  const db = await setupDb();
  const demo = await readJson(await routeOrder(postJson("/api/order", { name: "Asha", phone: "9876543210" }), {}));
  assert.ok(["demo", "razorpay-test"].includes(demo.mode));
  const demoWithDb = await readJson(await routeOrder(postJson("/api/order", { name: "Asha", phone: "9876543210" }), { DB: db }));
  assert.ok(["demo", "razorpay-test"].includes(demoWithDb.mode));
  // An unknown Razorpay order id goes to the demo verify, which can't verify it without keys.
  const v = await routeVerify(postJson("/api/verify", verifyBody("order_Unknown0001", "pay_Unknown00001")), { DB: db });
  assert.equal(v.status, 400);
  // A known one takes the live path.
  razorpay(t, { payments: { pay_Paid00000001: { order_id: "order_Fake0001", amount: 149999 } } });
  const order = await readJson(await routeOrder(orderRequest(), envFor(db)));
  assert.equal(order.mode, "razorpay");
  const live = await routeVerify(postJson("/api/verify", verifyBody(order.orderId, "pay_Paid00000001")), envFor(db));
  assert.equal(live.status, 200);
  assert.ok((await readJson(live)).receipt);
  void signPayment;
});

test("verify: an authorized payment that Razorpay already captured is read back, not failed", async (t) => {
  const db = await setupDb();
  const env = envFor(db);
  let reads = 0;
  razorpay(t, {
    routes: {
      "GET /v1/payments/pay_Auto00000001": () => {
        reads += 1;
        return { body: paymentEntity({ id: "pay_Auto00000001", order_id: "order_Fake0001", amount: 149999, status: reads === 1 ? "authorized" : "captured" }) };
      },
      "POST /v1/payments/pay_Auto00000001/capture": () => ({ status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "This payment has already been captured" } } }),
    },
  });
  const order = await readJson(await handleLiveOrder(orderRequest(), env, NOW));
  const res = await handleLiveVerify(postJson("/api/verify", verifyBody(order.orderId, "pay_Auto00000001")), env, NOW);
  assert.equal(res.status, 200);
  assert.equal(db.get("SELECT status FROM orders").status, "paid");
});

test("order: an oversized body goes to the demo handler's 413, never parsed", async () => {
  const db = await setupDb();
  const res = await routeOrder(postJson("/api/order", { course: "online-basics", pad: "x".repeat(20_000) }), envFor(db));
  assert.equal(res.status, 413);
});
