// functions/_lib/snapshot.ts and GET /api/public/snapshot: what the build renders from D1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/d1.mjs";
import { context, req, postJson, readJson } from "../helpers/http.mjs";
import { config } from "../../functions/_lib/config.ts";
import { readSnapshot, parseDetails, mediaImagePath, publicBusiness, canonicalCourseUrl } from "../../functions/_lib/snapshot.ts";
import { handleSnapshot, onRequest } from "../../functions/api/public/snapshot.ts";
import { seedSnapshot } from "../../src/data/seed-snapshot.ts";

const NOW = Date.UTC(2026, 9, 23, 6, 0, 0) / 1000; // 2026-10-23 11:30 IST
const cfg = config({});

test("a freshly seeded D1 gives the same snapshot as the build's seed", async () => {
  const db = await createTestDb();
  const live = await readSnapshot(db, cfg, NOW);
  const seed = seedSnapshot(NOW);
  // The seed course has no description in D1 either; everything else must match exactly.
  assert.deepEqual(live, seed);
});

test("only published, priced, non-deleted courses; drafts never leak", async () => {
  const db = await createTestDb();
  db.prepare("UPDATE courses SET status = 'published', published_at = 1, price_paise = 1500000 WHERE slug = 'diploma'").run();
  db.prepare("UPDATE courses SET status = 'published', published_at = 1, price_paise = 900000, deleted_at = 5 WHERE slug = 'combo'").run();
  const snap = await readSnapshot(db, cfg, NOW);
  assert.deepEqual(snap.courses.map((c) => c.slug), ["selfmakeup", "diploma"]);
});

test("lessons never carry a video reference; hasVideo and freePreview are booleans", async () => {
  const db = await createTestDb();
  db.prepare("UPDATE lessons SET video_provider = 'r2', video_ref = 'videos/secret-key.mp4', free_preview = 1, notes = 'private notes' WHERE id = 1").run();
  const snap = await readSnapshot(db, cfg, NOW);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes("secret-key"), "no R2 key in the public snapshot");
  assert.ok(!text.includes("private notes"));
  const lesson = snap.courses[0].modules[0].lessons[0];
  assert.equal(lesson.hasVideo, true);
  assert.equal(lesson.freePreview, true);
  assert.equal(snap.courses[0].modules[0].lessons[1].hasVideo, false);
});

test("the GSTIN is never in the snapshot, even when the owner stored one", async () => {
  const db = await createTestDb();
  db.prepare("UPDATE settings SET value = json_set(value, '$.gstin', '24ABCDE1234F1Z5', '$.extra', 'x') WHERE key = 'business'").run();
  const snap = await readSnapshot(db, cfg, NOW);
  const text = JSON.stringify(snap);
  assert.ok(!text.includes("24ABCDE1234F1Z5"));
  assert.ok(!/gstin/i.test(text));
  assert.deepEqual(Object.keys(snap.settings.business).sort(), ["address", "legalName", "name", "phone", "stateCode", "whatsapp"]);
});

test("hybrid courses list open, upcoming batches with seats left; online courses none", async () => {
  const db = await createTestDb();
  db.prepare("UPDATE courses SET status = 'published', published_at = 1, price_paise = 1500000 WHERE slug = 'diploma'").run();
  const diploma = db.get("SELECT id FROM courses WHERE slug = 'diploma'").id;
  const insert = (title, startsOn, status, seats, taken, price = null) =>
    db
      .prepare("INSERT INTO batches (course_id, title, starts_on, status, seats, seats_taken, price_paise, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)")
      .bind(diploma, title, startsOn, status, seats, taken, price)
      .run();
  insert("Past", "2026-10-01", "open", 10, 0);
  insert("Today", "2026-10-23", "open", 10, 4, 1200000);
  insert("Closed", "2026-11-01", "closed", 10, 0);
  insert("Later", "2026-12-01", "open", null, 0);
  insert("Overbooked", "2026-11-15", "open", 5, 7);
  // A batch on an online course is ignored.
  db.prepare("INSERT INTO batches (course_id, title, starts_on, created_at, updated_at) VALUES (1, 'Stray', '2026-11-01', 1, 1)").run();

  const snap = await readSnapshot(db, cfg, NOW);
  const d = snap.courses.find((c) => c.slug === "diploma");
  assert.deepEqual(d.batches.map((b) => [b.title, b.seatsLeft, b.pricePaise]), [
    ["Today", 6, 1200000],
    ["Overbooked", 0, null],
    ["Later", null, null],
  ]);
  assert.deepEqual(snap.courses.find((c) => c.slug === "selfmakeup").batches, []);
});

