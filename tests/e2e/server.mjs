// The e2e platform: the REAL Functions (functions/, routed like Cloudflare Pages by
// tests/integration/site.mjs) and the REAL built site (dist/), served over HTTPS to a real browser,
// with fakes only at the edges:
//
//   D1        node:sqlite (tests/helpers/d1.mjs), every migration applied, then tests/e2e/world.mjs
//   R2        in memory (tests/helpers/r2.mjs), multipart uploads included
//   email     the real mailer Worker (workers/mailer) with a fake Cloudflare Email Service binding
//             (tests/helpers/mailer.mjs): every message is kept for the tests to read
//   Razorpay  api.razorpay.com answered in-process (orders, payments, refunds); a refund is
//             "processed" by a signed refund.processed webhook a moment later, as Razorpay does
//   deploy    the Pages deploy hook is recorded, never called
//   clock     tests/e2e/clock.mjs: tests move time forward (24-hour refunds, link expiry)
//
//   node --experimental-strip-types --no-warnings --import ./tests/helpers/register.mjs tests/e2e/server.mjs
//
// Ports (env): E2E_HTTPS_PORT (8443) is what the browser uses, with every *.feelingsbeautycare.in
// host mapped to it (playwright.config.mjs). E2E_HTTP_PORT (8790) serves the same site as a dev
// host (the build fetches /api/public/snapshot from it) and the control API under /__e2e/, which
// only the test runner calls. Nothing here is reachable from outside 127.0.0.1.
//
// The client IP: a request's `x-e2e-ip` header becomes CF-Connecting-IP (tests give each browser
// context its own address, so rate limits never leak between journeys).
import "./clock.mjs";
import { clock } from "./clock.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "../helpers/d1.mjs";
import { fakeMailer } from "../helpers/mailer.mjs";
import { createFakeR2 } from "../helpers/r2.mjs";
import { orderEntity, paymentEntity, refundEntity, signPayment, webhook } from "../helpers/razorpay.mjs";
import { createSite } from "../integration/site.mjs";
import { distAssets } from "./assets.mjs";
import { adminPasswordHash, HUB, HUB_HOST, SECRETS, seedSql, VIDEO, VIDEO_KEYS } from "./world.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HTTPS_PORT = Number(process.env.E2E_HTTPS_PORT ?? 8443);
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT ?? 8790);
const DIST = process.env.E2E_DIST ?? join(ROOT, "dist");
const DAY = 86_400;

// ---------------------------------------------------------------- the world

const db = await createTestDb();
db.sqlite.exec(seedSql(clock.now() - 30 * DAY));
const media = createFakeR2({ minPartSize: 1 });
for (const key of VIDEO_KEYS) await media.put(key, VIDEO, { httpMetadata: { contentType: "video/mp4" } });
const mail = fakeMailer();
const env = {
  ...SECRETS,
  ...mail.env,
  DB: db,
  MEDIA: media,
  ASSETS: distAssets(DIST),
  ADMIN_PASSWORD_HASH: adminPasswordHash(),
};
const site = createSite(env);

// ---------------------------------------------------------------- fake Razorpay and deploy hook

const rzp = { orders: new Map(), payments: new Map(), refunds: [], calls: [], webhooks: [] };
const deployHooks = [];
let paymentCount = 0;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Delivers a signed Razorpay webhook to the hub, as Razorpay would. */
async function deliverWebhook(event, entities) {
  const hook = webhook(event, entities, SECRETS.RAZORPAY_WEBHOOK_SECRET);
  const res = await site.fetch(new Request(`${HUB}/api/razorpay/webhook`, { method: "POST", body: hook.body, headers: hook.headers }));
  rzp.webhooks.push({ event, status: res.status });
  return res.status;
}

