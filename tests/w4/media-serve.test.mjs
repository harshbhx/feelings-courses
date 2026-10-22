// W4: serving lesson media and images from R2 (functions/_lib/media-serve.ts), and the play and
// preview logic (functions/_lib/play.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { serveLessonMedia, serveImage, parseRange, resolveRange, hotlinkRefusal, isOwnHost, LIVE_CHECK_TTL } from "../../functions/_lib/media-serve.ts";
import { signMediaUrl } from "../../functions/_lib/media.ts";
import { playLesson, previewLesson, maskPhone, maskEmail, watermarkFor, resumePosition } from "../../functions/_lib/play.ts";
import { onRequest as previewRoute } from "../../functions/api/public/preview/[lessonId].ts";
import { onRequest as videoRoute } from "../../functions/media/v/[lessonId].ts";
import { SITE, context } from "../helpers/http.mjs";
import { setup, enrollmentRef, NOW, TOKEN, OTHER_TOKEN, VIDEO_KEY, CAPTIONS_KEY, LESSON_ID, tagOf, sessionCookie, mp4Bytes } from "./fixtures.mjs";

const studentUrl = (env, kind = "v", lessonId = LESSON_ID, token = TOKEN) => signMediaUrl(env, { kind, lessonId, sessionTag: tagOf(token), now: NOW });

function get(url, { cookie = sessionCookie(), headers = {}, method = "GET" } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set("Cookie", cookie);
  return new Request(new URL(url, SITE), { method, headers: h });
}

const serve = (env, request, kind = "v", id = String(LESSON_ID), now = NOW + 5) => serveLessonMedia(env, request, kind, id, now);

// ---------- ranges ----------

test("parseRange / resolveRange", () => {
  assert.equal(parseRange(null), undefined);
  assert.deepEqual(parseRange("bytes=0-99"), { offset: 0, length: 100 });
  assert.deepEqual(parseRange("bytes=500-"), { offset: 500 });
  assert.deepEqual(parseRange("bytes=-200"), { suffix: 200 });
  assert.equal(parseRange("bytes=-0"), "unsatisfiable");
  assert.equal(parseRange("bytes=5-1"), undefined);
  assert.equal(parseRange("bytes=0-1,5-9"), undefined);
  assert.equal(parseRange("items=0-1"), undefined);
  assert.equal(parseRange("bytes=-"), undefined);
  assert.deepEqual(resolveRange({ offset: 0, length: 100 }, 1000), { start: 0, end: 99 });
  assert.deepEqual(resolveRange({ offset: 900, length: 500 }, 1000), { start: 900, end: 999 });
  assert.deepEqual(resolveRange({ offset: 10 }, 1000), { start: 10, end: 999 });
  assert.deepEqual(resolveRange({ suffix: 5000 }, 1000), { start: 0, end: 999 });
  assert.equal(resolveRange({ offset: 1000 }, 1000), null);
  assert.equal(resolveRange({ suffix: 5 }, 0), null);
});

// ---------- student video ----------

test("video: the enrolled student's browser gets the whole file, privately", async () => {
  const { env } = await setup();
  const res = await serve(env, get(await studentUrl(env)));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "video/mp4");
  assert.equal(res.headers.get("Content-Length"), "1000");
  assert.equal(res.headers.get("Accept-Ranges"), "bytes");
  assert.match(res.headers.get("Cache-Control"), /^private, max-age=\d+, no-transform$/);
  assert.equal(res.headers.get("Cross-Origin-Resource-Policy"), "same-site");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.ok(res.headers.get("ETag"));
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), mp4Bytes(1000));
});

test("video: byte ranges for seeking (206, Content-Range, 416)", async () => {
  const { env } = await setup();
  const url = await studentUrl(env);
  const part = await serve(env, get(url, { headers: { Range: "bytes=100-199" } }));
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("Content-Range"), "bytes 100-199/1000");
  assert.equal(part.headers.get("Content-Length"), "100");
  assert.deepEqual(new Uint8Array(await part.arrayBuffer()), mp4Bytes(1000).slice(100, 200));

  const open = await serve(env, get(url, { headers: { Range: "bytes=990-" } }));
  assert.equal(open.status, 206);
  assert.equal(open.headers.get("Content-Range"), "bytes 990-999/1000");
  assert.equal((await open.arrayBuffer()).byteLength, 10);

  const tail = await serve(env, get(url, { headers: { Range: "bytes=-50" } }));
  assert.equal(tail.headers.get("Content-Range"), "bytes 950-999/1000");

  const past = await serve(env, get(url, { headers: { Range: "bytes=1000-" } }));
  assert.equal(past.status, 416);
  assert.equal(past.headers.get("Content-Range"), "bytes */1000");

  const zero = await serve(env, get(url, { headers: { Range: "bytes=-0" } }));
  assert.equal(zero.status, 416);

  const several = await serve(env, get(url, { headers: { Range: "bytes=0-1,5-6" } }));
  assert.equal(several.status, 200);
});

