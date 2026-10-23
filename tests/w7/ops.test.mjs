// W7 operations: bump(), backups, the daily job, rate-limit helpers, request screening, /api/t.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { createTestDb } from "../helpers/d1.mjs";
import { createFakeR2 } from "../helpers/r2.mjs";
import { context, postJson, req } from "../helpers/http.mjs";
import { bump, statDay } from "../../functions/_lib/analytics.ts";
import {
  BACKUP_EXCLUDED,
  BACKUP_KEEP,
  BACKUP_PREFIX,
  BACKUP_TABLES,
  backupKey,
  dumpDatabase,
  pruneBackups,
  runBackup,
  sqlLiteral,
} from "../../functions/_lib/backup.ts";
import { claimDailyRun, maybeRunDaily, runDaily, DAILY_INTERVAL, SESSION_GRACE } from "../../functions/_lib/daily.ts";
import { contactSubject, enforceRateLimits, ipSubject } from "../../functions/_lib/guard.ts";
import { bodyLimit, isLikelyBot, screenRequest, MAX_BODY_BYTES } from "../../functions/_lib/abuse.ts";
import { handleTrack } from "../../functions/api/t.ts";
import { onRequest } from "../../functions/_middleware.ts";
import { getSetting } from "../../functions/_lib/db/settings.ts";

const NOW = Date.UTC(2026, 9, 23, 6, 0, 0) / 1000;
const BROWSER = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";

// ---------------------------------------------------------------- analytics

test("bump(): upserts one counter per (day, course), inside a batch", async () => {
  const db = await createTestDb();
  await db.batch([bump(db, "2026-10-23", 1, "views"), bump(db, "2026-10-23", 1, "views", 2), bump(db, "2026-10-23", 0, "revenue_paise", 299900)]);
  assert.equal(db.get("SELECT views FROM daily_stats WHERE day = '2026-10-23' AND course_id = 1").views, 3);
  assert.equal(db.get("SELECT revenue_paise FROM daily_stats WHERE course_id = 0").revenue_paise, 299900);
  assert.throws(() => bump(db, "2026-10-23", 1, "views; DROP TABLE x"), /unknown counter/);
  assert.throws(() => bump(db, "23-10-2026", 1, "views"), /bad day/);
  assert.throws(() => bump(db, "2026-10-23", -1, "views"), /bad course/);
  assert.throws(() => bump(db, "2026-10-23", 1, "views", 0.5), /bad increment/);
  assert.equal(statDay(NOW), "2026-10-23");
});

// ---------------------------------------------------------------- backups

test("every table is either backed up or deliberately excluded", async () => {
  const db = await createTestDb();
  const tables = db.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name).sort();
  assert.deepEqual([...BACKUP_TABLES, ...BACKUP_EXCLUDED].sort(), tables);
});

test("sqlLiteral quotes safely", () => {
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(42), "42");
  assert.equal(sqlLiteral(0.1), "0.1");
  assert.equal(sqlLiteral(Number.NaN), "NULL");
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral("a\u0000b"), "CAST(X'610062' AS TEXT)");
  assert.equal(sqlLiteral(new Uint8Array([1, 255])), "X'01ff'");
  assert.equal(sqlLiteral("'); DROP TABLE courses; --"), "'''); DROP TABLE courses; --'");
});

