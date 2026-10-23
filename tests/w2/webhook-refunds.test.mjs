// W2: the Razorpay webhook, refunds within 24 hours, sync with Razorpay, and receipts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleLiveOrder, handleWebhook } from "../../functions/_lib/payments.ts";
import {
  fulfilOrderDb,
  financialYear,
  loadAdminOrder,
  maskPhone,
  paymentKeys,
  processWebhookEventDb,
  refundOrderDb,
  syncOrderDb,
} from "../../functions/_lib/orders.ts";
import { buildReceipt, receiptPath } from "../../functions/_lib/receipts.ts";
import { handleReceipt } from "../../functions/_lib/receipts-route.ts";
import { ConflictError, ValidationError } from "../../functions/_lib/db/errors.ts";
import { context, req, readJson } from "../helpers/http.mjs";
import { refundEntity, webhook } from "../helpers/razorpay.mjs";
import { DAY, LIVE_ENV, NOW, TEST_ENV, envFor, orderBody, orderRequest, paymentEntity, razorpay, setupDb } from "./fixtures.mjs";

const hook = (event, entities, { secret = TEST_ENV.RAZORPAY_WEBHOOK_SECRET, eventId } = {}) => {
  const { body, headers } = webhook(event, entities, secret, eventId ? { eventId } : {});
  return req("/api/razorpay/webhook", { method: "POST", body, headers, origin: null });
};

/** A created order (and its Razorpay order id) for course 10 at ₹1,499.99. */
async function newOrder(t, db, env, body = orderBody()) {
  const data = await readJson(await handleLiveOrder(orderRequest(body), env, NOW));
  assert.equal(data.mode, "razorpay");
  return data;
}

/** A paid order, fulfilled at `paidAt`. */
async function paidOrder(t, db, env, { paidAt = NOW, body } = {}) {
  const order = await newOrder(t, db, env, body);
  const payment = paymentEntity({ id: `pay_Paid${String(order.ref).padStart(10, "0")}`, order_id: order.orderId, amount: order.amount });
  const result = await fulfilOrderDb(db, { orderId: order.ref, payment, now: paidAt });
  assert.equal(result.ok, true);
  return { ...order, paymentId: payment.id };
}

test("webhook: signature checked before anything is stored", async (t) => {
  const db = await setupDb();
  razorpay(t);
  const env = envFor(db);
  const order = await newOrder(t, db, env);
  const forged = hook("payment.captured", { payment: paymentEntity({ order_id: order.orderId, amount: order.amount }) }, { secret: "wrong-secret-0000" });
  const res = await handleWebhook(forged, env, undefined, NOW);
  assert.equal(res.status, 400);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM webhook_events").n, 0);
  assert.equal(db.get("SELECT status FROM orders").status, "created");
  // No webhook secret set: 503, nothing stored.
  const { RAZORPAY_WEBHOOK_SECRET, ...noSecret } = env;
  const res2 = await handleWebhook(hook("payment.captured", { payment: paymentEntity() }), noSecret, undefined, NOW);
  assert.equal(res2.status, 503);
  // Too large.
  const big = req("/api/razorpay/webhook", { method: "POST", body: "x".repeat(100_001), headers: { "Content-Type": "application/json" }, origin: null });
  assert.equal((await handleWebhook(big, env, undefined, NOW)).status, 413);
});

test("webhook: payment.captured fulfils; duplicates and order.paid change nothing more", async (t) => {
  const db = await setupDb();
  razorpay(t);
  const env = envFor(db);
  const order = await newOrder(t, db, env);
  const payment = paymentEntity({ id: "pay_Hook00000001", order_id: order.orderId, amount: order.amount });
  const ctx = context();
  const res = await handleWebhook(hook("payment.captured", { payment }, { eventId: "evt_A" }), env, ctx, NOW);
  assert.equal(res.status, 200);
  assert.deepEqual(await readJson(res), { ok: true });
  assert.equal(db.get("SELECT status FROM orders").status, "paid");
  const event = db.get("SELECT * FROM webhook_events WHERE event_id = 'evt_A'");
  assert.deepEqual([event.type, event.mode, event.processed_at, event.error], ["payment.captured", "test", NOW, null]);
  // Razorpay retries the same delivery, then sends order.paid for the same payment.
  assert.equal((await handleWebhook(hook("payment.captured", { payment }, { eventId: "evt_A" }), env, undefined, NOW + 5)).status, 200);
  assert.equal((await handleWebhook(hook("order.paid", { payment, order: { id: order.orderId } }, { eventId: "evt_B" }), env, undefined, NOW + 6)).status, 200);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.paid'").n, 1);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM webhook_events").n, 2);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM enrollments WHERE course_id = 10").n, 1);
});

