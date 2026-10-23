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
import { cookiesFrom, readJson, req } from "../helpers/http.mjs";
import { webhook } from "../helpers/razorpay.mjs";
import { adminCookie, buy, BUYER, COURSE_HOST, ENV, HOUR, HUB, NOW, pay, PHONE_IP, setup, signInFromHandoff, VIDEO } from "./world.mjs";

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

  // The receipt: consecutive invoice number, no phone, no GSTIN, a way into the course.
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

test("email identity end to end: the receipt email, then a second device signs in with an emailed link", async (t) => {
  const ctx = await setup(t);
  const { site, mail, db } = ctx;
  const { verified } = await buy(ctx, {});
  await signInFromHandoff(site, verified.redirect);
  await Promise.all(site.waitUntil);
  const receipt = mail.sent.find((m) => m.subject.startsWith("Payment received"));
  assert.ok(receipt, "the receipt email went out");
  assert.equal(receipt.to, BUYER.email);
  assert.equal(receipt.from.email, "courses@feelingsbeautycare.in");

  // A second phone: /signin on the hub (a course host sends it there), then the emailed link.
  const fromCourse = await site.fetch(req(`${COURSE_HOST}/signin`));
  assert.equal(fromCourse.status, 302);
  const form = new URLSearchParams({ email: BUYER.email, next: "/learn/glow" }).toString();
  const asked = await site.fetch(req(`${HUB}/signin`, { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded" }, ip: "198.51.100.77" }));
  assert.equal(asked.status, 200);
  assert.match(await asked.text(), /Check your email/);
  await Promise.all(site.waitUntil);
  const link = mail.lastLink(BUYER.email);
  assert.ok(link);
  const confirm = await site.fetch(req(link));
  assert.equal(confirm.status, 200, "a GET only shows Continue");
  const go = await site.fetch(req(`${HUB}/auth/continue`, { method: "POST", body: new URLSearchParams({ t: mail.tokenOf(link) }).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
  assert.equal(go.status, 303);
  assert.equal(go.headers.get("Location"), "/learn/glow");
  const cookie = cookiesFrom(go)["__Host-fbc_s"];
  assert.equal((await site.fetch(req(`${HUB}/learn/glow`, { cookie: `__Host-fbc_s=${cookie.value}` }))).status, 200);
  assert.equal(db.get("SELECT count(*) AS n FROM email_verifications").n, 1);
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
  for (const path of ["/api/me", "/api/me/orders/1", "/api/admin/orders", "/api/auth/email-link", "/api/razorpay/webhook"]) {
    const res = await site.fetch(req(`${COURSE_HOST}${path}`, { method: path.endsWith("email-link") || path.endsWith("webhook") ? "POST" : "GET", body: path.endsWith("email-link") || path.endsWith("webhook") ? {} : undefined }));
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