test("a dump restores into a freshly migrated database with every row intact", async () => {
  const db = await createTestDb();
  db.prepare("INSERT INTO students (name, phone, email, created_at, updated_at) VALUES (?, ?, ?, 1, 1)").bind("Asha 'A' Patel", "+919800000001", "a@example.com").run();
  db.prepare("UPDATE courses SET description = ? WHERE id = 1").bind("Line one\nLine two; with 'quotes' and emoji 💄").run();
  db.prepare("INSERT INTO sessions (token_hash, student_id, created_at, last_seen_at, expires_at) VALUES (?, 1, 1, 1, 99)").bind("a".repeat(64)).run();

  const { sql, rows } = await dumpDatabase(db, { now: NOW, pageRows: 3 }); // small pages exercise paging
  assert.equal(rows.students, 1);
  assert.equal(rows.lessons, db.get("SELECT count(*) AS n FROM lessons").n);
  assert.ok(!sql.includes("sessions ("), "sessions are never in a backup");
  assert.match(sql, /^PRAGMA defer_foreign_keys = ON;$/m);

  // Restore: migrate an empty database (the seed rows appear), then run the dump on top.
  const target = await createTestDb();
  target.exec(sql);
  for (const table of BACKUP_TABLES) {
    const before = db.rows(`SELECT * FROM ${table} ORDER BY rowid`);
    const after = target.rows(`SELECT * FROM ${table} ORDER BY rowid`);
    assert.deepEqual(after, before, `${table} round-trips`);
  }
});

test("runBackup writes a gzipped dump to R2, records last_backup_at and keeps BACKUP_KEEP dumps", async () => {
  const db = await createTestDb();
  const bucket = createFakeR2();
  for (let i = 0; i < BACKUP_KEEP + 2; i++) await bucket.put(backupKey(NOW - (i + 1) * 86_400), "old");
  await bucket.put("videos/keep-me.mp4", "video");

  const result = await runBackup({ DB: db, MEDIA: bucket }, NOW);
  assert.equal(result.key, `${BACKUP_PREFIX}2026-10-23T06-00-00Z.sql.gz`);
  const stored = bucket.objects.get(result.key);
  const text = gunzipSync(Buffer.from(stored.bytes)).toString("utf8");
  assert.match(text, /INSERT INTO courses/);
  assert.equal(await getSetting(db, "last_backup_at"), NOW);
  assert.equal(result.deleted.length, 3, "the 3 oldest go");
  const left = [...bucket.objects.keys()].filter((k) => k.startsWith(BACKUP_PREFIX));
  assert.equal(left.length, BACKUP_KEEP);
  assert.ok(bucket.objects.has("videos/keep-me.mp4"), "pruning never touches other prefixes");
  assert.deepEqual(await pruneBackups(bucket), []);
});

// ---------------------------------------------------------------- daily job

test("claimDailyRun: one winner per interval", async () => {
  const db = await createTestDb();
  assert.equal(await claimDailyRun(db, NOW), true);
  assert.equal(await claimDailyRun(db, NOW + 5), false);
  assert.equal(await claimDailyRun(db, NOW + DAILY_INTERVAL - 1), false);
  assert.equal(await claimDailyRun(db, NOW + DAILY_INTERVAL), true);
});

test("runDaily: cleans up expired rows, aborts abandoned uploads, backs up, and logs", async () => {
  const db = await createTestDb();
  const bucket = createFakeR2();
  db.prepare("INSERT INTO students (name, phone, created_at, updated_at) VALUES ('S', '+919800000002', 1, 1)").run();
  const sid = db.get("SELECT id FROM students").id;
  const old = NOW - SESSION_GRACE - 10;
  db.prepare("INSERT INTO sessions (token_hash, student_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 1, 1, ?)").bind("b".repeat(64), sid, old).run();
  db.prepare("INSERT INTO sessions (token_hash, student_id, created_at, last_seen_at, expires_at) VALUES (?, ?, 1, 1, ?)").bind("c".repeat(64), sid, NOW + 1000).run();
  db.prepare("INSERT INTO rate_limits (bucket, count, expires_at) VALUES ('x:1:1', 1, ?), ('x:2:2', 1, ?)").bind(NOW - 1, NOW + 100).run();
  const upload = await bucket.createMultipartUpload("videos/abandoned.mp4");
  db.prepare("INSERT INTO media (key, kind, content_type, size_bytes, upload_id, status, created_at, updated_at) VALUES ('videos/abandoned.mp4', 'video', 'video/mp4', 10, ?, 'uploading', 1, 1)")
    .bind(upload.uploadId)
    .run();

  const result = await runDaily({ DB: db, MEDIA: bucket }, NOW);
  assert.deepEqual(result.errors, []);
  assert.equal(result.cleanup.sessions, 1);
  assert.equal(result.cleanup.rateLimits, 1);
  assert.equal(result.cleanup.uploads, 1);
  assert.equal(db.get("SELECT status FROM media").status, "aborted");
  assert.equal(db.get("SELECT count(*) AS n FROM sessions").n, 1, "live sessions stay");
  assert.ok(result.backup?.startsWith(BACKUP_PREFIX));
  assert.equal(db.get("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").action, "daily.run");

  // A second run the same day doesn't back up again.
  const again = await runDaily({ DB: db, MEDIA: bucket }, NOW + 60);
  assert.equal(again.backup, null);
});

