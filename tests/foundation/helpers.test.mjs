// Self-tests for the test helpers in tests/helpers (r2, razorpay, http).
//
//   node --experimental-strip-types --no-warnings --test tests/foundation/helpers.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { FakeR2, createFakeR2 } from "../helpers/r2.mjs";
import { fakeRazorpay, paymentEntity, orderEntity, refundEntity, signPayment, webhook } from "../helpers/razorpay.mjs";
import { SITE, req, postJson, postForm, context, fakeAssets, cookiesFrom, readJson } from "../helpers/http.mjs";

const md5 = (s) => createHash("md5").update(s).digest("hex");
const ALPHABET = "abcdefghijklmnopqrstuvwxyz"; // 26 bytes

// ---------- R2 ----------

test("r2: put / get / head / delete", async () => {
  const r2 = createFakeR2();
  assert.ok(r2 instanceof FakeR2);
  const put = await r2.put("a.txt", "hello", { httpMetadata: { contentType: "text/plain" }, customMetadata: { lesson: "1" } });
  assert.equal(put.size, 5);
  assert.equal(put.etag, md5("hello"));
  assert.equal(put.httpEtag, `"${md5("hello")}"`);

  const got = await r2.get("a.txt");
  assert.equal(await got.text(), "hello");
  assert.equal(got.customMetadata.lesson, "1");
  assert.ok(got.uploaded instanceof Date);
  const h = new Headers();
  got.writeHttpMetadata(h);
  assert.equal(h.get("content-type"), "text/plain");

  const head = await r2.head("a.txt");
  assert.equal(head.size, 5);
  assert.equal("body" in head, false);

  assert.equal(await r2.get("missing"), null);
  assert.equal(await r2.head("missing"), null);

  await r2.delete("a.txt");
  assert.equal(await r2.get("a.txt"), null);
  assert.equal(r2.objects.size, 0);
});

test("r2: put accepts ArrayBuffer, Uint8Array, Blob and ReadableStream; body is a stream", async () => {
  const r2 = createFakeR2();
  await r2.put("ab", new TextEncoder().encode("xy").buffer);
  await r2.put("u8", new Uint8Array([1, 2, 3]));
  await r2.put("blob", new Blob(["blob!"]));
  await r2.put("stream", new Response("streamed").body);
  assert.equal(await (await r2.get("ab")).text(), "xy");
  assert.deepEqual([...new Uint8Array(await (await r2.get("u8")).arrayBuffer())], [1, 2, 3]);
  assert.equal(await (await r2.get("blob")).text(), "blob!");
  const s = await r2.get("stream");
  assert.ok(s.body instanceof ReadableStream);
  assert.equal(await new Response(s.body).text(), "streamed");
  await r2.put("j", JSON.stringify({ ok: true }));
  assert.deepEqual(await (await r2.get("j")).json(), { ok: true });
});

test("r2: delete many and list with prefix, limit and cursor", async () => {
  const r2 = createFakeR2();
  for (const k of ["v/1", "v/2", "v/3", "w/1", "x"]) await r2.put(k, k);
  const all = await r2.list({ prefix: "v/" });
  assert.deepEqual(all.objects.map((o) => o.key), ["v/1", "v/2", "v/3"]);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.delimitedPrefixes, []);

  const page1 = await r2.list({ prefix: "v/", limit: 2 });
  assert.deepEqual(page1.objects.map((o) => o.key), ["v/1", "v/2"]);
  assert.equal(page1.truncated, true);
  const page2 = await r2.list({ prefix: "v/", limit: 2, cursor: page1.cursor });
  assert.deepEqual(page2.objects.map((o) => o.key), ["v/3"]);
  assert.equal(page2.truncated, false);
  assert.equal(page2.cursor, undefined);

  await r2.delete(["v/1", "v/2"]);
  assert.deepEqual((await r2.list()).objects.map((o) => o.key), ["v/3", "w/1", "x"]);
});

