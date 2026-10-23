// Security review (docs/SECURITY-REVIEW.md): one exploit-style test per finding. Each test plays
// the attack against the real handlers and asserts it fails; the ones marked "regression" check
// that the fix left the honest path working.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleCouponQuote, handleLiveOrder, handleLiveVerify, handleWebhook } from "../../functions/_lib/payments.ts";
import { fulfilOrderDb } from "../../functions/_lib/orders.ts";
import { restoreAccess } from "../../functions/_lib/restore.ts";
import { handleMyReceipt, handleMySession, handleRestore } from "../../functions/_lib/student-api.ts";
import { handleSignin } from "../../functions/_lib/pages/auth.ts";
import { handleReceipt } from "../../functions/_lib/receipts-route.ts";
import { receiptKey } from "../../functions/_lib/receipts.ts";
import { loginRoute } from "../../functions/_lib/admin/routes.ts";
import { postJson, readJson, req } from "../helpers/http.mjs";
import { refundEntity, webhook } from "../helpers/razorpay.mjs";
import * as w2 from "../w2/fixtures.mjs";
import * as w3 from "../w3/fixtures.mjs";
import { adminEnv, callRoute, signIn } from "../w5/fixtures.mjs";
import { createTestDb } from "../helpers/d1.mjs";

const { DAY, NOW } = w2;
const VICTIM_PHONE = "9876543210";

// ---------------------------------------------------------------- F1: account takeover by phone number

/** The victim's own first purchase of course 10, verified: their account now holds a live course. */
async function victimWithCourse(t) {
  const db = await w2.setupDb();
  const env = w2.envFor(db);
  const fake = w2.razorpay(t, {
    payments: {
      pay_Victim00000001: { order_id: "order_Fake0001", amount: 149999, contact: "+919876543210" },
      pay_Mallory0000001: { order_id: "order_Fake0002", amount: 800000, contact: "+919999999999", email: "mallory@example.net" },
    },
  });
  const order = await readJson(await handleLiveOrder(w2.orderRequest(w2.orderBody()), env, NOW));
  const verified = await readJson(await handleLiveVerify(postJson("/api/verify", w2.verifyBody(order.orderId, "pay_Victim00000001")), env, NOW + 60));
  assert.match(verified.redirect, /\/auth\/continue\?t=/, "regression: a first purchase still signs the buyer in");
  return { db, env, fake, victimId: db.get("SELECT student_id FROM orders WHERE id = ?", order.ref).student_id };
}

test("F1: a free course taken with someone else's phone number gives no sign-in link to their account", async (t) => {
  const { db, env, victimId } = await victimWithCourse(t);
  const tokensBefore = db.get("SELECT count(*) AS n FROM login_tokens").n;
  // Mallory knows the victim's number and enrolls in the free course with it.
  const res = await handleLiveOrder(
    w2.orderRequest(w2.orderBody({ course: "free-intro", name: "Mallory", email: "", phone: VICTIM_PHONE }), { ip: "203.0.113.66" }),
    env,
    NOW + DAY,
  );
  assert.equal(res.status, 200);
  const data = await readJson(res);
  assert.equal(data.mode, "free");
  assert.doesNotMatch(data.redirect, /auth\/continue/, "no handoff into the victim's account");
  assert.match(data.redirect, /^https:\/\/courses\.feelingsbeautycare\.in\/signin\?next=/);
  assert.equal(db.get("SELECT count(*) AS n FROM login_tokens").n, tokensBefore, "no login token was issued");
  assert.equal(db.get("SELECT name FROM students WHERE id = ?", victimId).name, "Asha Patel", "the victim's name is untouched");
});

test("F1 regression: a brand-new phone number taking a free course is signed in at once", async (t) => {
  const db = await w2.setupDb();
  w2.razorpay(t);
  const res = await handleLiveOrder(w2.orderRequest(w2.orderBody({ course: "free-intro", phone: "9822222222", email: "" })), { DB: db }, NOW);
  assert.match((await readJson(res)).redirect, /\/auth\/continue\?t=[A-Za-z0-9_-]{43}$/);
});

