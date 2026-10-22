// W4: signing and checking media links (functions/_lib/media.ts) and the upload rules
// (functions/_lib/media-rules.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signMediaUrl, verifyMediaLink, mediaUrlExpiry, sessionTokenHash, isSessionTag } from "../../functions/_lib/media.ts";
import { readCookie } from "../../functions/_lib/session.ts";
import { planUpload, expectedPartSize, mediaKey, safeBaseName, sniffMismatch, MEDIA_KEY_RE, formatBytes } from "../../functions/_lib/media-rules.ts";
import { ConfigError } from "../../functions/_lib/config.ts";
import { ValidationError } from "../../functions/_lib/db/errors.ts";
import { APP_SECRET, NOW, TOKEN, sha256, tagOf, mp4Bytes } from "./fixtures.mjs";

const env = { APP_SECRET };
const MiB = 1024 * 1024;
const params = (url) => new URL(url, "https://x.test").searchParams;

// ---------- signing ----------

test("signMediaUrl: the documented format and HMAC", async () => {
  const url = await signMediaUrl(env, { kind: "v", lessonId: 7, sessionTag: tagOf(TOKEN), now: NOW });
  const p = params(url);
  assert.match(url, /^\/media\/v\/7\?e=\d+&s=[0-9a-f]{16}&sig=[0-9a-f]{64}$/);
  assert.equal(Number(p.get("e")), NOW + 7200);
  const expected = createHmac("sha256", APP_SECRET).update(`v|7|${NOW + 7200}|${tagOf(TOKEN)}`).digest("hex");
  assert.equal(p.get("sig"), expected);
  assert.equal(mediaUrlExpiry(url), NOW + 7200);
});

test("signMediaUrl: ttl is clamped to 60 s .. 2 h", async () => {
  const long = await signMediaUrl(env, { kind: "c", lessonId: 1, sessionTag: "public", ttl: 86_400, now: NOW });
  assert.equal(mediaUrlExpiry(long), NOW + 7200);
  const short = await signMediaUrl(env, { kind: "c", lessonId: 1, sessionTag: "public", ttl: 1, now: NOW });
  assert.equal(mediaUrlExpiry(short), NOW + 60);
});

test("signMediaUrl: refuses bad input and a missing secret", async () => {
  await assert.rejects(signMediaUrl(env, { kind: "x", lessonId: 1, sessionTag: "public" }), TypeError);
  await assert.rejects(signMediaUrl(env, { kind: "v", lessonId: 0, sessionTag: "public" }), TypeError);
  await assert.rejects(signMediaUrl(env, { kind: "v", lessonId: 1.5, sessionTag: "public" }), TypeError);
  await assert.rejects(signMediaUrl(env, { kind: "v", lessonId: 1, sessionTag: "ABCDEF0123456789" }), TypeError);
  await assert.rejects(signMediaUrl(env, { kind: "v", lessonId: 1, sessionTag: "public&x=1" }), TypeError);
  await assert.rejects(signMediaUrl({}, { kind: "v", lessonId: 1, sessionTag: "public" }), ConfigError);
  await assert.rejects(signMediaUrl({ APP_SECRET: "short" }, { kind: "v", lessonId: 1, sessionTag: "public" }), ConfigError);
});

test("verifyMediaLink: accepts its own links until they expire", async () => {
  const url = await signMediaUrl(env, { kind: "v", lessonId: 3, sessionTag: tagOf(TOKEN), now: NOW });
  const ok = await verifyMediaLink(env, { kind: "v", lessonId: "3", params: params(url) }, NOW + 10);
  assert.deepEqual(ok, { ok: true, kind: "v", lessonId: 3, exp: NOW + 7200, sidTag: tagOf(TOKEN) });
  const late = await verifyMediaLink(env, { kind: "v", lessonId: "3", params: params(url) }, NOW + 7200);
  assert.deepEqual(late, { ok: false, reason: "expired" });
});

test("verifyMediaLink: any change to the link breaks it", async () => {
  const url = await signMediaUrl(env, { kind: "v", lessonId: 3, sessionTag: tagOf(TOKEN), now: NOW });
  const p = params(url);
  const check = (kind, lessonId, q) => verifyMediaLink(env, { kind, lessonId, params: q }, NOW + 1);
  // Another lesson, kind, session tag, expiry or secret.
  assert.equal((await check("v", "4", p)).reason, "bad_signature");
  assert.equal((await check("c", "3", p)).reason, "bad_signature");
  const otherTag = new URLSearchParams(p);
  otherTag.set("s", "public");
  assert.equal((await check("v", "3", otherTag)).reason, "bad_signature");
  const sooner = new URLSearchParams(p);
  sooner.set("e", String(NOW + 100));
  assert.equal((await check("v", "3", sooner)).reason, "bad_signature");
  assert.equal((await verifyMediaLink({ APP_SECRET: APP_SECRET + "x" }, { kind: "v", lessonId: "3", params: p }, NOW + 1)).reason, "bad_signature");
  // Uppercase hex of the right signature is the same signature.
  const upper = new URLSearchParams(p);
  upper.set("sig", p.get("sig").toUpperCase());
  assert.equal((await check("v", "3", upper)).ok, true);
});

