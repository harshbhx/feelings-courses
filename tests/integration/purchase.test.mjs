// W8 integration: the whole purchase path through the real Functions files (tests/integration/
// site.mjs routes requests like Pages does), on a D1 shim, a fake R2 and a fake Razorpay. No real
// keys: every secret here is made up.
//
//   buy on the course's own host → verify → the hub signs the buyer in (W3 handoff) → receipt (W2)
//   → course area (W3) → signed video (W4) → refund within 24 hours from the admin (W5 → W2)
//   → Razorpay's refund webhook → access gone everywhere.
//
// The clock is node:test's mock Date, so the 24-hour window and the 60-second media check are
// exact, whatever day the suite runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createTestDb } from "../helpers/d1.mjs";
import { createFakeR2 } from "../helpers/r2.mjs";
import { fakeAssets, cookiesFrom, readJson, req } from "../helpers/http.mjs";
import { fakeRazorpay, orderEntity, paymentEntity, refundEntity, signPayment, webhook } from "../helpers/razorpay.mjs";
import { resetMigrationState } from "../../functions/_lib/migrate.ts";
import { resetHostState } from "../../functions/_lib/hosts.ts";
import { resetLiveChecks } from "../../functions/_lib/media-serve.ts";
import { createSite } from "./site.mjs";

const HUB = "https://courses.feelingsbeautycare.in";
const COURSE_HOST = "https://glow.feelingsbeautycare.in";
/** 23 Oct 2026, 11:30 IST. */
const NOW = Date.UTC(2026, 9, 23, 6, 0, 0) / 1000;
const HOUR = 3600;
const DAY = 86_400;
const PASSWORD = "Integration-Admin-Password-2026";
const ENV = Object.freeze({
  RAZORPAY_KEY_ID: "rzp_live_FakeIntegration01",
  RAZORPAY_KEY_SECRET: "fake_integration_key_secret_only",
  RAZORPAY_WEBHOOK_SECRET: "fake_integration_webhook_secret",
  APP_SECRET: "fake_integration_app_secret_0123456789abcdef",
});
const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 1, 2, 3, 4]);
const BUYER = { name: "Asha Patel", phone: "9876543210", email: "asha@example.com" };
const PHONE_IP = "203.0.113.7";

async function setup(t) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW * 1000 });
  resetMigrationState();
  resetHostState();
  resetLiveChecks();
  const db = await createTestDb();
  const past = NOW - 30 * DAY;
  db.sqlite.exec(`
    INSERT INTO courses (id, slug, title, format, price_paise, access_days, certificate_title, status, published_at, created_at, updated_at)
    VALUES (30, 'glow', 'Glow Makeup', 'online', 149900, 365, 'Glow Makeup certificate', 'published', ${past}, ${past}, ${past});
    INSERT INTO modules (id, course_id, position, title, created_at, updated_at) VALUES (300, 30, 1, 'Base', ${past}, ${past});
    INSERT INTO lessons (id, course_id, module_id, position, slug, title, minutes, video_provider, video_ref, duration_seconds, created_at, updated_at)
    VALUES
      (3001, 30, 300, 1, 'prep', 'Skin prep', 6, 'r2', 'videos/2026/10/0123456789abcdef-skin-prep.mp4', 360, ${past}, ${past}),
      (3002, 30, 300, 2, 'base', 'Base and concealer', 8, 'r2', 'videos/2026/10/fedcba9876543210-base.mp4', 480, ${past}, ${past});
    INSERT INTO coupons (id, code, percent_off, amount_off_paise, course_id, max_uses, used_count, active, allow_free, created_at, updated_at)
    VALUES
      (30, 'WELCOME10', 10, NULL, 30, NULL, 0, 1, 0, ${past}, ${past}),
      (31, 'GIFTGLOW', 100, NULL, 30, 5, 0, 1, 1, ${past}, ${past});
    UPDATE settings SET value = 'true' WHERE key = 'legal_confirmed';
    UPDATE settings SET value = json_set(value, '$.gstin', '24ABCDE1234F1Z5') WHERE key = 'business';
  `);
  const media = createFakeR2();
  await media.put("videos/2026/10/0123456789abcdef-skin-prep.mp4", VIDEO, { httpMetadata: { contentType: "video/mp4" } });
  const assets = fakeAssets({
    "/c/glow": { body: "<!doctype html><title>Glow Makeup</title><h1>Glow Makeup</h1>", headers: { "Content-Type": "text/html; charset=utf-8" } },
    "/domains.json": JSON.stringify({ active: ["glow"] }),
  });
  const env = {
    ...ENV,
    DB: db,
    MEDIA: media,
    ASSETS: assets,
    ADMIN_PASSWORD_HASH: createHmac("sha256", ENV.APP_SECRET).update(PASSWORD).digest("hex"),
  };
  // Razorpay: orders on demand; payments and refunds get routes as the test registers payments
  // (fakeRazorpay looks routes up at call time). Refunds start "pending", as Razorpay's do.
  let orderCount = 0;
  const refunds = [];
  const routes = {
    "POST /v1/orders": (call) => {
      orderCount += 1;
      const id = `order_Glow${String(orderCount).padStart(8, "0")}`;
      return { body: orderEntity({ id, amount: call.body.amount, amount_due: call.body.amount, receipt: call.body.receipt, notes: call.body.notes }) };
    },
  };
  const rzp = fakeRazorpay(t, routes);
  const site = createSite(env);
  const clock = {
    now: () => Math.floor(Date.now() / 1000),
    advance: (seconds) => t.mock.timers.tick(seconds * 1000),
  };
  return { db, env, site, routes, refunds, rzp, clock, payments: new Map() };
}