test("runDaily: a failing step is logged and the others still run", async () => {
  const db = await createTestDb();
  const broken = { put() { throw new Error("R2 down"); }, list() { throw new Error("R2 down"); }, resumeMultipartUpload() { throw new Error("R2 down"); } };
  const original = console.error;
  console.error = () => {};
  try {
    const result = await runDaily({ DB: db, MEDIA: broken }, NOW);
    assert.ok(result.cleanup, "cleanup ran");
    assert.equal(result.backup, null);
    assert.match(result.errors.join(), /backup: R2 down/);
    assert.equal(db.get("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").action, "daily.failed");
  } finally {
    console.error = original;
  }
});

test("maybeRunDaily: runs in waitUntil once, and does nothing without a database", async () => {
  const db = await createTestDb();
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  await maybeRunDaily({ DB: db }, ctx);
  await maybeRunDaily({ DB: db }, ctx);
  assert.equal(waits.length, 1);
  await Promise.all(waits);
  await maybeRunDaily({}, ctx);
  assert.equal(waits.length, 1);
});

// ---------------------------------------------------------------- rate-limit helpers

test("ipSubject: IPv4 as is, IPv6 per /64", () => {
  assert.equal(ipSubject(req("/", { ip: "203.0.113.9" })), "203.0.113.9");
  assert.equal(ipSubject(req("/", { ip: "2001:db8:abcd:12:1:2:3:4" })), "2001:db8:abcd:12::/64");
  assert.equal(ipSubject(req("/", { ip: "2001:0db8:abcd:0012:ffff::1" })), "2001:db8:abcd:12::/64");
  assert.equal(ipSubject(req("/", { ip: "2001:db8::1" })), "2001:db8:0:0::/64");
  assert.equal(ipSubject(req("/", { ip: "fe80::1%eth0" })), "fe80:0:0:0::/64");
  assert.equal(ipSubject(req("/")), "unknown");
});

test("contactSubject hashes and normalises", async () => {
  const a = await contactSubject(" +91 98000 00001 ");
  assert.equal(a, await contactSubject("+919800000001"));
  assert.match(a, /^h:[0-9a-f]{40}$/);
  assert.ok(!a.includes("98000"));
});

test("enforceRateLimits: 429 with Retry-After past the limit; fail open or closed on errors", async () => {
  const db = await createTestDb();
  const rules = { signin_ip: { limit: 2, window: 60 } };
  const checks = [{ rule: "signin_ip", subject: "203.0.113.9" }];
  assert.equal(await enforceRateLimits(db, checks, { now: NOW, rules }), null);
  assert.equal(await enforceRateLimits(db, checks, { now: NOW, rules }), null);
  const res = await enforceRateLimits(db, checks, { now: NOW + 10, rules });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("Retry-After"), "50");
  const body = await res.json();
  assert.equal(body.error, "rate_limited");
  assert.equal(body.retryAfter, 50);

  const broken = { prepare() { throw new Error("D1 down"); } };
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal(await enforceRateLimits(broken, checks), null, "open by default");
    assert.equal((await enforceRateLimits(broken, checks, { onError: "closed" })).status, 503);
  } finally {
    console.error = original;
  }
});