test("verifyMediaLink: malformed and far-future links", async () => {
  const base = { e: String(NOW + 100), s: "public", sig: "a".repeat(64) };
  const check = (kind, id, over) => verifyMediaLink(env, { kind, lessonId: id, params: new URLSearchParams({ ...base, ...over }) }, NOW);
  for (const [kind, id, over] of [
    ["x", "1", {}],
    ["v", "0", {}],
    ["v", "01", {}],
    ["v", "1e3", {}],
    ["v", "1", { e: "abc" }],
    ["v", "1", { s: "PUBLIC" }],
    ["v", "1", { s: "0123" }],
    ["v", "1", { sig: "zz" }],
  ]) {
    assert.equal((await check(kind, id, over)).reason, "malformed", `${kind} ${id} ${JSON.stringify(over)}`);
  }
  // Signed with a 1-day expiry by someone holding the secret: still refused (max 2 h + skew).
  const exp = NOW + 86_400;
  const sig = createHmac("sha256", APP_SECRET).update(`v|1|${exp}|public`).digest("hex");
  assert.equal((await check("v", "1", { e: String(exp), sig })).reason, "expired");
});

test("session cookie hash and tags", async () => {
  // Integration: media.ts reads the cookie through W3's session.ts (one parser, one token shape).
  assert.equal(readCookie("a=1; __Host-fbc_s=xyz; b=2", "__Host-fbc_s"), "xyz");
  assert.equal(readCookie(null, "a"), null);
  const request = new Request("https://x.test/", { headers: { Cookie: `other=1; __Host-fbc_s=${TOKEN}` } });
  assert.equal(await sessionTokenHash(request), sha256(TOKEN));
  const bad = new Request("https://x.test/", { headers: { Cookie: "__Host-fbc_s=not valid!" } });
  assert.equal(await sessionTokenHash(bad), null);
  const short = new Request("https://x.test/", { headers: { Cookie: `__Host-fbc_s=${"A".repeat(20)}` } });
  assert.equal(await sessionTokenHash(short), null, "only W3's 43-character tokens");
  assert.equal(isSessionTag("public"), true);
  assert.equal(isSessionTag(tagOf(TOKEN)), true);
  assert.equal(isSessionTag("0123"), false);
});

// ---------- upload rules ----------

const ok = (over = {}) => planUpload({ kind: "video", filename: "Lesson 1 – Base.mp4", size: 25 * MiB, contentType: "video/mp4", ...over });

test("planUpload: plans parts for an allowed file", () => {
  const plan = ok();
  assert.equal(plan.kind, "video");
  assert.equal(plan.contentType, "video/mp4");
  assert.equal(plan.partSize, 10 * MiB);
  assert.equal(plan.partCount, 3);
  assert.equal(planUpload({ kind: "image", filename: "cover.JPEG", size: 1000, contentType: "image/jpeg" }).ext, "jpg");
  assert.equal(planUpload({ kind: "captions", filename: "a.vtt", size: 10, contentType: "text/vtt" }).partCount, 1);
  assert.equal(planUpload({ kind: "file", filename: "notes.pdf", size: 10, contentType: "application/pdf; x=1" }).contentType, "application/pdf");
});

test("planUpload: refuses wrong kinds, types, extensions and sizes", () => {
  const code = (over) => {
    try {
      ok(over);
      return "accepted";
    } catch (err) {
      assert.ok(err instanceof ValidationError);
      return `${err.field}:${err.code}`;
    }
  };
  assert.equal(code({ kind: "audio" }), "kind:upload_invalid");
  assert.equal(code({ contentType: "video/quicktime", filename: "a.mov" }), "contentType:upload_invalid");
  assert.equal(code({ contentType: "video/mp4", filename: "a.mov" }), "contentType:upload_invalid");
  assert.equal(code({ contentType: "text/html", filename: "a.html" }), "contentType:upload_invalid");
  assert.equal(code({ contentType: "video/mp4", filename: "a.webm" }), "filename:upload_invalid");
  assert.equal(code({ contentType: "video/mp4", filename: "noext" }), "filename:upload_invalid");
  assert.equal(code({ filename: "" }), "filename:upload_invalid");
  assert.equal(code({ filename: "a\u0000.mp4" }), "filename:upload_invalid");
  assert.equal(code({ filename: "x".repeat(198) + ".mp4" }), "filename:upload_invalid");
  assert.equal(code({ size: 0 }), "size:upload_invalid");
  assert.equal(code({ size: 1.5 }), "size:upload_invalid");
  assert.equal(code({ size: "100" }), "size:upload_invalid");
  assert.equal(code({ size: 4 * 1024 * MiB + 1 }), "size:upload_too_large");
  assert.equal(code({ size: 4 * 1024 * MiB }), "accepted");
  assert.equal(code({ kind: "image", contentType: "image/svg+xml", filename: "a.svg", size: 10 }), "contentType:upload_invalid");
  assert.equal(code({ kind: "image", contentType: "image/png", filename: "a.png", size: 11 * MiB }), "size:upload_too_large");
  assert.equal(code({ kind: "captions", contentType: "text/vtt", filename: "a.vtt", size: 2 * MiB }), "size:upload_too_large");
});