async function razorpayApi(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/v1/, "");
  const text = request.body ? await request.text() : "";
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = Object.fromEntries(new URLSearchParams(text));
  }
  rzp.calls.push({ method: request.method, path, body });
  let m;
  if (request.method === "POST" && path === "/orders") {
    const id = `order_E2E${String(rzp.orders.size + 1).padStart(10, "0")}`;
    const order = orderEntity({ id, amount: body.amount, amount_due: body.amount, receipt: body.receipt, notes: body.notes ?? {}, created_at: clock.now() });
    rzp.orders.set(id, order);
    return json(200, order);
  }
  if (request.method === "GET" && (m = /^\/orders\/([^/]+)$/.exec(path))) {
    const order = rzp.orders.get(decodeURIComponent(m[1]));
    return order ? json(200, order) : json(400, { error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } });
  }
  if (request.method === "GET" && (m = /^\/orders\/([^/]+)\/payments$/.exec(path))) {
    const items = [...rzp.payments.values()].filter((p) => p.order_id === decodeURIComponent(m[1]));
    return json(200, { entity: "collection", count: items.length, items });
  }
  if (request.method === "GET" && (m = /^\/payments\/([^/]+)$/.exec(path))) {
    const payment = rzp.payments.get(decodeURIComponent(m[1]));
    return payment ? json(200, payment) : json(400, { error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } });
  }
  if (request.method === "GET" && (m = /^\/payments\/([^/]+)\/refunds$/.exec(path))) {
    const items = rzp.refunds.filter((r) => r.payment_id === decodeURIComponent(m[1]));
    return json(200, { entity: "collection", count: items.length, items });
  }
  if (request.method === "POST" && (m = /^\/payments\/([^/]+)\/refund$/.exec(path))) {
    const payment = rzp.payments.get(decodeURIComponent(m[1]));
    if (!payment) return json(400, { error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } });
    const amount = body.amount ?? payment.amount - payment.amount_refunded;
    const refund = refundEntity({
      id: `rfnd_E2E${String(rzp.refunds.length + 1).padStart(10, "0")}`,
      payment_id: payment.id,
      amount,
      notes: body.notes ?? {},
      status: "pending",
      created_at: clock.now(),
    });
    rzp.refunds.push(refund);
    payment.amount_refunded += amount;
    payment.refund_status = payment.amount_refunded >= payment.amount ? "full" : "partial";
    // Razorpay processes the refund and tells the site with a webhook, a moment later.
    setTimeout(() => {
      refund.status = "processed";
      deliverWebhook("refund.processed", { refund: { ...refund }, payment: { ...payment } }).catch((err) => console.error(`e2e: refund webhook failed: ${err}`));
    }, 300);
    return json(200, refund);
  }
  return json(400, { error: { code: "BAD_REQUEST_ERROR", description: `no fake route for ${request.method} ${path}` } });
}

/** Server-side failures (thrown errors, unhandled rejections), for the tests to check. */
const errors = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "api.razorpay.com") return razorpayApi(request);
  if (request.url === SECRETS.DEPLOY_HOOK_URL) {
    deployHooks.push({ at: clock.now() });
    return json(200, { success: true, result: { id: `fake-build-${deployHooks.length}` } });
  }
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(request);
  throw new TypeError(`e2e: the server tried to reach ${url.origin} (not faked)`);
};

/** The buyer paid on Razorpay's checkout: a captured payment, and the handler's signed response. */
function payOrder(orderId, { method = "upi" } = {}) {
  const order = rzp.orders.get(orderId);
  if (!order) return null;
  paymentCount += 1;
  const id = `pay_E2E${String(paymentCount).padStart(10, "0")}`;
  const payment = paymentEntity({
    id,
    order_id: orderId,
    amount: order.amount,
    email: order.notes?.email ?? "buyer@example.com",
    contact: "+919876543210",
    method,
    created_at: clock.now(),
  });
  rzp.payments.set(id, payment);
  order.status = "paid";
  order.amount_paid = order.amount;
  order.amount_due = 0;
  return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: signPayment(orderId, id, SECRETS.RAZORPAY_KEY_SECRET) };
}

// ---------------------------------------------------------------- control API (/__e2e/ on the HTTP port)