test("video: If-Range with an old ETag gets the whole new file; If-None-Match gets 304", async () => {
  const { env } = await setup();
  const url = await studentUrl(env);
  const first = await serve(env, get(url));
  const etag = first.headers.get("ETag");
  const stale = await serve(env, get(url, { headers: { Range: "bytes=0-9", "If-Range": '"old"' } }));
  assert.equal(stale.status, 200);
  assert.equal((await stale.arrayBuffer()).byteLength, 1000);
  const fresh = await serve(env, get(url, { headers: { Range: "bytes=0-9", "If-Range": etag } }));
  assert.equal(fresh.status, 206);
  const cached = await serve(env, get(url, { headers: { "If-None-Match": etag } }));
  assert.equal(cached.status, 304);
});

test("video: HEAD gives the headers only", async () => {
  const { env } = await setup();
  const res = await serve(env, get(await studentUrl(env), { method: "HEAD" }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Length"), "1000");
  assert.equal(res.body, null);
});

test("video: a copied link fails without the student's own session cookie", async () => {
  const { env } = await setup();
  const url = await studentUrl(env);
  assert.equal((await serve(env, get(url, { cookie: null }))).status, 403);
  assert.equal((await serve(env, get(url, { cookie: sessionCookie(OTHER_TOKEN) }))).status, 403);
  assert.equal((await serve(env, get(url, { cookie: "__Host-fbc_s=" }))).status, 403);
});

test("video: expired, tampered or other-lesson links fail", async () => {
  const { env } = await setup();
  const url = await studentUrl(env);
  assert.equal((await serve(env, get(url), "v", String(LESSON_ID), NOW + 7200)).status, 403);
  assert.equal((await serve(env, get(url), "v", "2")).status, 403);
  assert.equal((await serve(env, get(url), "c")).status, 403);
  assert.equal((await serve(env, get(url.replace(/sig=./, "sig=0")))).status, 403);
  assert.equal((await serve(env, get(url.replace(/&s=[0-9a-f]+/, "&s=public")))).status, 403);
  const res = await serve(env, get(url.replace(/sig=.*/, "sig=x")));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, "forbidden");
});

test("video: a revoked session, revoked or expired enrollment stops playback", async () => {
  const { env, db } = await setup();
  const url = await studentUrl(env);
  db.sqlite.prepare("UPDATE sessions SET revoked_at = ? WHERE student_id = 1").run(NOW);
  assert.equal((await serve(env, get(url))).status, 403);

  const b = await setup();
  b.db.sqlite.prepare("UPDATE enrollments SET revoked_at = ? WHERE student_id = 1").run(NOW);
  assert.equal((await serve(b.env, get(await studentUrl(b.env)))).status, 403);

  const c = await setup();
  c.db.sqlite.prepare("UPDATE enrollments SET expires_at = ? WHERE student_id = 1").run(NOW);
  assert.equal((await serve(c.env, get(await studentUrl(c.env)))).status, 403);

  const d = await setup({ enrolled: false });
  assert.equal((await serve(d.env, get(await studentUrl(d.env)))).status, 403);
});

test("video: test-mode enrollments stop working once payments are live", async () => {
  const { env, db } = await setup();
  db.sqlite.prepare("UPDATE enrollments SET mode = 'test' WHERE student_id = 1").run();
  assert.equal((await serve(env, get(await studentUrl(env)))).status, 200);
  const { env: env2, db: db2 } = await setup();
  db2.sqlite.prepare("UPDATE enrollments SET mode = 'test' WHERE student_id = 1").run();
  assert.equal((await serve({ ...env2, RAZORPAY_KEY_ID: "rzp_live_abc123" }, get(await studentUrl(env2)))).status, 403);
});

test("video: a passed check is reused for LIVE_CHECK_TTL, then D1 is asked again", async () => {
  const { env, db } = await setup();
  const url = await studentUrl(env);
  assert.equal((await serve(env, get(url), "v", "1", NOW + 5)).status, 200);
  const before = db.log.length;
  assert.equal((await serve(env, get(url), "v", "1", NOW + 6)).status, 200);
  assert.equal(db.log.length, before, "no query while cached");
  db.sqlite.prepare("UPDATE sessions SET revoked_at = ? WHERE student_id = 1").run(NOW);
  assert.equal((await serve(env, get(url), "v", "1", NOW + 6 + LIVE_CHECK_TTL)).status, 403);
});

test("video: a lesson without an R2 video, or a missing object, is 404", async () => {
  const { env, db, r2 } = await setup();
  const url = await studentUrl(env);
  await r2.delete(VIDEO_KEY);
  assert.equal((await serve(env, get(url))).status, 404);
  const b = await setup({ video: false });
  assert.equal((await serve(b.env, get(await studentUrl(b.env)))).status, 404);
  // A video_ref that isn't one of W4's keys (for example a backup) is never served.
  const c = await setup();
  c.db.sqlite.prepare("UPDATE lessons SET video_ref = 'backups/d1/x.sql.gz' WHERE id = 1").run();
  await c.r2.put("backups/d1/x.sql.gz", "secret");
  assert.equal((await serve(c.env, get(await studentUrl(c.env)))).status, 404);
  void db;
});

test("video: no hotlinking", async () => {
  const { env } = await setup();
  const url = await studentUrl(env);
  assert.equal((await serve(env, get(url, { headers: { "Sec-Fetch-Site": "cross-site" } }))).status, 403);
  assert.equal((await serve(env, get(url, { headers: { Referer: "https://evil.example/page" } }))).status, 403);
  assert.equal((await serve(env, get(url, { headers: { "Sec-Fetch-Dest": "document" } }))).status, 403);
  assert.equal((await serve(env, get(url, { headers: { "Sec-Fetch-Dest": "image" } }))).status, 403);
  // Our own pages, course subdomains and media loads are fine.
  assert.equal((await serve(env, get(url, { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "video", Referer: `${SITE}/learn/x` } }))).status, 200);
  assert.equal((await serve(env, get(url, { headers: { "Sec-Fetch-Site": "same-site", Referer: "https://selfmakeup.feelingsbeautycare.in/" } }))).status, 200);
});

