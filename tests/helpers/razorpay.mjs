// A fake Razorpay API (replaces globalThis.fetch for one test), plus entity and signature builders.
//
//   import { fakeRazorpay, paymentEntity, orderEntity, signPayment, webhook } from "../helpers/razorpay.mjs";
//   test("capture", async (t) => {
//     const { calls } = fakeRazorpay(t, {
//       "POST /v1/orders": orderEntity({ amount: 299900 }),            // plain JSON → 200
//       "GET /v1/payments/pay_FakePayment001": paymentEntity(),
//       "POST /v1/payments/pay_X/refund": new Error("network down"),   // thrown by fetch
//       "GET /v1/orders/order_X": (call) => ({ status: 400, body: { error: { code: "BAD_REQUEST_ERROR" } } }),
//     });
//     ...
//     assert.equal(calls[0].auth.keyId, "rzp_test_xxx");
//   });
//   const sig = signPayment("order_A", "pay_B", secret);            // checkout handler signature
//   const { body, headers } = webhook("payment.captured", { payment: paymentEntity() }, webhookSecret);
//
// Unmatched api.razorpay.com requests answer 404 BAD_REQUEST_ERROR; other hosts throw unless
// { passThrough: true } is given. The original fetch is restored by t.after().
// Each recorded call: { method, path, query, url, headers, body, auth: { keyId, keySecret } | null }.

import { createHmac, randomBytes } from "node:crypto";

const RAZORPAY_HOST = "api.razorpay.com";
const FAKE_CREATED_AT = 1761200000; // a fixed unix time, so snapshots stay stable

function urlOf(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url; // Request
}

function parseBody(text, contentType) {
  if (!text) return null;
  if (contentType.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch {
    if (contentType === "" && /^[^{\[]*=/.test(text)) return Object.fromEntries(new URLSearchParams(text));
    return text;
  }
}

function decodeBasicAuth(header) {
  const m = /^Basic\s+(.+)$/i.exec(header ?? "");
  if (!m) return null;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  return i === -1 ? { keyId: decoded, keySecret: "" } : { keyId: decoded.slice(0, i), keySecret: decoded.slice(i + 1) };
}

const jsonResponse = (status, body, headers = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/**
 * Replaces globalThis.fetch for the test `t`.
 * @param {import("node:test").TestContext} t
 * @param {Record<string, unknown>} routes  "METHOD /v1/path" → JSON body | Error | (call) => ({ status, body, headers })
 * @param {{ passThrough?: boolean }} [options]
 * @returns {{ calls: object[] }}
 */
export function fakeRazorpay(t, routes = {}, { passThrough = false } = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (input, init = undefined) => {
    const url = new URL(urlOf(input));
    if (url.hostname !== RAZORPAY_HOST) {
      if (passThrough) return realFetch(input, init);
      throw new Error(`fakeRazorpay: unexpected fetch to ${url.href}`);
    }
    const request = new Request(input, init);
    const headers = Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v]));
    const text = request.body ? await request.text() : "";
    const call = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      url: url.href,
      headers,
      body: parseBody(text, headers["content-type"] ?? ""),
      auth: decodeBasicAuth(headers.authorization),
    };
    calls.push(call);

    const route = routes[`${call.method} ${call.path}`];
    if (route === undefined) {
      return jsonResponse(404, { error: { code: "BAD_REQUEST_ERROR", description: "no fake route" } });
    }
    if (route instanceof Error) throw route;
    if (typeof route === "function") {
      const { status = 200, body, headers: extra } = (await route(call)) ?? {};
      return jsonResponse(status, body, extra);
    }
    return jsonResponse(200, route);
  };

  t.after(() => {
    globalThis.fetch = realFetch;
  });
  return { calls };
}

/** A captured Razorpay payment entity. */
export const paymentEntity = (overrides = {}) => ({
  id: "pay_FakePayment001",
  entity: "payment",
  amount: 299900,
  currency: "INR",
  status: "captured",
  order_id: "order_FakeOrder0001",
  invoice_id: null,
  international: false,
  method: "upi",
  amount_refunded: 0,
  refund_status: null,
  captured: true,
  description: null,
  email: "buyer@example.com",
  contact: "+919876543210",
  notes: {},
  fee: 0,
  tax: 0,
  error_code: null,
  error_description: null,
  created_at: FAKE_CREATED_AT,
  ...overrides,
});

/** A Razorpay order entity (status "created" unless overridden). */
export const orderEntity = (overrides = {}) => ({
  id: "order_FakeOrder0001",
  entity: "order",
  amount: 299900,
  amount_paid: 0,
  amount_due: 299900,
  currency: "INR",
  receipt: "rcpt_fake_0001",
  offer_id: null,
  status: "created",
  attempts: 0,
  notes: {},
  created_at: FAKE_CREATED_AT,
  ...overrides,
});

/** A processed Razorpay refund entity. */
export const refundEntity = (overrides = {}) => ({
  id: "rfnd_FakeRefund001",
  entity: "refund",
  amount: 299900,
  currency: "INR",
  payment_id: "pay_FakePayment001",
  notes: {},
  receipt: null,
  acquirer_data: {},
  status: "processed",
  speed_processed: "normal",
  speed_requested: "normal",
  created_at: FAKE_CREATED_AT,
  ...overrides,
});

/** The checkout signature: hex HMAC-SHA256 of `${orderId}|${paymentId}`. */
export const signPayment = (orderId, paymentId, secret) =>
  createHmac("sha256", secret).update(`${orderId}|${paymentId}`).digest("hex");

/**
 * A signed Razorpay webhook delivery.
 * @param {string} event                       e.g. "payment.captured"
 * @param {Record<string, object>} payloadEntities  e.g. { payment: paymentEntity(), order: orderEntity() }
 * @param {string} secret                      the webhook secret
 * @param {{ eventId?: string }} [options]
 * @returns {{ body: string, headers: Record<string, string> }}
 */
export function webhook(event, payloadEntities, secret, { eventId = `evt_Fake${randomBytes(6).toString("hex")}` } = {}) {
  const payload = Object.fromEntries(Object.entries(payloadEntities).map(([name, entity]) => [name, { entity }]));
  const body = JSON.stringify({
    entity: "event",
    account_id: "acc_Fake",
    event,
    contains: Object.keys(payloadEntities),
    payload,
    created_at: FAKE_CREATED_AT,
  });
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Razorpay-Signature": createHmac("sha256", secret).update(body).digest("hex"),
      "X-Razorpay-Event-Id": eventId,
    },
  };
}