async function control(request) {
  const url = new URL(request.url);
  const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
  switch (`${request.method} ${url.pathname}`) {
    case "GET /__e2e/health":
      return json(200, { ok: true, now: clock.now(), dist: existsSync(join(DIST, "index.html")) });
    case "GET /__e2e/mail": {
      const to = url.searchParams.get("to");
      const messages = mail.sent.filter((m) => !to || m.to === to).map((m) => ({ to: m.to, subject: m.subject, text: m.text, html: m.html }));
      return json(200, { messages });
    }
    case "POST /__e2e/clock":
      return json(200, { now: clock.advance(Number(body.advance) || 0) });
    case "POST /__e2e/razorpay/pay": {
      const paid = payOrder(String(body.orderId ?? ""), body);
      return paid ? json(200, paid) : json(404, { error: "unknown order" });
    }
    case "GET /__e2e/razorpay":
      return json(200, { calls: rzp.calls, refunds: rzp.refunds, webhooks: rzp.webhooks, orders: [...rzp.orders.values()] });
    case "GET /__e2e/errors":
      return json(200, { errors });
    case "GET /__e2e/deploy-hooks":
      return json(200, { calls: deployHooks });
    case "POST /__e2e/sql": {
      // Reads for assertions (and small fixture writes). The test runner only.
      const sql = String(body.sql ?? "");
      const params = Array.isArray(body.params) ? body.params : [];
      const rows = /^\s*(select|with)\b/i.test(sql) ? db.rows(sql, ...params) : (db.sqlite.prepare(sql).run(...params), []);
      return json(200, { rows });
    }
    case "GET /__e2e/r2": {
      const prefix = url.searchParams.get("prefix") ?? "";
      return json(200, { keys: [...media.objects.keys()].filter((k) => k.startsWith(prefix)).sort() });
    }
    default:
      return json(404, { error: "no such control route" });
  }
}

// ---------------------------------------------------------------- Node HTTP ↔ fetch

async function toRequest(req, origin) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name.startsWith(":")) continue;
    const lower = name.toLowerCase();
    if (lower === "cf-connecting-ip" || lower === "x-e2e-ip" || lower === "connection" || lower === "keep-alive" || lower === "transfer-encoding") continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const ip = req.headers["x-e2e-ip"];
  headers.set("CF-Connecting-IP", typeof ip === "string" && ip ? ip : "203.0.113.1");
  const method = req.method ?? "GET";
  let body;
  if (method !== "GET" && method !== "HEAD") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }
  return new Request(new URL(req.url ?? "/", origin), { method, headers, body, redirect: "manual" });
}

async function send(res, response, method) {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "set-cookie") continue;
    headers[name] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(response.status, headers);
  if (method === "HEAD" || !response.body) return res.end();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

function handler(kind) {
  return async (req, res) => {
    try {
      const host = String(req.headers.host ?? HUB_HOST);
      const request = await toRequest(req, kind === "https" ? `https://${host.replace(/:\d+$/, "")}` : `http://${host}`);
      const path = new URL(request.url).pathname;
      const response = kind === "http" && path.startsWith("/__e2e/") ? await control(request) : await site.fetch(request);
      await send(res, response, request.method);
    } catch (err) {
      errors.push(String(err?.stack ?? err));
      console.error(`e2e server: ${req.method} ${req.url}: ${err?.stack ?? err}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("e2e server error");
    }
  };
}

// A throwaway self-signed certificate for the *.feelingsbeautycare.in names (the browser is told to
// ignore certificate errors; the point is a secure context, so __Host- cookies work as in production).
function certificate() {
  const dir = join(ROOT, ".e2e");
  mkdirSync(dir, { recursive: true });
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=courses.feelingsbeautycare.in",
      "-addext", "subjectAltName=DNS:feelingsbeautycare.in,DNS:*.feelingsbeautycare.in",
      "-keyout", key, "-out", cert,
    ], { stdio: "ignore" });
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

createHttpsServer(certificate(), handler("https")).listen(HTTPS_PORT, "127.0.0.1", () => {
  console.log(`e2e: https://*.feelingsbeautycare.in → 127.0.0.1:${HTTPS_PORT}`);
});
createHttpServer(handler("http")).listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`e2e: control and dev host on http://127.0.0.1:${HTTP_PORT} (dist: ${DIST})`);
});

process.on("unhandledRejection", (err) => {
  errors.push(String(err?.stack ?? err));
  console.error(`e2e server: unhandled rejection: ${err?.stack ?? err}`);
});