test("hotlink helpers", () => {
  const env = { HUB_HOST: "courses.feelingsbeautycare.in", APEX_DOMAIN: "feelingsbeautycare.in" };
  assert.equal(isOwnHost("courses.feelingsbeautycare.in", env), true);
  assert.equal(isOwnHost("diploma.feelingsbeautycare.in", env), true);
  assert.equal(isOwnHost("feelingsbeautycare.in.evil.com", env), false);
  assert.equal(isOwnHost("evilfeelingsbeautycare.in", env), false);
  assert.equal(isOwnHost("abc.feelings-courses.pages.dev", env), false);
  assert.equal(isOwnHost("abc.feelings-courses.pages.dev", { ...env, APP_ENV: "preview" }), true);
  const r = (headers) => new Request(`${SITE}/media/c/1`, { headers });
  assert.equal(hotlinkRefusal(r({ "Sec-Fetch-Dest": "track" }), env, "c"), null);
  assert.equal(hotlinkRefusal(r({ "Sec-Fetch-Dest": "video" }), env, "c"), "dest:video");
  assert.equal(hotlinkRefusal(r({ Referer: "not a url" }), env, "v"), "referer");
});

test("video: other methods, missing bindings", async () => {
  const { env } = await setup();
  const url = await studentUrl(env);
  assert.equal((await serve(env, get(url, { method: "POST" }))).status, 405);
  assert.equal((await serve({ ...env, MEDIA: undefined }, get(url))).status, 404);
  assert.equal((await serve({ APP_SECRET: env.APP_SECRET }, get(url))).status, 404);
  assert.equal((await serve({ ...env, APP_SECRET: undefined }, get(url))).status, 503);
  const broken = { ...env, MEDIA: { get: async () => { throw new Error("R2 down"); }, head: async () => null } };
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await serve(broken, get(url))).status, 500);
  } finally {
    console.error = original;
  }
});

