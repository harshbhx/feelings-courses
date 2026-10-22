// W4: admin uploads to R2 (functions/_lib/uploads.ts) through the route files and
// functions/_lib/media-routes.ts (admin check, CSRF, content types, error mapping).

import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as startRoute } from "../../functions/api/admin/uploads/index.ts";
import { onRequest as partRoute } from "../../functions/api/admin/uploads/[id]/parts/[n].ts";
import { onRequest as completeRoute } from "../../functions/api/admin/uploads/[id]/complete.ts";
import { onRequest as deleteRoute } from "../../functions/api/admin/uploads/[id]/index.ts";
import { onRequest as listRoute } from "../../functions/api/admin/media.ts";
import { UPLOAD_PART_SIZE } from "../../functions/_lib/config.ts";
import { isAdmin } from "../../functions/_lib/media-routes.ts";
import { SITE, context, req } from "../helpers/http.mjs";
import { setup, mp4Bytes, NOW } from "./fixtures.mjs";

const ADMIN = { admin: { sessionId: 1 } };
const PART = UPLOAD_PART_SIZE;

function call(route, request, env, params = {}, data = ADMIN) {
  return route(context({ request, env, params, data }));
}

const start = (env, body, opts = {}) => call(startRoute, req("/api/admin/uploads", { method: "POST", body, ...opts }), env, {}, opts.data);

function putPart(env, id, n, bytes, { contentType = "application/octet-stream", length, origin, data } = {}) {
  const headers = { "Content-Type": contentType };
  if (length !== null) headers["Content-Length"] = String(length ?? bytes.byteLength);
  const request = req(`/api/admin/uploads/${id}/parts/${n}`, { method: "PUT", body: bytes, headers, origin });
  return call(partRoute, request, env, { id: String(id), n: String(n) }, data);
}

const complete = (env, id, parts) => call(completeRoute, req(`/api/admin/uploads/${id}/complete`, { method: "POST", body: { parts } }), env, { id: String(id) });
const del = (env, id, query = "") => call(deleteRoute, req(`/api/admin/uploads/${id}${query}`, { method: "DELETE" }), env, { id: String(id) });
const list = (env, query = "") => call(listRoute, req(`/api/admin/media${query}`), env);

const videoBody = (size, extra = {}) => ({ kind: "video", filename: "Lesson one.mp4", size, contentType: "video/mp4", ...extra });

/** Uploads `bytes` as a video (all parts) and returns { init, etags }. */
async function uploadAll(env, bytes, extra = {}) {
  const res = await start(env, videoBody(bytes.byteLength, extra));
  assert.equal(res.status, 201);
  const init = await res.json();
  const etags = [];
  for (let n = 1; (n - 1) * init.partSize < bytes.byteLength; n++) {
    const chunk = bytes.slice((n - 1) * init.partSize, n * init.partSize);
    const put = await putPart(env, init.id, n, chunk);
    assert.equal(put.status, 200, `part ${n}`);
    etags.push({ partNumber: n, etag: (await put.json()).etag });
  }
  return { init, etags };
}

// ---------- auth and request shape ----------

test("admin endpoints are closed without W5's admin context", async () => {
  const { env } = await setup();
  assert.equal(isAdmin(undefined), false);
  assert.equal(isAdmin({ admin: true }), false);
  assert.equal(isAdmin({ admin: { sessionId: 1 } }), true);
  const res = await start(env, videoBody(100), { data: {} });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "unauthorized");
  assert.equal((await call(listRoute, req("/api/admin/media"), env, {}, {})).status, 401);
  assert.equal((await putPart(env, 1, 1, new Uint8Array(1), { data: {} })).status, 401);
  assert.equal((await call(deleteRoute, req("/api/admin/uploads/1", { method: "DELETE" }), env, { id: "1" }, {})).status, 401);
});