test("r2: range as an object", async () => {
  const r2 = createFakeR2();
  await r2.put("abc", ALPHABET);
  const a = await r2.get("abc", { range: { offset: 2, length: 3 } });
  assert.equal(await a.text(), "cde");
  assert.deepEqual(a.range, { offset: 2, length: 3 });
  assert.equal(a.size, 26); // size is the whole object
  const b = await r2.get("abc", { range: { offset: 24 } });
  assert.equal(await b.text(), "yz");
  const c = await r2.get("abc", { range: { suffix: 3 } });
  assert.equal(await c.text(), "xyz");
  assert.deepEqual(c.range, { offset: 23, length: 3 });
  await assert.rejects(r2.get("abc", { range: { offset: 26 } }), /10039/);
});

test("r2: range from request Headers (bytes=0-9, bytes=10-, bytes=-5)", async () => {
  const r2 = createFakeR2();
  await r2.put("abc", ALPHABET);
  const first = await r2.get("abc", { range: new Headers({ Range: "bytes=0-9" }) });
  assert.equal(await first.text(), "abcdefghij");
  assert.deepEqual(first.range, { offset: 0, length: 10 });

  const open = await r2.get("abc", { range: new Headers({ Range: "bytes=10-" }) });
  assert.equal(await open.text(), ALPHABET.slice(10));
  assert.deepEqual(open.range, { offset: 10, length: 16 });

  const suffix = await r2.get("abc", { range: new Headers({ Range: "bytes=-5" }) });
  assert.equal(await suffix.text(), "vwxyz");
  assert.deepEqual(suffix.range, { offset: 21, length: 5 });

  const none = await r2.get("abc", { range: new Headers() });
  assert.equal(none.range, undefined);
  assert.equal(await none.text(), ALPHABET);
});

test("r2: onlyIf via Headers and object; failed precondition → object without body", async () => {
  const r2 = createFakeR2();
  const { httpEtag, etag } = await r2.put("v", "video-bytes");

  const notModified = await r2.get("v", { onlyIf: new Headers({ "If-None-Match": httpEtag }) });
  assert.ok(notModified);
  assert.equal("body" in notModified, false);
  assert.equal(notModified.etag, etag);

  const changed = await r2.get("v", { onlyIf: new Headers({ "If-None-Match": '"other"' }) });
  assert.equal(await changed.text(), "video-bytes");

  const ifMatchFail = await r2.get("v", { onlyIf: new Headers({ "If-Match": '"other"' }) });
  assert.equal("body" in ifMatchFail, false);

  const future = new Date(Date.now() + 60_000).toUTCString();
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal("body" in (await r2.get("v", { onlyIf: new Headers({ "If-Modified-Since": future }) })), false);
  assert.equal("body" in (await r2.get("v", { onlyIf: new Headers({ "If-Modified-Since": past }) })), true);
  assert.equal("body" in (await r2.get("v", { onlyIf: new Headers({ "If-Unmodified-Since": past }) })), false);

  assert.equal("body" in (await r2.get("v", { onlyIf: { etagMatches: etag } })), true);
  assert.equal("body" in (await r2.get("v", { onlyIf: { etagDoesNotMatch: etag } })), false);
  assert.equal("body" in (await r2.get("v", { onlyIf: { uploadedAfter: new Date(Date.now() + 60_000) } })), false);
});

test("r2: multipart upload, complete in partNumber order", async () => {
  const r2 = new FakeR2({ minPartSize: 4 });
  const mpu = await r2.createMultipartUpload("big.mp4", { httpMetadata: { contentType: "video/mp4" } });
  assert.equal(mpu.key, "big.mp4");
  assert.ok(r2.uploads.has(mpu.uploadId));
  const p2 = await mpu.uploadPart(2, "efgh");
  const p1 = await mpu.uploadPart(1, "abcd");
  const p3 = await mpu.uploadPart(3, "ij");
  assert.deepEqual(p1, { partNumber: 1, etag: md5("abcd") });

  const obj = await mpu.complete([p3, p1, p2]);
  assert.equal(obj.size, 10);
  const got = await r2.get("big.mp4");
  assert.equal(await got.text(), "abcdefghij");
  assert.equal(got.httpMetadata.contentType, "video/mp4");

  assert.equal(r2.uploads.has(mpu.uploadId), false);
  await assert.rejects(mpu.uploadPart(4, "more"), /does not exist/);
  await assert.rejects(mpu.complete([p1]), /does not exist/);
});