test("canonical URLs, media URLs and test mode", async () => {
  const db = await createTestDb();
  db.prepare("UPDATE courses SET domain_status = 'active', cover_key = 'covers/a b.webp', og_image_key = 'og/x.jpg' WHERE id = 1").run();
  const live = await readSnapshot(db, config({ RAZORPAY_KEY_ID: "rzp_live_abc123" }), NOW);
  const c = live.courses[0];
  assert.equal(c.domainActive, true);
  assert.equal(c.canonicalUrl, "https://selfmakeup.feelingsbeautycare.in/");
  assert.equal(c.coverUrl, "/media/i/covers/a%20b.webp");
  assert.equal(c.ogImageUrl, "https://courses.feelingsbeautycare.in/media/i/og/x.jpg");
  assert.equal(live.settings.testMode, false);
  assert.equal((await readSnapshot(db, cfg, NOW)).settings.testMode, true, "no keys: test mode");
  assert.equal(canonicalCourseUrl("diploma", false, cfg), "https://courses.feelingsbeautycare.in/c/diploma");
  assert.equal(mediaImagePath("a/../b?.png"), "/media/i/a/../b%3F.png");
});

test("content version and legal flag come from settings", async () => {
  const db = await createTestDb();
  db.prepare("UPDATE settings SET value = '7' WHERE key = 'content_version'").run();
  db.prepare("UPDATE settings SET value = 'true' WHERE key = 'legal_confirmed'").run();
  const snap = await readSnapshot(db, cfg, NOW);
  assert.equal(snap.contentVersion, 7);
  assert.equal(snap.settings.legalConfirmed, true);
});

test("parseDetails and publicBusiness are defensive", () => {
  assert.deepEqual(parseDetails("not json"), { outcomes: [], forWho: [], faqs: [], glimpses: [], highlights: [] });
  assert.deepEqual(
    parseDetails(JSON.stringify({ outcomes: ["a", 1], faqs: [{ q: "q", a: "a" }, { q: 1 }], glimpses: [{ youtubeId: "short", label: "x" }, { youtubeId: "AIXl9I2_X_w", label: "ok" }] })),
    { outcomes: ["a"], forWho: [], faqs: [{ q: "q", a: "a" }], glimpses: [{ youtubeId: "AIXl9I2_X_w", label: "ok" }], highlights: [] },
  );
  assert.deepEqual(publicBusiness(null), { name: "", legalName: "", address: "", stateCode: "", phone: "", whatsapp: "" });
});

test("GET /api/public/snapshot: 404 before setup, 200 JSON after, GET only", async () => {
  const before = await handleSnapshot(req("/api/public/snapshot"), {});
  assert.equal(before.status, 404, "never 5xx without a DB: the build falls back to the seed");
  assert.equal((await readJson(before)).error, "not_configured");

  const db = await createTestDb();
  const ctx = context({ request: req("/api/public/snapshot"), env: { DB: db } });
  const res = await onRequest(ctx);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("Content-Type"), /application\/json/);
  const body = await readJson(res);
  assert.equal(body.courses[0].slug, "selfmakeup");

  const post = await handleSnapshot(postJson("/api/public/snapshot", {}), { DB: db });
  assert.equal(post.status, 405);
});

test("GET /api/public/snapshot: a database error is a 5xx (the build must fail, not ship missing courses)", async () => {
  const broken = { prepare() { return { bind() { return this; } }; }, batch() { throw new Error("D1_ERROR: down"); } };
  const original = console.error;
  console.error = () => {};
  try {
    const res = await handleSnapshot(req("/api/public/snapshot"), { DB: broken });
    assert.equal(res.status, 500);
  } finally {
    console.error = original;
  }
});