test("cross-site, wrong method and wrong content type are refused", async () => {
  const { env } = await setup();
  assert.equal((await start(env, videoBody(100), { origin: "https://evil.example" })).status, 403);
  assert.equal((await call(startRoute, req("/api/admin/uploads"), env)).status, 405);
  const form = req("/api/admin/uploads", { method: "POST", body: "kind=video", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  assert.equal((await call(startRoute, form, env)).status, 415);
  const { init } = { init: await (await start(env, videoBody(100))).json() };
  assert.equal((await putPart(env, init.id, 1, mp4Bytes(100), { contentType: "text/plain" })).status, 415);
  assert.equal((await putPart(env, init.id, 1, mp4Bytes(100), { origin: "https://evil.example" })).status, 403);
});

test("start: 503 until R2 is bound", async () => {
  const { env } = await setup();
  const res = await start({ ...env, MEDIA: undefined }, videoBody(100));
  assert.equal(res.status, 503);
});

// ---------- start ----------

test("start: validates and records the upload", async () => {
  const { env, db, r2 } = await setup();
  const res = await start(env, videoBody(PART + 100, { lessonId: 2 }));
  assert.equal(res.status, 201);
  const init = await res.json();
  assert.equal(init.partSize, PART);
  assert.match(init.key, /^videos\/\d{4}\/\d{2}\/[0-9a-f]{16}-lesson-one\.mp4$/);
  assert.ok(r2.uploads.has(init.uploadId));
  const row = db.get("SELECT * FROM media WHERE id = ?", init.id);
  assert.equal(row.status, "uploading");
  assert.equal(row.kind, "video");
  assert.equal(row.size_bytes, PART + 100);
  assert.equal(row.lesson_id, 2);
  assert.equal(row.upload_id, init.uploadId);
  assert.equal(db.get("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").action, "media.upload_start");
});

test("start: refuses bad files with field errors", async () => {
  const { env, r2 } = await setup();
  const cases = [
    [videoBody(100, { contentType: "video/quicktime", filename: "IMG_0001.MOV" }), 400, "upload_invalid", "contentType"],
    [videoBody(100, { contentType: "text/html", filename: "x.html" }), 400, "upload_invalid", "contentType"],
    [videoBody(5 * 1024 * 1024 * 1024), 413, "upload_too_large", "size"],
    [videoBody(100, { lessonId: 9999 }), 400, "upload_invalid", "lessonId"],
    [videoBody(100, { lessonId: "abc" }), 400, "upload_invalid", "lessonId"],
    [{ kind: "image", filename: "a.png", size: 10, contentType: "image/png", lessonId: 1 }, 400, "upload_invalid", "lessonId"],
    [{ kind: "image", filename: "a.svg", size: 10, contentType: "image/svg+xml" }, 400, "upload_invalid", "contentType"],
  ];
  for (const [body, status, code, field] of cases) {
    const res = await start(env, body);
    assert.equal(res.status, status, JSON.stringify(body));
    const json = await res.json();
    assert.equal(json.error, code);
    assert.ok(json.fields[field], `${field} in ${JSON.stringify(json.fields)}`);
  }
  assert.equal(r2.uploads.size, 0, "no R2 upload left behind");
});

// ---------- parts and complete ----------

test("a two-part video: upload, complete, attach to the lesson", async () => {
  const { env, db, r2 } = await setup({ video: false });
  const bytes = mp4Bytes(PART + 1234);
  const { init, etags } = await uploadAll(env, bytes, { lessonId: 1 });
  const res = await complete(env, init.id, etags);
  assert.equal(res.status, 200);
  const item = await res.json();
  assert.equal(item.status, "ready");
  assert.equal(item.sizeBytes, PART + 1234);
  assert.equal(item.lessonId, 1);
  assert.equal(item.publicUrl, null);
  assert.deepEqual(new Uint8Array(r2.objects.get(init.key).bytes), bytes);
  assert.equal(r2.objects.get(init.key).httpMetadata.contentType, "video/mp4");
  const lesson = db.get("SELECT video_provider, video_ref FROM lessons WHERE id = 1");
  assert.deepEqual({ ...lesson }, { video_provider: "r2", video_ref: init.key });
  assert.equal(db.get("SELECT upload_id FROM media WHERE id = ?", init.id).upload_id, null);
  // complete again (a retry after a lost answer) gives the same item.
  const again = await complete(env, init.id, etags);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).id, init.id);
  // Parts can't be sent to a finished upload.
  assert.equal((await putPart(env, init.id, 1, bytes.slice(0, PART))).status, 409);
});

test("replacing a lesson's video detaches the old media row", async () => {
  const { env, db } = await setup({ video: false });
  const first = await uploadAll(env, mp4Bytes(500), { lessonId: 1 });
  assert.equal((await complete(env, first.init.id, first.etags)).status, 200);
  const second = await uploadAll(env, mp4Bytes(600), { lessonId: 1 });
  assert.equal((await complete(env, second.init.id, second.etags)).status, 200);
  assert.equal(db.get("SELECT lesson_id FROM media WHERE id = ?", first.init.id).lesson_id, null);
  assert.equal(db.get("SELECT lesson_id FROM media WHERE id = ?", second.init.id).lesson_id, 1);
  assert.equal(db.get("SELECT video_ref FROM lessons WHERE id = 1").video_ref, second.init.key);
});