test("webhook: payment.failed, then a captured retry; unknown orders are noted, not retried", async (t) => {
  const db = await setupDb();
  razorpay(t);
  const env = envFor(db);
  const order = await newOrder(t, db, env);
  const failed = paymentEntity({ id: "pay_Fail00000001", order_id: order.orderId, amount: order.amount, status: "failed", error_description: "Payment was cancelled by the user" });
  await handleWebhook(hook("payment.failed", { payment: failed }), env, undefined, NOW);
  const row = db.get("SELECT status, failure_reason FROM orders");
  assert.deepEqual({ ...row }, { status: "failed", failure_reason: "Payment was cancelled by the user" });
  const ok = paymentEntity({ id: "pay_Good00000001", order_id: order.orderId, amount: order.amount });
  await handleWebhook(hook("payment.captured", { payment: ok }), env, undefined, NOW + 30);
  assert.equal(db.get("SELECT status FROM orders").status, "paid");

  const stranger = await handleWebhook(hook("payment.captured", { payment: paymentEntity({ order_id: "order_NotOurs00001" }) }, { eventId: "evt_X" }), env, undefined, NOW);
  assert.equal(stranger.status, 200);
  const noted = db.get("SELECT processed_at, error FROM webhook_events WHERE event_id = 'evt_X'");
  assert.equal(noted.processed_at, NOW);
  assert.match(noted.error, /not from this site/);
  const ignored = await handleWebhook(hook("invoice.paid", { invoice: { id: "inv_1" } }, { eventId: "evt_I" }), env, undefined, NOW);
  assert.equal(ignored.status, 200);
});

test("webhook: an error leaves the event unprocessed (500, Razorpay retries); a replay finishes it", async (t) => {
  const db = await setupDb();
  razorpay(t, { routes: { "POST /v1/payments/pay_Auth00000001/capture": paymentEntity({ id: "pay_Auth00000001", order_id: "order_Fake0001", amount: 149999 }) } });
  const env = envFor(db);
  const order = await newOrder(t, db, env);
  const authorized = paymentEntity({ id: "pay_Auth00000001", order_id: order.orderId, amount: order.amount, status: "authorized" });
  // Capturing needs the key secret: without it the event fails and stays pending.
  const { RAZORPAY_KEY_SECRET, ...noKey } = env;
  const res = await handleWebhook(hook("payment.authorized", { payment: authorized }, { eventId: "evt_Auth" }), noKey, undefined, NOW);
  assert.equal(res.status, 500);
  const pending = db.get("SELECT processed_at, error FROM webhook_events WHERE event_id = 'evt_Auth'");
  assert.equal(pending.processed_at, null);
  assert.match(pending.error, /RAZORPAY_KEY_SECRET/);
  // The admin's replay (or Razorpay's retry) with the keys in place.
  await processWebhookEventDb(db, paymentKeys(env), "evt_Auth", NOW + 60);
  assert.equal(db.get("SELECT status FROM orders").status, "paid");
  assert.equal(db.get("SELECT processed_at FROM webhook_events WHERE event_id = 'evt_Auth'").processed_at, NOW + 60);
});