test("video: a range R2 refuses is asked again for the bytes that exist", async () => {
  const { env, r2 } = await setup();
  const strict = Object.create(r2);
  strict.get = async (key, options = {}) => {
    const range = options.range;
    if (range && "length" in range && range.length !== undefined && range.offset + range.length > 1000) throw new Error("range not satisfiable (10039)");
    return r2.get(key, options);
  };
  strict.head = (key) => r2.head(key);
  const res = await serve({ ...env, MEDIA: strict }, get(await studentUrl(env), { headers: { Range: "bytes=900-5000" } }));
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("Content-Range"), "bytes 900-999/1000");
  assert.equal((await res.arrayBuffer()).byteLength, 100);
});

test("route file: /media/v/:lessonId wires the handler", async () => {
  const { env } = await setup();
  const url = await signMediaUrl(env, { kind: "v", lessonId: LESSON_ID, sessionTag: tagOf(TOKEN) });
  const ctx = context({ request: get(url), env, params: { lessonId: String(LESSON_ID) } });
  const res = await videoRoute(ctx);
  assert.equal(res.status, 200);
});

// ---------- captions ----------

test("captions: served as text/vtt to the student's track", async () => {
  const { env } = await setup({ captions: true });
  const url = await studentUrl(env, "c");
  const res = await serve(env, get(url, { headers: { "Sec-Fetch-Dest": "track" } }), "c");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "text/vtt; charset=utf-8");
  assert.match(await res.text(), /^WEBVTT/);
  const none = await setup();
  assert.equal((await serve(none.env, get(await studentUrl(none.env, "c")), "c")).status, 404);
});

// ---------- previews ----------

test("preview: public links only for free-preview lessons of published courses", async () => {
  const { env, db } = await setup({ enrolled: false });
  assert.equal(await previewLesson(env, LESSON_ID, NOW), null);
  db.sqlite.prepare("UPDATE lessons SET free_preview = 1 WHERE id = 1").run();
  const media = await previewLesson(env, LESSON_ID, NOW);
  assert.match(media.src, /^\/media\/v\/1\?e=\d+&s=public&sig=/);
  assert.equal(media.captions, null);
  assert.equal(media.expiresAt, NOW + 7200);
  // Anyone can play it, without a cookie.
  assert.equal((await serve(env, get(media.src, { cookie: null }))).status, 200);
  // Not once the lesson stops being a preview (after this isolate's cached check runs out).
  db.sqlite.prepare("UPDATE lessons SET free_preview = 0 WHERE id = 1").run();
  const later = NOW + 5 + LIVE_CHECK_TTL;
  assert.equal((await serve(env, get(media.src, { cookie: null }), "v", "1", later)).status, 403);
  // Draft courses never have previews.
  db.sqlite.prepare("UPDATE lessons SET free_preview = 1 WHERE id = 1").run();
  db.sqlite.prepare("UPDATE courses SET status = 'draft' WHERE id = 1").run();
  assert.equal(await previewLesson(env, LESSON_ID, NOW), null);
  assert.equal((await serve(env, get(media.src, { cookie: null }), "v", "1", later)).status, 403);
});