test("parts: exact sizes, valid numbers, Content-Length required, first bytes checked", async () => {
  const { env, db } = await setup();
  const init = await (await start(env, videoBody(PART + 10))).json();
  const before = db.get("SELECT updated_at FROM media WHERE id = ?", init.id).updated_at;
  const code = async (res) => [res.status, (await res.json()).error];
  assert.deepEqual(await code(await putPart(env, init.id, 1, mp4Bytes(PART - 1))), [400, "upload_invalid"]);
  assert.deepEqual(await code(await putPart(env, init.id, 2, mp4Bytes(11))), [400, "upload_invalid"]);
  assert.deepEqual(await code(await putPart(env, init.id, 3, mp4Bytes(10))), [400, "upload_invalid"]);
  assert.deepEqual(await code(await putPart(env, init.id, 0, mp4Bytes(10))), [400, "upload_invalid"]);
  assert.deepEqual(await code(await putPart(env, init.id, 2, mp4Bytes(10), { length: 99 })), [400, "upload_invalid"]);
  assert.deepEqual(await code(await putPart(env, init.id, 2, mp4Bytes(10), { length: null })), [411, "bad_request"]);
  assert.deepEqual(await code(await putPart(env, 999, 1, mp4Bytes(10))), [404, "not_found"]);
  const html = new Uint8Array(PART);
  html.set(new TextEncoder().encode("<!doctype html><script>alert(1)</script>"));
  assert.deepEqual(await code(await putPart(env, init.id, 1, html)), [415, "upload_invalid"]);
  // A good part 2 (the remainder) is accepted and keeps the upload fresh for W7's cleanup.
  const ok = await putPart(env, init.id, 2, mp4Bytes(10));
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).etag);
  assert.ok(db.get("SELECT updated_at FROM media WHERE id = ?", init.id).updated_at >= before);
});

test("complete: every part exactly once, matching etags, and the declared size", async () => {
  const { env } = await setup();
  const bytes = mp4Bytes(PART + 10);
  const { init, etags } = await uploadAll(env, bytes);
  const bad = async (parts) => {
    const res = await complete(env, init.id, parts);
    return [res.status, (await res.json()).error];
  };
  assert.deepEqual(await bad([etags[0]]), [400, "upload_invalid"]);
  assert.deepEqual(await bad([etags[0], etags[0]]), [400, "upload_invalid"]);
  assert.deepEqual(await bad([etags[0], { partNumber: 3, etag: "x" }]), [400, "upload_invalid"]);
  assert.deepEqual(await bad("nope"), [400, "upload_invalid"]);
  assert.deepEqual(await bad([etags[0], { partNumber: 2, etag: "wrong" }]), [409, "upload_invalid"]);
  // Order doesn't matter.
  const res = await complete(env, init.id, [etags[1], etags[0]]);
  assert.equal(res.status, 200);
});

test("complete: a part re-sent with other bytes is the one kept (resume)", async () => {
  const { env, r2 } = await setup();
  const init = await (await start(env, videoBody(PART + 10))).json();
  const p1 = mp4Bytes(PART);
  await putPart(env, init.id, 1, p1);
  await putPart(env, init.id, 2, new Uint8Array(10).fill(1));
  const second = await putPart(env, init.id, 2, new Uint8Array(10).fill(2));
  const etag1 = r2.uploads.get(init.uploadId).parts.get(1).etag;
  const res = await complete(env, init.id, [
    { partNumber: 1, etag: etag1 },
    { partNumber: 2, etag: (await second.json()).etag },
  ]);
  assert.equal(res.status, 200);
  assert.equal(r2.objects.get(init.key).bytes.at(-1), 2);
});

test("images: one part, a public URL once ready", async () => {
  const { env } = await setup();
  const jpeg = new Uint8Array(2000);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
  const init = await (await start(env, { kind: "image", filename: "Cover photo.jpeg", size: 2000, contentType: "image/jpeg" })).json();
  assert.match(init.key, /^images\/.*-cover-photo\.jpg$/);
  const put = await putPart(env, init.id, 1, jpeg);
  const item = await (await complete(env, init.id, [{ partNumber: 1, etag: (await put.json()).etag }])).json();
  assert.equal(item.publicUrl, `/media/i/${init.key}`);
});