test("refunds: within 24 hours, full refund revokes access and credits the order", async (t) => {
  const db = await setupDb();
  db.sqlite.exec("UPDATE settings SET value = 'true' WHERE key = 'legal_confirmed'");
  const fake = razorpay(t, {
    routes: {
      "POST /v1/payments/pay_Paid0000000001/refund": (call) => ({ body: refundEntity({ id: "rfnd_Full00000001", payment_id: "pay_Paid0000000001", amount: call.body.amount, notes: call.body.notes }) }),
    },
  });
  const env = envFor(db, LIVE_ENV);
  const order = await paidOrder(t, db, env);
  const keys = paymentKeys(env);
  const refund = await refundOrderDb(db, keys, order.ref, { reason: "Changed my mind", revoke: true, now: NOW + 23 * 3600 });
  assert.deepEqual(
    { status: refund.status, amount: refund.amountPaise, rzp: refund.razorpayRefundId, revoke: refund.revokeAccess },
    { status: "processed", amount: 149999, rzp: "rfnd_Full00000001", revoke: true },
  );
  const call = fake.calls.find((c) => c.path.endsWith("/refund"));
  assert.deepEqual(call.body, { amount: 149999, speed: "normal", receipt: `refund_${refund.id}`, notes: { order_id: String(order.ref), refund_id: String(refund.id) } });
  const row = db.get("SELECT status, refunded_paise FROM orders WHERE id = ?", order.ref);
  assert.deepEqual({ ...row }, { status: "refunded", refunded_paise: 149999 });
  assert.notEqual(db.get("SELECT revoked_at FROM enrollments WHERE order_id = ?", order.ref).revoked_at, null);
  assert.equal(db.get("SELECT SUM(refunds_paise) AS r FROM daily_stats").r, 149999);
  // The webhook for the same refund changes nothing more.
  await handleWebhook(hook("refund.processed", { refund: refundEntity({ id: "rfnd_Full00000001", payment_id: "pay_Paid0000000001", amount: 149999 }) }, { secret: LIVE_ENV.RAZORPAY_WEBHOOK_SECRET }), env, undefined, NOW + 23 * 3600 + 5);
  assert.equal(db.get("SELECT refunded_paise FROM orders WHERE id = ?", order.ref).refunded_paise, 149999);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'order.refunded'").n, 1);
  // Nothing left to refund.
  await assert.rejects(refundOrderDb(db, keys, order.ref, { reason: "Again", revoke: true, now: NOW + 23 * 3600 }), ConflictError);
});

test("refunds: refused after 24 hours, over the remaining amount, or across modes", async (t) => {
  const db = await setupDb();
  razorpay(t);
  const env = envFor(db);
  const order = await paidOrder(t, db, env);
  const keys = paymentKeys(env);
  await assert.rejects(
    refundOrderDb(db, keys, order.ref, { reason: "Late", revoke: true, now: NOW + 24 * 3600 + 1 }),
    (err) => err instanceof ConflictError && err.code === "refund_window_closed",
  );
  await assert.rejects(refundOrderDb(db, keys, order.ref, { amountPaise: 200000, reason: "Too much", revoke: false, now: NOW + 60 }), ValidationError);
  await assert.rejects(refundOrderDb(db, keys, order.ref, { amountPaise: 99, reason: "Too little", revoke: false, now: NOW + 60 }), ValidationError);
  await assert.rejects(refundOrderDb(db, keys, order.ref, { reason: "", revoke: false, now: NOW + 60 }), ValidationError);
  await assert.rejects(
    refundOrderDb(db, paymentKeys(LIVE_ENV), order.ref, { reason: "Mode", revoke: false, now: NOW + 60 }),
    (err) => err instanceof ConflictError && err.code === "mode_mismatch",
  );
  assert.equal(db.get("SELECT COUNT(*) AS n FROM refunds").n, 0);
});

test("refunds: a partial pending refund is reserved, then settled by the webhook without revoking", async (t) => {
  const db = await setupDb();
  razorpay(t, {
    routes: {
      "POST /v1/payments/pay_Paid0000000001/refund": (call) => ({ body: refundEntity({ id: "rfnd_Part00000001", payment_id: "pay_Paid0000000001", amount: call.body.amount, status: "pending" }) }),
    },
  });
  const env = envFor(db);
  const order = await paidOrder(t, db, env);
  const keys = paymentKeys(env);
  const refund = await refundOrderDb(db, keys, order.ref, { amountPaise: 50000, reason: "Goodwill", revoke: false, now: NOW + 60 });
  assert.equal(refund.status, "pending");
  // The pending ₹500 is reserved: only ₹999.99 is left to refund.
  await assert.rejects(refundOrderDb(db, keys, order.ref, { amountPaise: 100000, reason: "More", revoke: false, now: NOW + 70 }), ValidationError);
  await handleWebhook(hook("refund.processed", { refund: refundEntity({ id: "rfnd_Part00000001", payment_id: "pay_Paid0000000001", amount: 50000 }) }), env, undefined, NOW + 600);
  const row = db.get("SELECT status, refunded_paise FROM orders WHERE id = ?", order.ref);
  assert.deepEqual({ ...row }, { status: "partially_refunded", refunded_paise: 50000 });
  assert.equal(db.get("SELECT revoked_at FROM enrollments WHERE order_id = ?", order.ref).revoked_at, null);
  assert.equal(db.get("SELECT status FROM refunds").status, "processed");
});