/** A captured payment for `order` (what Razorpay's API answers once the buyer paid). */
function pay(ctx, order, id) {
  const entity = paymentEntity({ id, order_id: order.orderId, amount: order.amount, contact: "+919876543210", email: BUYER.email, method: "upi" });
  ctx.payments.set(id, entity);
  ctx.routes[`GET /v1/payments/${id}`] = entity;
  ctx.routes[`POST /v1/payments/${id}/refund`] = (call) => {
    const refund = refundEntity({
      id: `rfnd_Glow${String(ctx.refunds.length + 1).padStart(8, "0")}`,
      payment_id: id,
      amount: call.body.amount,
      notes: call.body.notes,
      status: "pending",
    });
    ctx.refunds.push(refund);
    return { body: refund };
  };
  return { razorpay_order_id: order.orderId, razorpay_payment_id: id, razorpay_signature: signPayment(order.orderId, id, ENV.RAZORPAY_KEY_SECRET) };
}

const cookieHeader = (res, name = "__Host-fbc_s") => {
  const c = cookiesFrom(res)[name];
  return c ? `${name}=${c.value}` : null;
};

async function adminCookie(site) {
  const res = await site.fetch(req(`${HUB}/api/admin/login`, { body: { password: PASSWORD }, ip: "198.51.100.9" }));
  assert.equal(res.status, 200, `admin login: ${res.status}`);
  return cookieHeader(res, "__Host-fbc_admin");
}

/** Buys the course on its own host and follows the redirects to the receipt. */
async function buy(ctx, { coupon, paymentId = "pay_GlowPaid0000001" } = {}) {
  const { site } = ctx;
  const order = await site.fetch(
    req(`${COURSE_HOST}/api/order`, { body: { course: "glow", consent: true, ...BUYER, ...(coupon && { coupon }) }, ip: PHONE_IP }),
  );
  assert.equal(order.status, 200, `order: ${order.status}`);
  const placed = await readJson(order);
  assert.equal(placed.mode, "razorpay");
  const verify = await site.fetch(req(`${COURSE_HOST}/api/verify`, { body: pay(ctx, placed, paymentId) }));
  assert.equal(verify.status, 200, `verify: ${verify.status}`);
  const verified = await readJson(verify);
  return { placed, verified };
}