// ---------------------------------------------------------------- request screening

test("screenRequest refuses odd methods, long URLs, NULs and oversized bodies", () => {
  assert.equal(screenRequest(req("/")), null);
  // fetch's Request refuses TRACE itself; the runtime can still deliver odd verbs like PROPFIND.
  assert.equal(screenRequest(new Request("https://x.in/", { method: "PROPFIND" })).status, 405);
  assert.equal(screenRequest(req(`/${"a".repeat(2100)}`)).status, 414);
  assert.equal(screenRequest(req("/a%00b")).status, 400);
  const big = new Request("https://x.in/api/order", { method: "POST", headers: { "Content-Length": String(MAX_BODY_BYTES + 1) }, body: "x" });
  assert.equal(screenRequest(big).status, 413);
  const part = new Request("https://x.in/api/admin/uploads/5/parts/1", { method: "PUT", headers: { "Content-Length": String(5 * 1024 * 1024) }, body: "x" });
  assert.equal(screenRequest(part), null, "upload parts may be large");
  assert.equal(bodyLimit("/api/razorpay/webhook"), 1024 * 1024);
});

test("the root middleware screens before anything else, with security headers", async () => {
  const res = await onRequest(context({ request: req(`/${"a".repeat(2100)}`), env: {} }));
  assert.equal(res.status, 414);
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
});

test("isLikelyBot", () => {
  assert.equal(isLikelyBot(BROWSER), false);
  for (const ua of [null, "", "curl/8.4", "Googlebot/2.1", "WhatsApp/2.23", "facebookexternalhit/1.1", "python-requests/2"]) assert.equal(isLikelyBot(ua), true, String(ua));
});

// ---------------------------------------------------------------- /api/t

const track = (body, opts = {}) => postJson("/api/t", body, { headers: { "User-Agent": BROWSER }, ip: "203.0.113.5", ...opts });

test("/api/t counts views of published courses and the hub", async () => {
  const db = await createTestDb();
  for (const c of [1, 1, 0]) assert.equal((await handleTrack(track({ c, e: "view" }), { DB: db }, NOW)).status, 204);
  assert.equal(db.get("SELECT views FROM daily_stats WHERE course_id = 1").views, 2);
  assert.equal(db.get("SELECT views FROM daily_stats WHERE course_id = 0").views, 1);
});

test("/api/t ignores drafts, unknown courses, bots and floods, and refuses bad input", async () => {
  const db = await createTestDb();
  assert.equal((await handleTrack(track({ c: 2, e: "view" }), { DB: db }, NOW)).status, 204, "draft");
  assert.equal((await handleTrack(track({ c: 999, e: "view" }), { DB: db }, NOW)).status, 204);
  await handleTrack(track({ c: 1, e: "view" }, { headers: { "User-Agent": "curl/8" } }), { DB: db }, NOW);
  assert.equal(db.get("SELECT count(*) AS n FROM daily_stats").n, 0);

  for (let i = 0; i < 70; i++) await handleTrack(track({ c: 1, e: "view" }), { DB: db }, NOW);
  // track_ip allows 60 a minute; the draft and unknown-course requests above used 2 of them.
  assert.equal(db.get("SELECT views FROM daily_stats WHERE course_id = 1").views, 58);

  assert.equal((await handleTrack(track({ c: "1", e: "view" }), { DB: db }, NOW)).status, 400);
  assert.equal((await handleTrack(track({ c: 1, e: "click" }), { DB: db }, NOW)).status, 400);
  assert.equal((await handleTrack(track({ c: 1, e: "view" }, { origin: "https://evil.example" }), { DB: db }, NOW)).status, 403);
  assert.equal((await handleTrack(req("/api/t"), { DB: db }, NOW)).status, 405);
  assert.equal((await handleTrack(track({ c: 1, e: "view" }), {}, NOW)).status, 204, "no database yet: a no-op");
});