test("refunds: Razorpay says no → failed and released; a lost answer stays pending until sync", async (t) => {
  const db = await setupDb();
  let mode = "refuse";
  razorpay(t, {
    routes: {
      "POST /v1/payments/pay_Paid0000000001/refund": () =>
        mode === "refuse"
          ? { status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: "The refund amount is invalid" } } }
          : (() => {
              throw new Error("timeout");
            })(),
      "GET /v1/payments/pay_Paid0000000001/refunds": () => ({
        body: { items: [refundEntity({ id: "rfnd_Lost00000001", payment_id: "pay_Paid0000000001", amount: 149999, notes: { order_id: "1", refund_id: "2" } })] },
      }),
    },
  });
  const env = envFor(db);
  const order = await paidOrder(t, db, env);
  const keys = paymentKeys(env);
  await assert.rejects(
    refundOrderDb(db, keys, order.ref, { reason: "Test", revoke: true, now: NOW + 60 }),
    (err) => err instanceof ConflictError && err.code === "razorpay_refused" && /refund amount is invalid/.test(err.message),
  );
  assert.equal(db.get("SELECT status FROM refunds WHERE id = 1").status, "failed");
  mode = "timeout";
  const pending = await refundOrderDb(db, keys, order.ref, { reason: "Test", revoke: true, now: NOW + 120 });
  assert.deepEqual([pending.id, pending.status, pending.razorpayRefundId], [2, "pending", null]);
  // "Sync with Razorpay" finds the refund by notes.refund_id and settles it.
  const synced = await syncOrderDb(db, keys, order.ref, NOW + 300);
  assert.equal(synced.status, "refunded");
  assert.deepEqual(synced.refunds.map((r) => [r.id, r.status, r.razorpayRefundId]), [
    [1, "failed", null],
    [2, "processed", "rfnd_Lost00000001"],
  ]);
});

test("refunds: a refund made in Razorpay's dashboard is recorded from the webhook", async (t) => {
  const db = await setupDb();
  razorpay(t);
  const env = envFor(db);
  const order = await paidOrder(t, db, env);
  await handleWebhook(hook("refund.processed", { refund: refundEntity({ id: "rfnd_Dash00000001", payment_id: order.paymentId, amount: 149999 }) }), env, undefined, NOW + 3 * DAY);
  const refund = db.get("SELECT * FROM refunds");
  assert.deepEqual([refund.razorpay_refund_id, refund.status, refund.revoke_access, refund.reason], ["rfnd_Dash00000001", "processed", 1, "Refunded in the Razorpay dashboard"]);
  assert.equal(db.get("SELECT status FROM orders").status, "refunded");
});

test("sync: finds a captured payment the browser never reported, or marks all-failed orders failed", async (t) => {
  const db = await setupDb();
  razorpay(t, {
    routes: {
      "GET /v1/orders/order_Fake0001/payments": { items: [paymentEntity({ id: "pay_Failed000001", status: "failed", order_id: "order_Fake0001" }), paymentEntity({ id: "pay_Late00000001", order_id: "order_Fake0001", amount: 149999 })] },
      "GET /v1/orders/order_Fake0002/payments": { items: [paymentEntity({ id: "pay_Failed000002", status: "failed", order_id: "order_Fake0002", error_description: "Bank declined" })] },
      "GET /v1/payments/pay_Late00000001/refunds": { items: [] },
    },
  });
  const env = envFor(db);
  const keys = paymentKeys(env);
  const a = await newOrder(t, db, env);
  const b = await newOrder(t, db, env, orderBody({ phone: "9811111111", email: "bina@example.com" }));
  const synced = await syncOrderDb(db, keys, a.ref, NOW + 60);
  assert.deepEqual([synced.status, synced.razorpayPaymentId, synced.studentPhoneMasked], ["paid", "pay_Late00000001", "+91 ••••• •3210"]);
  const failed = await syncOrderDb(db, keys, b.ref, NOW + 60);
  assert.deepEqual([failed.status, failed.failureReason], ["failed", "Bank declined"]);
});

