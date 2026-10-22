// The seed (migrations/0002_seed.sql) still matches src/data/course.ts and lessons.ts, and the
// build's seed snapshot (src/data/seed-snapshot.ts) matches the seeded database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/d1.mjs";
import { course } from "../../src/data/course.ts";
import { lessons } from "../../src/data/lessons.ts";
import { site } from "../../src/data/site.ts";
import { seedSnapshot, SEED_COURSE_ID, SEED_COURSE_SLUG } from "../../src/data/seed-snapshot.ts";
import { getSetting } from "../../functions/_lib/db/settings.ts";

const db = await createTestDb();

test("the demo course is marked demo, published, and matches course.ts", () => {
  const c = db.get("SELECT * FROM courses WHERE id = ?", SEED_COURSE_ID);
  assert.equal(c.slug, SEED_COURSE_SLUG);
  assert.equal(c.is_demo, 1, "seeded example content must be marked is_demo");
  assert.equal(c.status, "published");
  assert.equal(c.title, course.title);
  assert.equal(c.subtitle, course.subtitle);
  assert.equal(c.teacher, course.teacher);
  assert.equal(c.level, course.level);
  assert.equal(c.language, course.language);
  assert.equal(c.price_paise, course.price.amount);
  assert.equal(c.compare_at_paise, course.price.compareAt);
  assert.equal(c.certificate_title, course.certificate);
  assert.equal(c.access_days, 365, `course.access is "${course.access}"`);
  const details = JSON.parse(c.details);
  assert.deepEqual(details.outcomes, [...course.outcomes]);
  assert.deepEqual(details.forWho, [...course.forWho]);
  assert.deepEqual(details.faqs, course.faqs.map(({ q, a }) => ({ q, a })));
  assert.deepEqual(details.glimpses, course.glimpses.map(({ id, label }) => ({ youtubeId: id, label })));
  assert.deepEqual(details.highlights, []);
});

test("the demo course's modules and lessons match course.ts and lessons.ts, in order", () => {
  const modules = db.rows("SELECT id, position, title FROM modules WHERE course_id = ? ORDER BY position", SEED_COURSE_ID);
  assert.deepEqual(modules.map((m) => m.title), course.modules.map((m) => m.title));
  const rows = db.rows(
    `SELECT l.slug, l.title, l.minutes, l.video_provider, l.free_preview, m.position AS module_position, l.position
     FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.course_id = ? ORDER BY m.position, l.position`,
    SEED_COURSE_ID,
  );
  assert.equal(rows.length, lessons.length);
  rows.forEach((row, i) => {
    const lesson = lessons[i];
    assert.equal(row.slug, lesson.slug);
    assert.equal(row.title, lesson.title);
    assert.equal(row.minutes, lesson.minutes);
    assert.equal(row.module_position, lesson.moduleNumber);
    assert.equal(row.position, lesson.numberInModule);
    assert.equal(row.video_provider, "none");
    assert.equal(row.free_preview, 0);
  });
});

test("the academy courses are in-person drafts with no price and their real outlines", () => {
  const drafts = db.rows("SELECT id, slug, title, format, status, price_paise, is_demo, duration_text FROM courses WHERE id <> ? ORDER BY sort_order", SEED_COURSE_ID);
  assert.deepEqual(drafts.map((c) => c.slug), ["diploma", "crashcourse", "combo"]);
  for (const c of drafts) {
    assert.equal(c.format, "in_person");
    assert.equal(c.status, "draft");
    assert.equal(c.price_paise, null, `${c.slug} must wait for the owner's fee`);
    assert.equal(c.is_demo, 0);
  }
  assert.deepEqual(drafts.map((c) => c.duration_text), ["3 months", "5 days", "4–5 months"]);
  const counts = db.rows("SELECT course_id, count(*) AS n FROM lessons WHERE course_id <> ? GROUP BY course_id ORDER BY course_id", SEED_COURSE_ID);
  assert.deepEqual(counts.map((r) => r.n), [7, 5, 5]);
});

test("settings: business facts from site.ts, legal not confirmed, content version 1", async () => {
  const business = await getSetting(db, "business");
  assert.equal(business.name, site.name);
  assert.equal(business.phone, site.phone.tel);
  assert.equal(business.whatsapp, site.whatsappNumber);
  assert.equal(business.stateCode, "24");
  assert.equal(business.gstin, null);
  assert.equal(business.gstRateBp, 1800);
  assert.equal(await getSetting(db, "legal_confirmed"), false);
  assert.equal(await getSetting(db, "content_version"), 1);
});

test("the build's seed snapshot matches the seeded database", () => {
  const snap = seedSnapshot(0);
  assert.equal(snap.courses.length, 1, "drafts are never in a snapshot");
  const [c] = snap.courses;
  const row = db.get("SELECT * FROM courses WHERE id = ?", c.id);
  assert.equal(c.slug, row.slug);
  assert.equal(c.title, row.title);
  assert.equal(c.pricePaise, row.price_paise);
  assert.equal(c.isDemo, row.is_demo === 1);
  assert.equal(c.accessDays, row.access_days);
  assert.equal(c.certificateTitle, row.certificate_title);
  assert.deepEqual(c.details, JSON.parse(row.details));
  assert.equal(c.canonicalUrl, "https://courses.feelingsbeautycare.in/c/selfmakeup/");
  const dbLessons = db.rows(
    "SELECT l.id, l.slug, l.title, l.minutes, m.id AS module_id FROM lessons l JOIN modules m ON m.id = l.module_id WHERE l.course_id = ? ORDER BY m.position, l.position",
    c.id,
  );
  const snapLessons = c.modules.flatMap((m) => m.lessons.map((l) => ({ id: l.id, slug: l.slug, title: l.title, minutes: l.minutes, module_id: m.id })));
  assert.deepEqual(snapLessons, dbLessons.map((r) => ({ ...r })));
  assert.equal(snap.settings.testMode, true);
  assert.equal(snap.settings.legalConfirmed, false);
});

test("every seeded course is audited", () => {
  assert.equal(db.get("SELECT count(*) AS n FROM audit_log WHERE action = 'course.seed'").n, 4);
});