test("r2: multipart checks parts and minimum size; abort; resume by uploadId", async () => {
  const r2 = new FakeR2({ minPartSize: 4 });
  const mpu = await r2.createMultipartUpload("x");
  const p1 = await mpu.uploadPart(1, "ab"); // too small for a non-last part
  const p2 = await mpu.uploadPart(2, "cdef");
  await assert.rejects(mpu.complete([p1, p2]), /minimum part size/);
  await assert.rejects(mpu.complete([p2, { partNumber: 9, etag: "nope" }]), /not uploaded/);

  const resumed = r2.resumeMultipartUpload("x", mpu.uploadId);
  assert.equal(resumed.uploadId, mpu.uploadId);
  const p1b = await resumed.uploadPart(1, "abcd");
  await resumed.complete([p1b, p2]);
  assert.equal(await (await r2.get("x")).text(), "abcdcdef");

  const other = await r2.createMultipartUpload("y");
  await other.uploadPart(1, "zz");
  await other.abort();
  await assert.rejects(other.abort(), /does not exist/);
  await assert.rejects(r2.resumeMultipartUpload("y", other.uploadId).uploadPart(1, "a"), /does not exist/);
  assert.equal(await r2.get("y"), null);

  // The default minimum is 5 MiB.
  const strict = createFakeR2();
  const s = await strict.createMultipartUpload("s");
  const a = await s.uploadPart(1, "small");
  const b = await s.uploadPart(2, "end");
  await assert.rejects(s.complete([a, b]), /minimum part size/);
});

// ---------- Razorpay ----------

test("razorpay: records calls, decodes basic auth, answers routes", async (t) => {
  const { calls } = fakeRazorpay(t, {
    "POST /v1/orders": orderEntity({ amount: 100 }),
    "GET /v1/payments/pay_1": (call) => ({ status: 400, body: { error: { code: "BAD_REQUEST_ERROR", seen: call.path } } }),
    "POST /v1/payments/pay_1/refund": new Error("network down"),
  });
  const auth = "Basic " + Buffer.from("rzp_test_key:sekrit").toString("base64");

  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: 100, currency: "INR" }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).amount, 100);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/v1/orders");
  assert.equal(calls[0].url, "https://api.razorpay.com/v1/orders");
  assert.deepEqual(calls[0].body, { amount: 100, currency: "INR" });
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.deepEqual(calls[0].auth, { keyId: "rzp_test_key", keySecret: "sekrit" });

  const bad = await fetch("https://api.razorpay.com/v1/payments/pay_1?expand[]=card");
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.seen, "/v1/payments/pay_1");
  assert.equal(calls[1].auth, null);
  assert.equal(calls[1].body, null);

  await assert.rejects(fetch("https://api.razorpay.com/v1/payments/pay_1/refund", { method: "POST" }), /network down/);

  const form = await fetch("https://api.razorpay.com/v1/nothing", { method: "POST", body: new URLSearchParams({ a: "1" }) });
  assert.equal(form.status, 404);
  assert.deepEqual(await form.json(), { error: { code: "BAD_REQUEST_ERROR", description: "no fake route" } });
  assert.deepEqual(calls.at(-1).body, { a: "1" });
  assert.equal(calls.length, 4);

  await assert.rejects(fetch("https://example.com/"), /unexpected fetch/);
});

test("razorpay: fetch is restored after the test", async (t) => {
  const before = globalThis.fetch;
  await t.test("inner", (tt) => {
    fakeRazorpay(tt, {});
    assert.notEqual(globalThis.fetch, before);
  });
  assert.equal(globalThis.fetch, before);
});

test("razorpay: entity builders", () => {
  const p = paymentEntity({ amount: 5 });
  assert.equal(p.id, "pay_FakePayment001");
  assert.equal(p.status, "captured");
  assert.equal(p.order_id, "order_FakeOrder0001");
  assert.equal(p.amount, 5);
  assert.equal(p.method, "upi");
  assert.equal(typeof p.created_at, "number");
  assert.equal(orderEntity().entity, "order");
  assert.equal(refundEntity().payment_id, "pay_FakePayment001");
});