test("expectedPartSize: equal parts, then the remainder", () => {
  const part = 10 * MiB;
  const size = 2 * part + 5;
  assert.equal(expectedPartSize(size, part, 1), part);
  assert.equal(expectedPartSize(size, part, 2), part);
  assert.equal(expectedPartSize(size, part, 3), 5);
  assert.equal(expectedPartSize(size, part, 4), null);
  assert.equal(expectedPartSize(size, part, 0), null);
  assert.equal(expectedPartSize(part, part, 1), part);
  assert.equal(expectedPartSize(part, part, 2), null);
});

test("mediaKey and safeBaseName", () => {
  const key = mediaKey({ kind: "video", originalName: "Bridal Look (Final) – v2.MP4", ext: "mp4" }, NOW, "0123456789abcdef");
  assert.match(key, MEDIA_KEY_RE);
  assert.ok(key.startsWith("videos/2026/09/0123456789abcdef-bridal-look-final-v2.mp4"), key);
  assert.equal(safeBaseName("../../etc/passwd"), "etc-passwd");
  assert.equal(safeBaseName("जय.mp4"), "file");
  assert.equal(safeBaseName("Crème brûlée.png"), "creme-brulee");
  assert.equal(safeBaseName("a".repeat(100) + ".mp4").length, 60);
  assert.match(mediaKey({ kind: "image", originalName: "-".repeat(80) + ".png", ext: "png" }, NOW, "ffffffffffffffff"), MEDIA_KEY_RE);
  assert.throws(() => mediaKey({ kind: "video", originalName: "a.mp4", ext: "mp4" }, NOW, "xyz"));
  assert.equal(MEDIA_KEY_RE.test("backups/d1/2026.sql.gz"), false);
  assert.equal(MEDIA_KEY_RE.test("videos/2026/10/0123456789abcdef-../x.mp4"), false);
});

test("sniffMismatch: first bytes must match the type", () => {
  const enc = (s) => new TextEncoder().encode(s);
  assert.equal(sniffMismatch("video/mp4", mp4Bytes(64)), null);
  const mov = mp4Bytes(64);
  mov.set(enc("qt  "), 8);
  assert.match(sniffMismatch("video/mp4", mov), /MP4/);
  assert.match(sniffMismatch("video/mp4", enc("<html><script>alert(1)</script>")), /not an MP4/);
  assert.equal(sniffMismatch("video/webm", new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1])), null);
  assert.equal(sniffMismatch("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), null);
  assert.equal(sniffMismatch("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), null);
  assert.equal(sniffMismatch("image/webp", enc("RIFF\0\0\0\0WEBPVP8 ")), null);
  assert.match(sniffMismatch("image/png", enc("GIF89a")), /PNG/);
  assert.equal(sniffMismatch("application/pdf", enc("%PDF-1.7\n")), null);
  assert.equal(sniffMismatch("text/vtt", enc("WEBVTT\n\n00:00.000 --> 00:01.000\nनमस्ते\n")), null);
  assert.equal(sniffMismatch("text/vtt", new Uint8Array([0xef, 0xbb, 0xbf, ...enc("WEBVTT - title\n")])), null);
  assert.match(sniffMismatch("text/vtt", enc("1\n00:00:00,000 --> 00:00:01,000\nHi\n")), /WebVTT/);
  assert.match(sniffMismatch("text/vtt", enc("WEBVTTX")), /WebVTT/);
  assert.match(sniffMismatch("text/vtt", new Uint8Array([...enc("WEBVTT\n"), 0xff, 0xfe])), /UTF-8/);
  assert.match(sniffMismatch("text/html", enc("<html>")), /not allowed/);
});

test("formatBytes", () => {
  assert.equal(formatBytes(4 * 1024 * MiB), "4 GB");
  assert.equal(formatBytes(10 * MiB), "10 MB");
  assert.equal(formatBytes(1), "1 KB");
});
