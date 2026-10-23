// The integration "world" shared by the tests in this folder: one published course (glow) on its
// own host, a D1 shim, a fake R2 and a fake Razorpay, routed through the real Functions files by
// site.mjs, with node:test's mocked Date. No real keys: every secret here is made up.
import { fakeMailer } from "../helpers/mailer.mjs";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createTestDb } from "../helpers/d1.mjs";
import { createFakeR2 } from "../helpers/r2.mjs";
import { fakeAssets, cookiesFrom, readJson, req } from "../helpers/http.mjs";
import { fakeRazorpay, orderEntity, paymentEntity, refundEntity, signPayment } from "../helpers/razorpay.mjs";
import { resetMigrationState } from "../../functions/_lib/migrate.ts";
import { resetHostState } from "../../functions/_lib/hosts.ts";
import { resetLiveChecks } from "../../functions/_lib/media-serve.ts";
import { createSite } from "./site.mjs";

export const HUB = "https://courses.feelingsbeautycare.in";
export const COURSE_HOST = "https://glow.feelingsbeautycare.in";
/** 23 Oct 2026, 11:30 IST. */
export const NOW = Date.UTC(2026, 9, 23, 6, 0, 0) / 1000;
export const HOUR = 3600;
export const DAY = 86_400;
export const PASSWORD = "Integration-Admin-Password-2026";
export const ENV = Object.freeze({
  RAZORPAY_KEY_ID: "rzp_live_FakeIntegration01",
  RAZORPAY_KEY_SECRET: "fake_integration_key_secret_only",
  RAZORPAY_WEBHOOK_SECRET: "fake_integration_webhook_secret",
  APP_SECRET: "fake_integration_app_secret_0123456789abcdef",
});
export const VIDEO = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50, 1, 2, 3, 4]);
export const BUYER = { name: "Asha Patel", phone: "9876543210", email: "asha@example.com" };
export const PHONE_IP = "203.0.113.7";

export async function setup(t) {
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
  // Email through the real mailer Worker with a fake Email Service (tests/helpers/mailer.mjs).
  const mail = fakeMailer();
  const env = {
    ...ENV,
    ...mail.env,
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
  return { db, env, site, routes, refunds, rzp, clock, mail, payments: new Map() };
}

/** A captured payment for `order` (what Razorpay's API answers once the buyer paid). */
export function pay(ctx, order, id) {
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

export const cookieHeader = (res, name = "__Host-fbc_s") => {
  const c = cookiesFrom(res)[name];
  return c ? `${name}=${c.value}` : null;
};

export async function adminCookie(site) {
  const res = await site.fetch(req(`${HUB}/api/admin/login`, { body: { password: PASSWORD }, ip: "198.51.100.9" }));
  assert.equal(res.status, 200, `admin login: ${res.status}`);
  return cookieHeader(res, "__Host-fbc_admin");
}

/** Buys the course on its own host and follows the redirects to the receipt. */
export async function buy(ctx, { coupon, paymentId = "pay_GlowPaid0000001" } = {}) {
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
export async function signInFromHandoff(site, redirect) {
  const res = await site.fetch(req(redirect, { headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130.0" } }));
  assert.equal(res.status, 303);
  const cookie = cookieHeader(res);
  assert.ok(cookie, "the handoff sets the student session cookie");
  // pageRedirect answers with a path on the hub.
  return { cookie, location: new URL(res.headers.get("Location"), HUB).href };
}