test("razorpay: signPayment and webhook signatures verify", () => {
  const sig = signPayment("order_A", "pay_B", "s3cret");
  assert.equal(sig, createHmac("sha256", "s3cret").update("order_A|pay_B").digest("hex"));

  const wh = webhook("payment.captured", { payment: paymentEntity(), order: orderEntity() }, "whsec", { eventId: "evt_1" });
  assert.equal(wh.headers["X-Razorpay-Signature"], createHmac("sha256", "whsec").update(wh.body).digest("hex"));
  assert.equal(wh.headers["X-Razorpay-Event-Id"], "evt_1");
  assert.equal(wh.headers["Content-Type"], "application/json");
  const body = JSON.parse(wh.body);
  assert.equal(body.entity, "event");
  assert.equal(body.event, "payment.captured");
  assert.deepEqual(body.contains, ["payment", "order"]);
  assert.equal(body.payload.payment.entity.id, "pay_FakePayment001");
  assert.equal(body.payload.order.entity.entity, "order");
  assert.ok(webhook("x", {}, "s").headers["X-Razorpay-Event-Id"].startsWith("evt_"));
});

// ---------- HTTP ----------

test("http: req, postJson, postForm", async () => {
  const get = req("/learn", { cookie: "sid=1", ip: "203.0.113.7" });
  assert.equal(get.url, `${SITE}/learn`);
  assert.equal(get.method, "GET");
  assert.equal(get.headers.get("origin"), null);
  assert.equal(get.headers.get("cookie"), "sid=1");
  assert.equal(get.headers.get("cf-connecting-ip"), "203.0.113.7");

  const pj = postJson("/api/order", { a: 1 });
  assert.equal(pj.method, "POST");
  assert.equal(pj.headers.get("content-type"), "application/json");
  assert.equal(pj.headers.get("origin"), SITE);
  assert.deepEqual(await pj.json(), { a: 1 });

  assert.equal(postJson("/x", {}, { origin: null }).headers.get("origin"), null);
  assert.equal(postJson("/x", {}, { origin: "https://evil.example" }).headers.get("origin"), "https://evil.example");
  assert.equal(req("/x", { host: "preview.pages.dev" }).url, "https://preview.pages.dev/x");

  const pf = postForm("/api/verify", { razorpay_payment_id: "pay_1" });
  assert.equal(pf.headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(await pf.text(), "razorpay_payment_id=pay_1");
});

test("http: context records next and waitUntil", async () => {
  const ctx = context({ request: req("/learn/a"), env: { X: 1 }, params: { slug: "a" } });
  assert.equal(ctx.functionPath, "/learn/a");
  assert.deepEqual(ctx.data, {});
  const res = await ctx.next();
  assert.equal(await res.text(), "next");
  assert.equal(ctx.nextCalls.length, 1);
  ctx.waitUntil(Promise.resolve(42));
  assert.deepEqual(await Promise.all(ctx.waitUntilPromises), [42]);
  ctx.passThroughOnException();

  const custom = context({ next: () => new Response("custom", { status: 201 }) });
  assert.equal((await custom.next()).status, 201);
  assert.equal(custom.nextCalls.length, 1);
});

test("http: fakeAssets, cookiesFrom, readJson", async () => {
  const assets = fakeAssets({ "/index.html": "<h1>hi</h1>", "/gone": { body: "x", status: 410, headers: { "X-A": "1" } } });
  const ok = await assets.fetch(`${SITE}/index.html`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "<h1>hi</h1>");
  assert.match(ok.headers.get("content-type"), /text\/html/);
  const gone = await assets.fetch(new Request(`${SITE}/gone`));
  assert.equal(gone.status, 410);
  assert.equal(gone.headers.get("x-a"), "1");
  assert.equal((await assets.fetch(`${SITE}/nope`)).status, 404);
  assert.deepEqual(assets.requests, ["/index.html", "/gone", "/nope"]);

  const headers = new Headers();
  headers.append("Set-Cookie", "sid=abc=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600");
  headers.append("Set-Cookie", "old=; Max-Age=0");
  const cookies = cookiesFrom(new Response(null, { headers }));
  assert.equal(cookies.sid.value, "abc=");
  assert.deepEqual(cookies.sid.attributes, { path: "/", httponly: true, secure: true, samesite: "Lax", "max-age": "3600" });
  assert.equal(cookies.old.attributes["max-age"], "0");

  assert.deepEqual(await readJson(Response.json({ ok: true })), { ok: true });
  await assert.rejects(readJson(new Response("oops", { status: 500 })), /not JSON: oops/);
});