test("F1: paying for a cheap course with the victim's number neither hands off nor restores into their account", async (t) => {
  const { db, env, victimId } = await victimWithCourse(t);
  const order = await readJson(
    await handleLiveOrder(
      w2.orderRequest(w2.orderBody({ course: "hybrid-pro", name: "Mallory", email: "", phone: VICTIM_PHONE }), { ip: "203.0.113.66" }),
      env,
      NOW + DAY,
    ),
  );
  assert.equal(order.mode, "razorpay");
  assert.equal(db.get("SELECT student_id FROM orders WHERE id = ?", order.ref).student_id, victimId, "the order lands on the victim's account");
  const tokensBefore = db.get("SELECT count(*) AS n FROM login_tokens").n;
  const verify = await handleLiveVerify(postJson("/api/verify", w2.verifyBody(order.orderId, "pay_Mallory0000001")), env, NOW + DAY + 60);
  assert.equal(verify.status, 200);
  const verified = await readJson(verify);
  assert.doesNotMatch(verified.redirect, /auth\/continue/, "verify gives the receipt, not a sign-in link");
  assert.equal(verified.redirect, verified.receipt);
  assert.equal(db.get("SELECT count(*) AS n FROM login_tokens").n, tokensBefore);

  // Restore with Mallory's own payment ID and the victim's number: refused, no session.
  const ip = "198.51.100.200";
  const attempt = await restoreAccess(env, req("/api/auth/restore", { method: "POST", ip }), { contact: VICTIM_PHONE, paymentId: "pay_Mallory0000001" }, NOW + DAY + 120);
  assert.deepEqual(attempt, { ok: false, reason: "use_first_payment" });
  const api = await handleRestore(postJson("/api/auth/restore", { contact: VICTIM_PHONE, paymentId: "pay_Mallory0000001" }, { ip: "198.51.100.201" }), env, NOW + DAY + 130);
  assert.equal(api.status, 409);
  assert.equal(api.headers.get("Set-Cookie"), null);
  const form = new URLSearchParams({ contact: VICTIM_PHONE, paymentId: "pay_Mallory0000001", next: "/account" });
  const page = await handleSignin(
    req("/signin", { method: "POST", body: form.toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" }, ip: "198.51.100.202" }),
    env,
    NOW + DAY + 140,
  );
  assert.equal(page.status, 409);
  assert.equal(page.headers.get("Set-Cookie"), null);
  assert.equal(db.get("SELECT count(*) AS n FROM sessions WHERE student_id = ?", victimId).n, 0);

  // The victim's own (first) payment ID still works.
  const victim = await restoreAccess(env, req("/api/auth/restore", { method: "POST", ip: "198.51.100.203" }), { contact: VICTIM_PHONE, paymentId: "pay_Victim00000001" }, NOW + DAY + 150);
  assert.equal(victim.ok, true);
});

// ---------------------------------------------------------------- F2: IPv6 rotation past per-IP limits

const v6 = (i) => `2001:db8:abcd:12::${i.toString(16)}`;

test("F2: rotating IPv6 addresses inside one /64 doesn't reset the restore limit", async () => {
  const db = await w3.setupDb();
  for (let i = 1; i <= 5; i++) {
    const r = await restoreAccess(w3.env(db), req("/api/auth/restore", { method: "POST", ip: v6(i) }), { contact: `98000000${10 + i}`, paymentId: `pay_Guess000000${i}` }, w3.NOW);
    assert.equal(r.reason, "no_match");
  }
  const sixth = await restoreAccess(w3.env(db), req("/api/auth/restore", { method: "POST", ip: v6(99) }), { contact: "9800000099", paymentId: "pay_Guess00000099" }, w3.NOW);
  assert.equal(sixth.reason, "rate_limited");
});

test("F2: coupon guessing from one /64 is limited like one address", async () => {
  const db = await w2.setupDb();
  const statuses = [];
  for (let i = 1; i <= 21; i++) {
    const res = await handleCouponQuote(postJson("/api/coupon/quote", { course: "online-basics", code: `GUESS${i}` }, { ip: v6(i) }), w2.envFor(db), NOW);
    statuses.push(res.status);
  }
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(200));
  assert.equal(statuses[20], 429);
});

test("F2: admin password guessing from one /64 is limited like one address", async () => {
  const env = adminEnv(await createTestDb());
  const codes = [];
  for (let i = 1; i <= 6; i++) {
    const res = await callRoute(loginRoute, env, "POST", "/api/admin/login", { body: { password: `wrong-guess-${i}` }, ip: v6(i) });
    codes.push(res.status);
  }
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
});

// ---------------------------------------------------------------- F3: webhook replay with a fresh event id

test("F3: a signed webhook replayed under a new X-Razorpay-Event-Id changes nothing", async (t) => {
  const db = await w2.setupDb();
  const env = w2.envFor(db);
  w2.razorpay(t);
  const order = await readJson(await handleLiveOrder(w2.orderRequest(), env, NOW));
  const payment = w2.paymentEntity({ id: "pay_Replay00000001", order_id: order.orderId, amount: order.amount });
  assert.equal((await fulfilOrderDb(db, { orderId: order.ref, payment, now: NOW })).ok, true);
  const send = async (event, entities, eventId, at) => {
    const { body, headers } = webhook(event, entities, w2.TEST_ENV.RAZORPAY_WEBHOOK_SECRET, { eventId });
    return handleWebhook(req("/api/razorpay/webhook", { method: "POST", body, headers, origin: null }), env, undefined, at);
  };
  const refund = { refund: refundEntity({ id: "rfnd_Replay0000001", payment_id: payment.id, amount: order.amount }) };
  assert.equal((await send("refund.processed", refund, "evt_Original00001", NOW + 3600)).status, 200);
  // Same signed body, new (unsigned) event id: stored as a new event, but applies nothing twice.
  assert.equal((await send("refund.processed", refund, "evt_Replayed00001", NOW + 7200)).status, 200);
  assert.equal(db.get("SELECT refunded_paise FROM orders WHERE id = ?", order.ref).refunded_paise, order.amount);
  assert.equal(db.get("SELECT count(*) AS n FROM audit_log WHERE action = 'order.refunded'").n, 1);
  // An old payment.captured replayed after the refund doesn't bring the access back.
  assert.equal((await send("payment.captured", { payment }, "evt_Replayed00002", NOW + 9000)).status, 200);
  assert.equal(db.get("SELECT status FROM orders WHERE id = ?", order.ref).status, "refunded");
  assert.notEqual(db.get("SELECT revoked_at FROM enrollments WHERE order_id = ?", order.ref).revoked_at, null);
});

// ---------------------------------------------------------------- IDOR: receipts and devices

test("IDOR: a student can't read another student's receipt or sign out their device", async () => {
  const db = await w3.setupDb();
  const env = { ...w3.env(db), APP_SECRET: w2.TEST_ENV.APP_SECRET };
  const asha = await w3.sessionCookie(db, w3.ASHA.id);
  const bina = await w3.sessionCookie(db, w3.BINA.id);
  const ashaSession = db.get("SELECT id FROM sessions WHERE student_id = ?", w3.ASHA.id).id;

  const mine = await handleMyReceipt("1")(req("/api/me/orders/1", { cookie: asha }), env, w3.NOW);
  assert.equal(mine.status, 200);
  const theirs = await handleMyReceipt("1")(req("/api/me/orders/1", { cookie: bina }), env, w3.NOW);
  assert.equal(theirs.status, 404);

  const kick = await handleMySession(String(ashaSession))(req(`/api/me/sessions/${ashaSession}`, { method: "DELETE", cookie: bina }), env, w3.NOW);
  assert.equal(kick.status, 404);
  assert.equal(db.get("SELECT revoked_at FROM sessions WHERE id = ?", ashaSession).revoked_at, null);

  // The receipt page: order 1's key never opens order 3 (and a missing key never opens anything).
  const key1 = await receiptKey(env, 1);
  assert.equal((await handleReceipt(req(`/receipt/1?k=${key1}`), env, "1", w3.NOW)).status, 200);
  assert.equal((await handleReceipt(req(`/receipt/3?k=${key1}`), env, "3", w3.NOW)).status, 404);
  assert.equal((await handleReceipt(req("/receipt/1"), env, "1", w3.NOW)).status, 404);
});

// ---------------------------------------------------------------- admin authz on every route

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = path.resolve(here, "../../functions/api/admin");

/** Every route file under functions/api/admin as a request path ([id] and [n] become 1). */
function adminPaths(dir = ADMIN_DIR, prefix = "/api/admin") {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...adminPaths(full, `${prefix}/${name.replace(/^\[.+\]$/, "1")}`));
    } else if (name.endsWith(".ts") && name !== "_middleware.ts") {
      const base = name.slice(0, -3).replace(/^\[.+\]$/, "1");
      out.push(base === "index" ? prefix : `${prefix}/${base}`);
    }
  }
  return out;
}

test("admin: every route under /api/admin refuses a missing session and a cross-site write", async () => {
  const env = adminEnv(await createTestDb());
  const cookie = await signIn(env);
  const reached = () => new Response("reached", { status: 200 });
  const paths = adminPaths();
  assert.ok(paths.length >= 40, `found ${paths.length} admin routes`);
  for (const p of paths) {
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      if (p === "/api/admin/login" && method === "POST") continue;
      const anon = await callRoute(reached, env, method, p, { body: method === "GET" ? undefined : {} });
      assert.equal(anon.status, 401, `${method} ${p} without a session`);
      if (method === "GET") continue;
      const cross = await callRoute(reached, env, method, p, { body: {}, cookie, origin: "https://evil.feelingsbeautycare.in" });
      assert.equal(cross.status, 403, `${method} ${p} from a sibling subdomain`);
      const noOrigin = await callRoute(reached, env, method, p, { body: {}, cookie, origin: null });
      assert.equal(noOrigin.status, 403, `${method} ${p} without Origin`);
    }
    const wrongHost = await callRoute(reached, env, "GET", `https://myshop.feelingsbeautycare.in${p}`, { cookie });
    assert.equal(wrongHost.status, 404, `GET ${p} on a course host`);
  }
});