test("preview route: 200 with links, 404 otherwise", async () => {
  const { env, db } = await setup({ enrolled: false });
  db.sqlite.prepare("UPDATE lessons SET free_preview = 1 WHERE id = 1").run();
  const ok = await previewRoute(context({ request: new Request(`${SITE}/api/public/preview/1`), env, params: { lessonId: "1" } }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("Cache-Control"), "no-store");
  assert.match((await ok.json()).src, /s=public/);
  const missing = await previewRoute(context({ request: new Request(`${SITE}/api/public/preview/2`), env, params: { lessonId: "2" } }));
  assert.equal(missing.status, 404);
  const junk = await previewRoute(context({ request: new Request(`${SITE}/api/public/preview/x`), env, params: { lessonId: "x" } }));
  assert.equal(junk.status, 404);
  const post = await previewRoute(context({ request: new Request(`${SITE}/api/public/preview/1`, { method: "POST" }), env, params: { lessonId: "1" } }));
  assert.equal(post.status, 405);
  const unset = await previewRoute(context({ request: new Request(`${SITE}/api/public/preview/1`), env: { DB: env.DB }, params: { lessonId: "1" } }));
  assert.equal(unset.status, 503);
});

// ---------- playLesson ----------

test("playLesson: signed links bound to the session, resume point and watermark", async () => {
  const { env, db } = await setup({ captions: true });
  db.sqlite.prepare("INSERT INTO lesson_progress (student_id, lesson_id, position_seconds, updated_at) VALUES (1, 1, 125, ?)").run(NOW);
  const info = await playLesson(env, enrollmentRef(db), LESSON_ID, NOW);
  assert.match(info.src, new RegExp(`^/media/v/1\\?e=${NOW + 7200}&s=${tagOf(TOKEN)}&sig=[0-9a-f]{64}$`));
  assert.match(info.captions, /^\/media\/c\/1\?/);
  assert.equal(info.expiresAt, NOW + 7200);
  assert.equal(info.resumeAt, 125);
  assert.deepEqual(info.watermark, { name: "Priya Shah", phoneMasked: "+91 ••••• •1578" });
  // The links play in that browser.
  assert.equal((await serve(env, get(info.src))).status, 200);
  assert.equal((await serve(env, get(info.captions), "c")).status, 200);
});

test("playLesson: null for another course's lesson or a lesson without video", async () => {
  const { env, db } = await setup();
  const ref = enrollmentRef(db);
  assert.equal(await playLesson(env, ref, 10, NOW), null); // lesson 10 belongs to course 2
  assert.equal(await playLesson(env, ref, 2, NOW), null); // no video
  assert.equal(await playLesson(env, ref, 0, NOW), null);
  assert.equal(await playLesson(env, ref, 999, NOW), null);
  assert.equal(await playLesson({ APP_SECRET: env.APP_SECRET }, ref, 1, NOW), null);
});

test("resume, masking and watermark helpers", () => {
  assert.equal(resumePosition({ position_seconds: 50, completed_at: null, duration_seconds: 300 }), 50);
  assert.equal(resumePosition({ position_seconds: 295, completed_at: null, duration_seconds: 300 }), 0);
  assert.equal(resumePosition({ position_seconds: 50, completed_at: NOW, duration_seconds: 300 }), 0);
  assert.equal(resumePosition({ position_seconds: null, completed_at: null, duration_seconds: null }), 0);
  assert.equal(maskPhone("+919876541578"), "+91 ••••• •1578");
  assert.equal(maskPhone("+14155551234"), "+1 •••• 1234");
  assert.equal(maskPhone(null), null);
  assert.equal(maskEmail("meera@example.com"), "me•••@example.com");
  assert.deepEqual(watermarkFor({ name: null, phone: null, email: "meera@example.com" }), { name: "me•••@example.com", phoneMasked: null });
  assert.deepEqual(watermarkFor({ name: "  ", phone: "+919876541578", email: null }), { name: "", phoneMasked: "+91 ••••• •1578" });
});

// ---------- images ----------

test("images: only finished image uploads are public", async () => {
  const { env, db, r2 } = await setup();
  const key = "images/2026/10/0123456789abcdef-cover.jpg";
  await r2.put(key, new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { httpMetadata: { contentType: "image/jpeg" } });
  const url = `${SITE}/media/i/${key}`;
  assert.equal((await serveImage(env, new Request(url))).status, 404);
  db.sqlite.prepare("INSERT INTO media (key, kind, content_type, size_bytes, status, created_at, updated_at) VALUES (?, 'image', 'image/jpeg', 6, 'ready', ?, ?)").run(key, NOW, NOW);
  const res = await serveImage(env, new Request(url));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=31536000, immutable");
  // Percent-encoded segments (W1 encodes each one) name the same key.
  assert.equal((await serveImage(env, new Request(`${SITE}/media/i/images/2026/10/0123456789abcdef%2Dcover.jpg`))).status, 200);
  // Never a video, a backup or a path trick.
  assert.equal((await serveImage(env, new Request(`${SITE}/media/i/${VIDEO_KEY}`))).status, 404);
  assert.equal((await serveImage(env, new Request(`${SITE}/media/i/backups/d1/x.sql.gz`))).status, 404);
  assert.equal((await serveImage(env, new Request(`${SITE}/media/i/images/%E0%A4`))).status, 404);
  db.sqlite.prepare("UPDATE media SET status = 'deleted' WHERE key = ?").run(key);
  assert.equal((await serveImage(env, new Request(url))).status, 404);
  void CAPTIONS_KEY;
});