test("receipts: on-screen receipt behind an HMAC link, no GSTIN, no phone or email, escaped", async (t) => {
  const db = await setupDb();
  // A GSTIN stored for records must never reach a receipt.
  db.sqlite.exec(`UPDATE settings SET value = json_set(value, '$.gstin', '24ABCDE1234F1Z5') WHERE key = 'business'`);
  db.sqlite.exec("UPDATE settings SET value = 'true' WHERE key = 'legal_confirmed'");
  razorpay(t);
  const env = envFor(db, LIVE_ENV);
  const order = await paidOrder(t, db, env, { body: orderBody({ name: "Asha Patel", coupon: "SAVE20" }) });
  db.sqlite.exec(`UPDATE students SET name = '<img src=x onerror=alert(1)>' WHERE email = 'asha@example.com'`);

  const receipt = await buildReceipt(db, order.ref);
  assert.equal(receipt.kind, "receipt");
  assert.equal(receipt.order.invoiceNo, "FBC/26-27/00001");
  assert.equal(receipt.order.refundableUntil, NOW + 24 * 3600);
  assert.deepEqual(receipt.lines, [
    { label: "Online Basics", amountPaise: 149999 },
    { label: "Coupon SAVE20", amountPaise: -29999 },
    { label: "Total paid", amountPaise: 120000 },
  ]);
  assert.equal(JSON.stringify(receipt).includes("24ABCDE1234F1Z5"), false);
  assert.equal("gstin" in receipt.business, false);

  const path = await receiptPath(env, order.ref);
  const res = await handleReceipt(req(path), env, String(order.ref), NOW + 60);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Referrer-Policy"), "no-referrer");
  assert.match(res.headers.get("Content-Security-Policy"), /script-src 'sha256-[A-Za-z0-9+/=]+'/);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  const html = await res.text();
  assert.ok(html.includes("FBC/26-27/00001"));
  // The buyer's name only: someone who paid with another person's address learns nothing more.
  assert.equal(html.includes("3210"), false, "no phone digits");
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.equal(html.includes("<img src=x"), false);
  assert.equal(html.includes("asha@example.com"), false);
  assert.equal(/gstin|24ABCDE1234F1Z5|GST/i.test(html), false);
  assert.ok(html.includes("Refund requests are accepted until"));
  assert.ok(html.includes("https://courses.feelingsbeautycare.in/learn/online-basics"));
  assert.equal(html.includes("Test payment"), false);

  // Wrong or missing key, another order's key, an unpaid order: the same 404 page.
  const other = await newOrder(t, db, env, orderBody({ phone: "9811111111", email: "bina@example.com" }));
  for (const [url, id] of [
    [`/receipt/${order.ref}?k=${"0".repeat(32)}`, order.ref],
    [`/receipt/${order.ref}`, order.ref],
    [`${(await receiptPath(env, other.ref)).replace(`/${other.ref}?`, `/${order.ref}?`)}`, order.ref],
    [await receiptPath(env, other.ref), other.ref],
  ]) {
    const miss = await handleReceipt(req(url), env, String(id), NOW);
    assert.equal(miss.status, 404, url);
  }
  // No APP_SECRET yet: no receipts at all (never a fixed key).
  const { APP_SECRET, ...noSecret } = env;
  assert.equal((await handleReceipt(req(path), noSecret, String(order.ref), NOW)).status, 404);
});