test("captions attach to the lesson", async () => {
  const { env, db } = await setup();
  const vtt = new TextEncoder().encode("WEBVTT\n\n00:00.000 --> 00:02.000\nNamaste\n");
  const init = await (await start(env, { kind: "captions", filename: "hindi.vtt", size: vtt.byteLength, contentType: "text/vtt", lessonId: 1 })).json();
  const put = await putPart(env, init.id, 1, vtt);
  assert.equal(put.status, 200);
  assert.equal((await complete(env, init.id, [{ partNumber: 1, etag: (await put.json()).etag }])).status, 200);
  assert.equal(db.get("SELECT captions_key FROM lessons WHERE id = 1").captions_key, init.key);
});

// ---------- delete and abort ----------

test("delete: aborts an unfinished upload", async () => {
  const { env, db, r2 } = await setup();
  const init = await (await start(env, videoBody(100))).json();
  const res = await del(env, init.id);
  assert.equal(res.status, 204);
  assert.equal(r2.uploads.has(init.uploadId), false);
  assert.equal(db.get("SELECT status FROM media WHERE id = ?", init.id).status, "aborted");
  assert.equal((await putPart(env, init.id, 1, mp4Bytes(100))).status, 409);
  assert.equal((await complete(env, init.id, [{ partNumber: 1, etag: "x" }])).status, 409);
  assert.equal((await del(env, init.id)).status, 204, "twice is fine");
});

test("delete: a file in use needs force, then the lesson loses it", async () => {
  const { env, db, r2 } = await setup({ video: false });
  const { init, etags } = await uploadAll(env, mp4Bytes(700), { lessonId: 1 });
  await complete(env, init.id, etags);
  const refused = await del(env, init.id);
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).message, /1 lesson/);
  assert.ok(r2.objects.has(init.key));
  const res = await del(env, init.id, "?force=1");
  assert.equal(res.status, 204);
  assert.equal(r2.objects.has(init.key), false);
  assert.equal(db.get("SELECT status FROM media WHERE id = ?", init.id).status, "deleted");
  const lesson = db.get("SELECT video_provider, video_ref FROM lessons WHERE id = 1");
  assert.deepEqual({ ...lesson }, { video_provider: "none", video_ref: null });
  assert.equal(db.get("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").action, "media.delete");
});

test("delete: a course cover in use bumps the content version when forced", async () => {
  const { env, db } = await setup();
  const png = new Uint8Array(100);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const init = await (await start(env, { kind: "image", filename: "c.png", size: 100, contentType: "image/png" })).json();
  const put = await putPart(env, init.id, 1, png);
  await complete(env, init.id, [{ partNumber: 1, etag: (await put.json()).etag }]);
  db.sqlite.prepare("UPDATE courses SET cover_key = ? WHERE id = 1").run(init.key);
  const version = Number(db.get("SELECT value FROM settings WHERE key = 'content_version'").value);
  assert.equal((await del(env, init.id)).status, 409);
  assert.equal((await del(env, init.id, "?force=1")).status, 204);
  assert.equal(db.get("SELECT cover_key FROM courses WHERE id = 1").cover_key, null);
  assert.equal(Number(db.get("SELECT value FROM settings WHERE key = 'content_version'").value), version + 1);
});

test("delete: unknown id is 404, a bad id 400", async () => {
  const { env } = await setup();
  assert.equal((await del(env, 999)).status, 404);
  assert.equal((await del(env, "abc")).status, 400);
});

// ---------- list ----------

test("list: newest first, filters, hides deleted unless asked", async () => {
  const { env } = await setup({ video: false });
  const a = await uploadAll(env, mp4Bytes(300), { lessonId: 1 });
  await complete(env, a.init.id, a.etags);
  const b = await (await start(env, videoBody(400))).json();
  const c = await (await start(env, videoBody(500))).json();
  await del(env, c.id);
  const all = await (await list(env)).json();
  assert.deepEqual(all.map((m) => m.id), [b.id, a.init.id]);
  assert.deepEqual((await (await list(env, "?status=aborted")).json()).map((m) => m.id), [c.id]);
  assert.deepEqual((await (await list(env, "?lessonId=1")).json()).map((m) => m.id), [a.init.id]);
  assert.deepEqual(await (await list(env, "?kind=image")).json(), []);
  assert.equal((await list(env, "?kind=audio")).status, 400);
  assert.equal((await list(env, "?status=gone")).status, 400);
  const res = await list(env);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  void NOW;
  void SITE;
});
