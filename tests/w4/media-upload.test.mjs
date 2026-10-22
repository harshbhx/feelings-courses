// W4: the browser's resumable uploader (src/lib/media-upload.ts), run against the real admin
// upload endpoints through a fetch stand-in.

import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadMedia, cancelUpload, uploadFingerprint, isRetryable } from "../../src/lib/media-upload.ts";
import { ApiError } from "../../src/lib/api-client.ts";
import { onRequest as startRoute } from "../../functions/api/admin/uploads/index.ts";
import { onRequest as partRoute } from "../../functions/api/admin/uploads/[id]/parts/[n].ts";
import { onRequest as completeRoute } from "../../functions/api/admin/uploads/[id]/complete.ts";
import { onRequest as deleteRoute } from "../../functions/api/admin/uploads/[id]/index.ts";
import { UPLOAD_PART_SIZE } from "../../functions/_lib/config.ts";
import { SITE, context } from "../helpers/http.mjs";
import { setup, mp4Bytes } from "./fixtures.mjs";

const PART = UPLOAD_PART_SIZE;

function memoryStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

/**
 * Replaces globalThis.fetch with a router to the W4 route files (as the signed-in admin).
 * `hook(path, method, n)` may throw (network error) or return a Response to short-circuit.
 */
function installFetch(t, env, hook = () => undefined) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (path, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    calls.push(`${method} ${path}`);
    const early = await hook(path, method, calls.length);
    if (early) return early;
    const headers = new Headers(init.headers);
    if (init.body instanceof Blob) headers.set("Content-Length", String(init.body.size));
    headers.set("Origin", SITE);
    const request = new Request(`${SITE}${path}`, { method, headers, body: init.body ?? undefined });
    let m;
    const ctx = (route, params) => route(context({ request, env, params, data: { admin: { sessionId: 1 } } }));
    if (path === "/api/admin/uploads") return ctx(startRoute, {});
    if ((m = /^\/api\/admin\/uploads\/(\d+)\/parts\/(\d+)$/.exec(path))) return ctx(partRoute, { id: m[1], n: m[2] });
    if ((m = /^\/api\/admin\/uploads\/(\d+)\/complete$/.exec(path))) return ctx(completeRoute, { id: m[1] });
    if ((m = /^\/api\/admin\/uploads\/(\d+)$/.exec(path))) return ctx(deleteRoute, { id: m[1] });
    return new Response("no route", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const fileOf = (bytes, name = "Lesson 2.mp4") => new File([bytes], name, { type: "video/mp4", lastModified: 1_700_000_000_000 });
const noSleep = async () => {};

test("uploads every part, completes, and forgets the resume state", async (t) => {
  const { env, r2, db } = await setup({ video: false });
  const calls = installFetch(t, env);
  const storage = memoryStorage();
  const bytes = mp4Bytes(2 * PART + 77);
  const progress = [];
  const item = await uploadMedia(fileOf(bytes), { kind: "video", lessonId: 1, storage, sleep: noSleep, onProgress: (s, total) => progress.push([s, total]) });
  assert.equal(item.status, "ready");
  assert.equal(item.lessonId, 1);
  assert.deepEqual(new Uint8Array(r2.objects.get(item.key).bytes), bytes);
  assert.equal(calls.filter((c) => c.includes("/parts/")).length, 3);
  assert.deepEqual(progress.at(-1), [2 * PART + 77, 2 * PART + 77]);
  assert.equal(progress[0][0], 0);
  assert.equal(storage.map.size, 0);
  assert.equal(db.get("SELECT video_ref FROM lessons WHERE id = 1").video_ref, item.key);
});

test("retries a part after a network error or a 503", async (t) => {
  const { env } = await setup({ video: false });
  let failures = 0;
  const calls = installFetch(t, env, (path, method) => {
    if (path.endsWith("/parts/2") && failures < 2) {
      failures++;
      if (failures === 1) throw new TypeError("network down");
      return new Response(JSON.stringify({ error: "server_error", message: "x" }), { status: 503 });
    }
    void method;
  });
  const sleeps = [];
  const item = await uploadMedia(fileOf(mp4Bytes(PART + 5)), { kind: "video", storage: memoryStorage(), sleep: async (ms) => void sleeps.push(ms) });
  assert.equal(item.status, "ready");
  assert.deepEqual(sleeps, [1000, 2000]);
  assert.equal(calls.filter((c) => c.endsWith("/parts/2")).length, 3);
});

test("stops on a 4xx without retrying", async (t) => {
  const { env } = await setup({ video: false });
  installFetch(t, env);
  const html = new Uint8Array(100);
  html.set(new TextEncoder().encode("<html>"));
  await assert.rejects(
    uploadMedia(fileOf(html), { kind: "video", storage: memoryStorage(), sleep: noSleep }),
    (err) => err instanceof ApiError && err.status === 415 && err.code === "upload_invalid",
  );
});

test("pause and resume: only the missing parts are sent again", async (t) => {
  const { env, r2 } = await setup({ video: false });
  const storage = memoryStorage();
  const bytes = mp4Bytes(2 * PART + 9);
  const controller = new AbortController();
  // Pause as soon as part 1 is confirmed.
  const first = installFetch(t, env, (path) => {
    if (path.endsWith("/parts/2") || path.endsWith("/parts/3")) {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }
  });
  await assert.rejects(uploadMedia(fileOf(bytes), { kind: "video", storage, signal: controller.signal, concurrency: 1, sleep: noSleep }), { name: "AbortError" });
  assert.equal(first.filter((c) => c.endsWith("/parts/1")).length, 1);
  const saved = JSON.parse([...storage.map.values()][0]);
  assert.deepEqual(Object.keys(saved.etags), ["1"]);

  // A fresh page: same file, picks up where it stopped.
  const second = installFetch(t, env);
  const item = await uploadMedia(fileOf(bytes), { kind: "video", storage, sleep: noSleep });
  assert.equal(item.status, "ready");
  assert.equal(second.includes("POST /api/admin/uploads"), false, "no new upload started");
  assert.equal(second.some((c) => c.endsWith("/parts/1")), false, "part 1 not sent again");
  assert.deepEqual(second.filter((c) => c.includes("/parts/")).sort(), [`PUT /api/admin/uploads/${saved.id}/parts/2`, `PUT /api/admin/uploads/${saved.id}/parts/3`]);
  assert.deepEqual(new Uint8Array(r2.objects.get(item.key).bytes), bytes);
});

test("starts over once when the server has forgotten the upload", async (t) => {
  const { env } = await setup({ video: false });
  const storage = memoryStorage();
  const file = fileOf(mp4Bytes(PART + 3));
  // A saved state pointing at an upload that was cancelled meanwhile.
  installFetch(t, env);
  const init = await (await fetch("/api/admin/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "video", filename: file.name, size: file.size, contentType: "video/mp4" }),
  })).json();
  await fetch(`/api/admin/uploads/${init.id}`, { method: "DELETE" });
  storage.setItem(uploadFingerprint(file, "video"), JSON.stringify({ v: 1, id: init.id, key: init.key, uploadId: init.uploadId, partSize: PART, size: file.size, etags: {} }));
  const item = await uploadMedia(file, { kind: "video", storage, sleep: noSleep });
  assert.equal(item.status, "ready");
  assert.notEqual(item.id, init.id);
});

test("a lost complete answer: the retry gets the same finished item", async (t) => {
  const { env } = await setup({ video: false });
  const storage = memoryStorage();
  const file = fileOf(mp4Bytes(500));
  let finished = null;
  const calls = installFetch(t, env, async (path, method) => {
    if (path.endsWith("/complete") && !finished) {
      // The server finishes the upload, but the answer never reaches the browser.
      const m = /uploads\/(\d+)\/complete/.exec(path);
      const parts = [{ partNumber: 1, etag: JSON.parse([...storage.map.values()][0]).etags["1"] }];
      const request = new Request(`${SITE}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts }) });
      finished = await (await completeRoute(context({ request, env, params: { id: m[1] }, data: { admin: { sessionId: 1 } } }))).json();
      throw new TypeError("connection reset");
    }
  });
  const item = await uploadMedia(file, { kind: "video", storage, sleep: noSleep });
  assert.equal(finished.status, "ready");
  assert.equal(item.id, finished.id);
  assert.equal(calls.filter((c) => c.endsWith("/complete")).length, 2);
  assert.equal(storage.map.size, 0);
});

test("cancelUpload deletes the unfinished upload and its state", async (t) => {
  const { env, db } = await setup({ video: false });
  const storage = memoryStorage();
  const file = fileOf(mp4Bytes(PART + 1));
  const controller = new AbortController();
  installFetch(t, env, (path) => {
    if (path.includes("/parts/")) {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }
  });
  await assert.rejects(uploadMedia(file, { kind: "video", storage, signal: controller.signal, sleep: noSleep }));
  const saved = JSON.parse([...storage.map.values()][0]);
  await cancelUpload(file, { kind: "video", storage });
  assert.equal(storage.map.size, 0);
  assert.equal(db.get("SELECT status FROM media WHERE id = ?", saved.id).status, "aborted");
});

test("isRetryable and fingerprints", () => {
  assert.equal(isRetryable(new ApiError(0, {})), true);
  assert.equal(isRetryable(new ApiError(429, {})), true);
  assert.equal(isRetryable(new ApiError(502, {})), true);
  assert.equal(isRetryable(new ApiError(400, {})), false);
  assert.equal(isRetryable(new Error("x")), false);
  const f = fileOf(new Uint8Array(3), "a.mp4");
  assert.notEqual(uploadFingerprint(f, "video", 1), uploadFingerprint(f, "video", 2));
  assert.notEqual(uploadFingerprint(f, "video"), uploadFingerprint(fileOf(new Uint8Array(4), "a.mp4"), "video"));
});