test("receipts: deposit lines, test banner, refunds listed, admin view", async (t) => {
  const db = await setupDb();
  razorpay(t);
  const env = envFor(db);
  const order = await newOrder(t, db, env, orderBody({ course: "studio-batch", batchId: 111 }));
  await fulfilOrderDb(db, { orderId: order.ref, payment: paymentEntity({ id: "pay_Dep000000001", order_id: order.orderId, amount: 100000 }), now: NOW });
  const receipt = await buildReceipt(db, order.ref);
  assert.deepEqual(receipt.lines, [
    { label: "Studio Batch (November mornings)", amountPaise: 500000 },
    { label: "Booking amount paid online", amountPaise: 100000 },
    { label: "Balance to pay at the studio", amountPaise: 400000 },
  ]);
  const res = await handleReceipt(req(await receiptPath(env, order.ref)), env, String(order.ref), NOW + 25 * 3600);
  const html = await res.text();
  assert.ok(html.includes("Test payment: no real money was charged."));
  assert.ok(html.includes(`TEST-${order.ref}`));
  assert.equal(html.includes("Refund requests are accepted until"), false); // window over
  assert.equal(html.includes("/learn/"), false); // in-person only: nothing to watch
  const admin = await loadAdminOrder(db, order.ref);
  assert.deepEqual([admin.paymentKind, admin.listPricePaise, admin.batchId, admin.refunds.length], ["deposit", 500000, 111, 0]);
});

test("helpers: financial year in India time, phone masking", () => {
  assert.equal(financialYear(Date.UTC(2026, 3, 1, 0, 0) / 1000), "2026-27"); // 1 Apr 05:30 IST
  assert.equal(financialYear(Date.UTC(2026, 2, 31, 18, 29) / 1000), "2025-26"); // 31 Mar 23:59 IST
  assert.equal(financialYear(Date.UTC(2099, 11, 31) / 1000), "2099-00");
  assert.equal(maskPhone("+919876543210"), "+91 ••••• •3210");
  assert.equal(maskPhone("+447700900123"), "•••• 0123");
  assert.equal(maskPhone(null), null);
});

test("refunds: a flagged duplicate payment can be refunded after 24 hours; the first order can't", async (t) => {
  const db = await setupDb();
  razorpay(t, {
    routes: {
      "POST /v1/payments/pay_Dup000000002/refund": (call) => ({ body: refundEntity({ id: "rfnd_Dup00000001", payment_id: "pay_Dup000000002", amount: call.body.amount }) }),
    },
  });
  const env = envFor(db);
  const keys = paymentKeys(env);
  const a = await newOrder(t, db, env);
  const b = await newOrder(t, db, env);
  await fulfilOrderDb(db, { orderId: a.ref, payment: paymentEntity({ id: "pay_Dup000000001", order_id: a.orderId, amount: a.amount }), now: NOW });
  await fulfilOrderDb(db, { orderId: b.ref, payment: paymentEntity({ id: "pay_Dup000000002", order_id: b.orderId, amount: b.amount }), now: NOW });
  const later = NOW + 3 * DAY;
  await assert.rejects(refundOrderDb(db, keys, a.ref, { reason: "Late", revoke: true, now: later }), (err) => err.code === "refund_window_closed");
  const refund = await refundOrderDb(db, keys, b.ref, { reason: "Paid twice", revoke: true, now: later });
  assert.equal(refund.status, "processed");
  // Refunding the duplicate never touches the access the first order gave.
  assert.equal(db.get("SELECT revoked_at FROM enrollments WHERE course_id = 10").revoked_at, null);
});

test("refunds: a full revoking refund of a batch booking gives the seat back", async (t) => {
  const db = await setupDb();
  razorpay(t, {
    routes: {
      "POST /v1/payments/pay_Seat00000001/refund": (call) => ({ body: refundEntity({ id: "rfnd_Seat00000001", payment_id: "pay_Seat00000001", amount: call.body.amount }) }),
    },
  });
  const env = envFor(db);
  const order = await newOrder(t, db, env, orderBody({ course: "studio-batch", batchId: 111 }));
  await fulfilOrderDb(db, { orderId: order.ref, payment: paymentEntity({ id: "pay_Seat00000001", order_id: order.orderId, amount: 100000 }), now: NOW });
  assert.equal(db.get("SELECT seats_taken FROM batches WHERE id = 111").seats_taken, 1);
  await refundOrderDb(db, paymentKeys(env), order.ref, { reason: "Can't come", revoke: true, now: NOW + 3600 });
  assert.equal(db.get("SELECT seats_taken FROM batches WHERE id = 111").seats_taken, 0);
});