/** Follows the verify redirect: the hub's handoff sets the session cookie and lands on the receipt. */
async function signInFromHandoff(site, redirect) {
  const res = await site.fetch(req(redirect, { headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130.0" } }));
  assert.equal(res.status, 303);
  const cookie = cookieHeader(res);
  assert.ok(cookie, "the handoff sets the student session cookie");
  // pageRedirect answers with a path on the hub.
  return { cookie, location: new URL(res.headers.get("Location"), HUB).href };
}

const media = (url, cookie, extra = {}) =>
  req(url, { cookie, headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "video", Referer: `${HUB}/learn/glow/prep`, ...extra } });

test("buy on the course host → receipt → learn → refund within 24 hours → access removed", async (t) => {
  const ctx = await setup(t);
  const { site, db, clock } = ctx;

  // The course's own host serves its landing page at /.
  const landing = await site.fetch(req(`${COURSE_HOST}/`));
  assert.equal(landing.status, 200);
  assert.match(await landing.text(), /Glow Makeup/);

  // Coupon quote, then the order: priced on the server from D1 (10% off ₹1,499 = ₹1,349.10).
  const quote = await readJson(await site.fetch(req(`${COURSE_HOST}/api/coupon/quote`, { body: { course: "glow", code: "welcome10" }, ip: PHONE_IP })));
  assert.deepEqual(quote, { ok: true, listPaise: 149900, discountPaise: 14990, amountPaise: 134910, label: "10% off", free: false });
  const { placed, verified } = await buy(ctx, { coupon: "WELCOME10" });
  assert.equal(placed.amount, 134910);
  assert.equal(placed.testMode, false);
  assert.equal(ctx.rzp.calls.find((c) => c.path === "/v1/orders").body.amount, 134910, "Razorpay was asked for the server's amount");

  // Verify answers with the hub's one-time sign-in (W3), which lands on the receipt (W2).
  assert.match(verified.redirect, /^https:\/\/courses\.feelingsbeautycare\.in\/auth\/continue\?t=[A-Za-z0-9_-]{43}$/);
  assert.match(verified.receipt, new RegExp(`^${HUB}/receipt/${placed.ref}\\?k=[0-9a-f]{32}$`));
  const { cookie, location } = await signInFromHandoff(site, verified.redirect);
  assert.equal(new URL(location).pathname + new URL(location).search, new URL(verified.receipt).pathname + new URL(verified.receipt).search);
  // The handoff link works once.
  const again = await site.fetch(req(verified.redirect));
  assert.equal(cookiesFrom(again)["__Host-fbc_s"], undefined);

  // The receipt: consecutive invoice number, masked phone, no GSTIN, a way into the course.
  const receipt = await site.fetch(req(new URL(location, HUB).href));
  assert.equal(receipt.status, 200);
  assert.equal(receipt.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const receiptHtml = await receipt.text();
  assert.match(receiptHtml, /FBC\/26-27\/00001/);
  assert.match(receiptHtml, /Start learning/);
  assert.match(receiptHtml, /href="https:\/\/courses\.feelingsbeautycare\.in\/learn\/glow"/);
  assert.doesNotMatch(receiptHtml, /GSTIN|24ABCDE1234F1Z5/i);
  assert.doesNotMatch(receiptHtml, /9876543210/);

  // The account lists the payment with its receipt; the API returns the same receipt.
  const account = await (await site.fetch(req(`${HUB}/account`, { cookie }))).text();
  assert.match(account, /Glow Makeup/);
  assert.match(account, new RegExp(`href="/receipt/${placed.ref}\\?k=[0-9a-f]{32}"`));
  const mine = await site.fetch(req(`${HUB}/api/me/orders/${placed.ref}`, { cookie }));
  assert.equal(mine.status, 200);
  const mineJson = await readJson(mine);
  assert.equal(mineJson.order.id, placed.ref);
  assert.equal(mineJson.order.refundableUntil, clock.now() + 24 * HOUR);
  assert.doesNotMatch(JSON.stringify(mineJson), /gstin/i);

  // The course area and a signed video (W3 → W4 → R2).
  const learn = await site.fetch(req(`${HUB}/learn/glow`, { cookie }));
  assert.equal(learn.status, 200);
  assert.match(await learn.text(), /Skin prep/);
  const play = await site.fetch(req(`${HUB}/api/learn/glow/lessons/3001/play`, { cookie }));
  assert.equal(play.status, 200);
  const { src } = await readJson(play);
  const video = await site.fetch(media(new URL(src, HUB).href, cookie, { Range: "bytes=0-7" }));
  assert.equal(video.status, 206);
  assert.deepEqual(new Uint8Array(await video.arrayBuffer()), VIDEO.slice(0, 8));
  // The same link from another browser (no cookie) is refused.
  assert.equal((await site.fetch(media(new URL(src, HUB).href, undefined))).status, 403);

  // Two hours later the student asks for a refund; the admin refunds with "remove access".
  clock.advance(2 * HOUR);
  const admin = await adminCookie(site);
  const refund = await site.fetch(
    req(`${HUB}/api/admin/orders/${placed.ref}/refund`, { body: { reason: "Asked within 24 hours", revoke: true }, cookie: admin }),
  );
  assert.equal(refund.status, 201, `refund: ${refund.status}`);
  assert.equal((await readJson(refund)).status, "pending");
  assert.equal(ctx.refunds.length, 1);
  assert.equal(ctx.refunds[0].amount, 134910);

  // Razorpay confirms it with the refund.processed webhook (signed, delivered to the hub).
  const processed = { ...ctx.refunds[0], status: "processed" };
  const hook = webhook("refund.processed", { refund: processed }, ENV.RAZORPAY_WEBHOOK_SECRET);
  const delivered = await site.fetch(req(`${HUB}/api/razorpay/webhook`, { method: "POST", body: hook.body, headers: hook.headers, origin: null }));
  assert.equal(delivered.status, 200);
  assert.deepEqual({ ...db.get("SELECT status, refunded_paise FROM orders WHERE id = ?", placed.ref) }, { status: "refunded", refunded_paise: 134910 });

  // Access is gone: the course area, the play API and (after the 60-second check cache) the video.
  const afterLearn = await site.fetch(req(`${HUB}/learn/glow`, { cookie }));
  assert.notEqual(afterLearn.status, 200);
  assert.doesNotMatch(await afterLearn.text(), /Skin prep/);
  assert.equal((await site.fetch(req(`${HUB}/api/learn/glow/lessons/3001/play`, { cookie }))).status, 404);
  clock.advance(61);
  assert.equal((await site.fetch(media(new URL(src, HUB).href, cookie, { Range: "bytes=0-7" }))).status, 403);

  // The receipt now says Refunded and no longer offers the course.
  const refundedReceipt = await (await site.fetch(req(new URL(location, HUB).href))).text();
  assert.match(refundedReceipt, /Refunded/);
  assert.doesNotMatch(refundedReceipt, /Start learning/);
  const me = await readJson(await site.fetch(req(`${HUB}/api/me`, { cookie })));
  assert.equal(me.enrollments.find((e) => e.courseSlug === "glow")?.active ?? false, false);
});

test("refunds are refused after 24 hours and access stays", async (t) => {
  const ctx = await setup(t);
  const { site, db, clock } = ctx;
  const { placed, verified } = await buy(ctx);
  const { cookie } = await signInFromHandoff(site, verified.redirect);
  clock.advance(24 * HOUR + 1);
  const admin = await adminCookie(site);
  const late = await site.fetch(req(`${HUB}/api/admin/orders/${placed.ref}/refund`, { body: { reason: "Too late", revoke: true }, cookie: admin }));
  assert.equal(late.status, 409);
  assert.equal((await readJson(late)).error, "refund_window_closed");
  assert.equal(ctx.refunds.length, 0, "Razorpay was never asked");
  assert.equal(db.get("SELECT status FROM orders WHERE id = ?", placed.ref).status, "paid");
  assert.equal((await site.fetch(req(`${HUB}/learn/glow`, { cookie }))).status, 200);
});

test("a free coupon enrolls without Razorpay and signs the buyer in on the hub", async (t) => {
  const ctx = await setup(t);
  const { site, db } = ctx;
  const res = await site.fetch(req(`${COURSE_HOST}/api/order`, { body: { course: "glow", consent: true, coupon: "GIFTGLOW", ...BUYER }, ip: PHONE_IP }));
  assert.equal(res.status, 200);
  const free = await readJson(res);
  assert.equal(free.mode, "free");
  assert.equal(ctx.rzp.calls.length, 0);
  const { cookie, location } = await signInFromHandoff(site, free.redirect);
  assert.equal(location, `${HUB}/learn/glow`);
  assert.equal((await site.fetch(req(`${HUB}/learn/glow`, { cookie }))).status, 200);
  assert.equal(db.get("SELECT source FROM enrollments WHERE course_id = 30").source, "coupon_free");
  // A second order while access lasts is refused, with or without a coupon.
  const twice = await site.fetch(req(`${COURSE_HOST}/api/order`, { body: { course: "glow", consent: true, ...BUYER }, ip: PHONE_IP }));
  assert.equal(twice.status, 409);
  assert.equal((await readJson(twice)).error, "already_enrolled");
});

test("the webhook can arrive before verify: one enrollment, one invoice number", async (t) => {
  const ctx = await setup(t);
  const { site, db } = ctx;
  const order = await readJson(await site.fetch(req(`${COURSE_HOST}/api/order`, { body: { course: "glow", consent: true, ...BUYER }, ip: PHONE_IP })));
  const ids = pay(ctx, order, "pay_GlowEarly000001");
  const payment = ctx.payments.get("pay_GlowEarly000001");
  const hook = webhook("payment.captured", { payment }, ENV.RAZORPAY_WEBHOOK_SECRET);
  assert.equal((await site.fetch(req(`${HUB}/api/razorpay/webhook`, { method: "POST", body: hook.body, headers: hook.headers, origin: null }))).status, 200);
  // The same delivery again changes nothing.
  assert.equal((await site.fetch(req(`${HUB}/api/razorpay/webhook`, { method: "POST", body: hook.body, headers: hook.headers, origin: null }))).status, 200);
  const verify = await site.fetch(req(`${COURSE_HOST}/api/verify`, { body: ids }));
  assert.equal(verify.status, 200);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM enrollments WHERE course_id = 30").n, 1);
  assert.deepEqual(db.rows("SELECT invoice_no FROM orders WHERE status = 'paid'").map((r) => r.invoice_no), ["FBC/26-27/00001"]);
});

test("course hosts keep the account, the receipt and the admin on the hub", async (t) => {
  const { site } = await setup(t);
  for (const path of ["/account", "/signin", "/learn/glow", "/receipt/1?k=00", "/auth/continue?t=x", "/admin"]) {
    const res = await site.fetch(req(`${COURSE_HOST}${path}`));
    assert.equal(res.status, 302, path);
    assert.equal(res.headers.get("Location"), `${HUB}${path}`, path);
  }
  for (const path of ["/api/me", "/api/me/orders/1", "/api/admin/orders", "/api/auth/restore", "/api/razorpay/webhook"]) {
    const res = await site.fetch(req(`${COURSE_HOST}${path}`, { method: path.endsWith("restore") || path.endsWith("webhook") ? "POST" : "GET", body: path.endsWith("restore") || path.endsWith("webhook") ? {} : undefined }));
    assert.equal(res.status, 404, path);
  }
  // The receipt is private: never indexed or framed.
  const receipt = await site.fetch(req(`${HUB}/receipt/1?k=00`));
  assert.equal(receipt.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.equal(receipt.headers.get("X-Frame-Options"), "DENY");
  const robots = await (await site.fetch(req(`${HUB}/robots.txt`))).text();
  assert.match(robots, /Disallow: \/receipt\//);
  // Once the domain is active, the hub's /c/glow moves to the course host.
  const moved = await site.fetch(req(`${HUB}/c/glow`));
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get("Location"), `${COURSE_HOST}/`);
});

test("admin backups (W5 routes over W7's backup.ts): run one, then download the newest", async (t) => {
  const { site, db, clock } = await setup(t);
  const admin = await adminCookie(site);
  // The admin API's first request of the day also started W7's daily job (cleanup + backup).
  await Promise.all(site.waitUntil);
  assert.equal(db.get("SELECT value FROM settings WHERE key = 'last_backup_at'").value, String(NOW));
  clock.advance(60);
  const run = await site.fetch(req(`${HUB}/api/admin/backup/run`, { body: {}, cookie: admin }));
  assert.equal(run.status, 200);
  const result = await readJson(run);
  assert.equal(result.ok, true);
  assert.equal(result.key, "backups/d1/2026-10-23T06-01-00Z.sql.gz");
  assert.equal(db.get("SELECT value FROM settings WHERE key = 'last_backup_at'").value, String(NOW + 60));
  const download = await site.fetch(req(`${HUB}/api/admin/backup`, { cookie: admin }));
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("Content-Type"), "application/gzip");
  assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="2026-10-23T06-01-00Z.sql.gz"', "the newest dump");
  const sql = await new Response(download.body.pipeThrough(new DecompressionStream("gzip"))).text();
  assert.match(sql, /INSERT INTO "?courses"?/);
  assert.doesNotMatch(sql, /INSERT INTO "?sessions"?/, "sessions are never backed up");
  assert.deepEqual(db.rows("SELECT action FROM audit_log WHERE action LIKE 'backup.%' ORDER BY id").map((r) => r.action), ["backup.run", "backup.download"]);
  // Without the admin cookie: nothing.
  assert.equal((await site.fetch(req(`${HUB}/api/admin/backup`))).status, 401);
});
