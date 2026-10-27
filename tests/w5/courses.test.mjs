// W5 courses: list, create, edit, delete, outline order, publish/unpublish/archive, the subdomain
// check, and the deploy hook (debounce, failures, publish status).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "../helpers/d1.mjs";
import { checkDomain } from "../../functions/_lib/admin/courses.ts";
import {
  archiveCourseRoute,
  courseRoute,
  coursesRoute,
  outlineRoute,
  publishCourseRoute,
  publishSiteRoute,
  publishStatusRoute,
  unpublishCourseRoute,
} from "../../functions/_lib/admin/routes.ts";
import { publishStatus, requestRebuildAt } from "../../functions/_lib/rebuild.ts";
import { ConfigError } from "../../functions/_lib/config.ts";
import { adminFixture } from "./fixtures.mjs";

const contentVersion = (db) => Number(db.get("SELECT value FROM settings WHERE key = 'content_version'").value);

const NEW_COURSE = {
  slug: "Bridal-Basics",
  title: "Bridal Basics",
  format: "hybrid",
  pricePaise: 1_500_000,
  depositPaise: 500_000,
  details: { outcomes: ["Do a full bridal look"], faqs: [{ q: "Kit?", a: "Bring your own." }], glimpses: [{ youtubeId: "X6w8f8d0ON4", label: "Day one" }] },
};

test("lists the seeded courses with outline, batches and counts", async () => {
  const t = await adminFixture();
  const { status, body } = await t.call(coursesRoute, "GET", "/api/admin/courses");
  assert.equal(status, 200);
  assert.deepEqual(body.map((c) => c.id), [1, 2, 3, 4]);
  const demo = body[0];
  assert.equal(demo.isDemo, true);
  assert.equal(demo.status, "published");
  assert.equal(demo.lessonCount, 9);
  assert.equal(demo.modules.length, 3);
  assert.equal(demo.slugLocked, false);
  assert.deepEqual(Object.keys(demo.details).sort(), ["faqs", "forWho", "glimpses", "highlights", "outcomes"]);
  assert.equal(body[1].pricePaise, null, "academy drafts have no fee until the owner enters one");
  assert.equal(body[1].format, "hybrid");

  const one = await t.call(courseRoute, "GET", "/api/admin/courses/2", { params: { id: "2" } });
  assert.equal(one.status, 200);
  assert.equal(one.body.id, 2);
  assert.equal((await t.call(courseRoute, "GET", "/api/admin/courses/99", { params: { id: "99" } })).status, 404);
  assert.equal((await t.call(courseRoute, "GET", "/api/admin/courses/1x", { params: { id: "1x" } })).status, 404);
});

test("creates a draft with the owner's defaults and strict checks", async () => {
  const t = await adminFixture();
  const created = await t.call(coursesRoute, "POST", "/api/admin/courses", { body: NEW_COURSE });
  assert.equal(created.status, 201);
  const c = created.body;
  assert.equal(c.slug, "bridal-basics", "slugs are lowercased");
  assert.equal(c.status, "draft");
  assert.equal(c.accessDays, 365, "1 year of access by default");
  assert.equal(c.teacher, "Urmi Mengar");
  assert.equal(c.depositPaise, 500_000);
  assert.deepEqual(c.details.highlights, []);
  assert.equal(t.db.get("SELECT action FROM audit_log WHERE entity = 'course' AND entity_id = ?", String(c.id)).action, "course.create");

  const fail = async (body, field) => {
    const res = await t.call(coursesRoute, "POST", "/api/admin/courses", { body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok(res.body.fields[field], `${field}: ${JSON.stringify(res.body)}`);
  };
  await fail({ ...NEW_COURSE, slug: "admin" }, "slug");
  await fail({ ...NEW_COURSE, slug: "a" }, "slug");
  await fail({ ...NEW_COURSE, slug: "bad--slug" }, "slug");
  await fail({ ...NEW_COURSE, slug: undefined }, "slug");
  await fail({ ...NEW_COURSE, slug: "ok-slug", title: "" }, "title");
  await fail({ ...NEW_COURSE, slug: "ok-slug", pricePaise: 50 }, "pricePaise");
  await fail({ ...NEW_COURSE, slug: "ok-slug", pricePaise: 1.5 }, "pricePaise");
  await fail({ ...NEW_COURSE, slug: "ok-slug", compareAtPaise: 100_000 }, "compareAtPaise");
  await fail({ ...NEW_COURSE, slug: "ok-slug", format: "online" }, "depositPaise");
  await fail({ ...NEW_COURSE, slug: "ok-slug", format: "webinar" }, "format");
  await fail({ ...NEW_COURSE, slug: "ok-slug", accessDays: 0 }, "accessDays");
  await fail({ ...NEW_COURSE, slug: "ok-slug", details: { glimpses: [{ youtubeId: "short", label: "x" }] } }, "details.glimpses[0].youtubeId");
  await fail({ ...NEW_COURSE, slug: "ok-slug", details: { outcomes: "not a list" } }, "details.outcomes");
  await fail({ ...NEW_COURSE, slug: "ok-slug", coverKey: "../etc/passwd" }, "coverKey");
  await fail({ ...NEW_COURSE, slug: "ok-slug", coverKey: "images/never-uploaded.webp" }, "coverKey");
  await fail({ ...NEW_COURSE, slug: "ok-slug", title: "line\u0000break" }, "title");

  const taken = await t.call(coursesRoute, "POST", "/api/admin/courses", { body: { ...NEW_COURSE, slug: "selfmakeup" } });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error, "slug_taken");

  // The schema's long texts fit (bodies up to 128 KB here, not the 16 KB default).
  const long = await t.call(coursesRoute, "POST", "/api/admin/courses", {
    body: { ...NEW_COURSE, slug: "long-text", description: "Line of text.\n".repeat(1400) },
  });
  assert.equal(long.status, 201);
  assert.ok(long.body.description.length > 16_000);

  // A cover that W4 finished uploading is accepted.
  t.db.sqlite
    .prepare("INSERT INTO media (key, kind, content_type, size_bytes, status, created_at, updated_at) VALUES (?, 'image', 'image/webp', 10, 'ready', 1, 1)")
    .run("images/cover.webp");
  const withCover = await t.call(coursesRoute, "POST", "/api/admin/courses", { body: { ...NEW_COURSE, slug: "with-cover", coverKey: "images/cover.webp" } });
  assert.equal(withCover.status, 201);
  assert.equal(withCover.body.coverKey, "images/cover.webp");
});

test("edits keep unsent fields, lock a live subdomain and mark published content as changed", async () => {
  const t = await adminFixture();
  const before = contentVersion(t.db);
  const draft = await t.call(courseRoute, "PUT", "/api/admin/courses/2", { params: { id: "2" }, body: { pricePaise: 2_500_000, slug: "makeup-diploma" } });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.pricePaise, 2_500_000);
  assert.equal(draft.body.slug, "makeup-diploma");
  assert.equal(draft.body.format, "hybrid", "unsent fields keep their value");
  assert.equal(contentVersion(t.db), before, "a draft isn't on the site");
  const audit = JSON.parse(t.db.get("SELECT data FROM audit_log WHERE action = 'course.update' ORDER BY id DESC").data);
  assert.deepEqual(audit.slug, { from: "diploma", to: "makeup-diploma" });

  const published = await t.call(courseRoute, "PUT", "/api/admin/courses/1", { params: { id: "1" }, body: { subtitle: "New subtitle" } });
  assert.equal(published.status, 200);
  assert.equal(contentVersion(t.db), before + 1, "a published course's edit bumps content_version");

  const noChange = await t.call(courseRoute, "PUT", "/api/admin/courses/1", { params: { id: "1" }, body: { subtitle: "New subtitle" } });
  assert.equal(noChange.status, 200);
  assert.equal(contentVersion(t.db), before + 1, "no change, no bump");

  const clearFee = await t.call(courseRoute, "PUT", "/api/admin/courses/1", { params: { id: "1" }, body: { pricePaise: null } });
  assert.equal(clearFee.status, 400, "a published course keeps a fee");

  t.db.sqlite.exec("UPDATE courses SET domain_status = 'active' WHERE id = 1");
  const locked = await t.call(courseRoute, "PUT", "/api/admin/courses/1", { params: { id: "1" }, body: { slug: "self-makeup" } });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error, "slug_locked");

  t.db.sqlite.exec("UPDATE courses SET domain_status = 'pending' WHERE id = 3");
  const renamed = await t.call(courseRoute, "PUT", "/api/admin/courses/3", { params: { id: "3" }, body: { slug: "crash-course" } });
  assert.equal(renamed.body.domainStatus, "none", "a new slug needs its own subdomain check");

  const clash = await t.call(courseRoute, "PUT", "/api/admin/courses/4", { params: { id: "4" }, body: { slug: "crash-course" } });
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error, "slug_taken");
});

test("publish needs a fee and content; unpublish and archive move it off the site", async () => {
  const t = await adminFixture();
  const id = { params: { id: "2" } };
  const noFee = await t.call(publishCourseRoute, "POST", "/api/admin/courses/2/publish", id);
  assert.equal(noFee.status, 400);
  assert.ok(noFee.body.fields.pricePaise);

  await t.call(courseRoute, "PUT", "/api/admin/courses/2", { ...id, body: { pricePaise: 3_000_000 } });
  const before = contentVersion(t.db);
  const ok = await t.call(publishCourseRoute, "POST", "/api/admin/courses/2/publish", id);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.course.status, "published");
  assert.ok(ok.body.course.publishedAt > 0);
  assert.deepEqual(ok.body.rebuild.queued, false);
  assert.equal(ok.body.rebuild.reason, "no_hook", "no deploy hook configured in this env");
  assert.equal(contentVersion(t.db), before + 1);

  const un = await t.call(unpublishCourseRoute, "POST", "/api/admin/courses/2/unpublish", id);
  assert.equal(un.body.course.status, "draft");
  const again = await t.call(unpublishCourseRoute, "POST", "/api/admin/courses/2/unpublish", id);
  assert.equal(again.status, 200, "idempotent");
  const arch = await t.call(archiveCourseRoute, "POST", "/api/admin/courses/2/archive", id);
  assert.equal(arch.body.course.status, "archived");
  const unArch = await t.call(unpublishCourseRoute, "POST", "/api/admin/courses/2/unpublish", id);
  assert.equal(unArch.status, 409, "only a published course can be unpublished");

  // An online course needs a lesson; an in-person one an open batch.
  const online = await t.call(coursesRoute, "POST", "/api/admin/courses", { body: { slug: "empty-online", title: "Empty", pricePaise: 100_000 } });
  const r1 = await t.call(publishCourseRoute, "POST", "/", { params: { id: String(online.body.id) } });
  assert.equal(r1.status, 400);
  assert.ok(r1.body.fields.modules);
  const inPerson = await t.call(coursesRoute, "POST", "/api/admin/courses", {
    body: { slug: "empty-batch", title: "Empty", pricePaise: 100_000, format: "in_person" },
  });
  const r2 = await t.call(publishCourseRoute, "POST", "/", { params: { id: String(inPerson.body.id) } });
  assert.ok(r2.body.fields.batches);
  const actions = t.db.rows("SELECT action FROM audit_log WHERE entity = 'course' AND entity_id = '2' ORDER BY id").map((r) => r.action);
  assert.deepEqual(actions.slice(-4), ["course.update", "course.publish", "course.unpublish", "course.archive"]);
});

test("delete: only an unsold draft, and its subdomain is freed", async () => {
  const t = await adminFixture();
  const demo = await t.call(courseRoute, "DELETE", "/api/admin/courses/1", { params: { id: "1" } });
  assert.equal(demo.status, 409);
  assert.equal(demo.body.error, "in_use");

  const gone = await t.call(courseRoute, "DELETE", "/api/admin/courses/2", { params: { id: "2" } });
  assert.equal(gone.status, 204);
  const row = t.db.get("SELECT slug, deleted_at FROM courses WHERE id = 2");
  assert.ok(row.deleted_at > 0);
  assert.match(row.slug, /^deleted-2-[0-9a-f]{6}$/);
  assert.equal((await t.call(courseRoute, "GET", "/", { params: { id: "2" } })).status, 404);
  const list = await t.call(coursesRoute, "GET", "/api/admin/courses");
  assert.equal(list.body.some((c) => c.id === 2), false);
  const reuse = await t.call(coursesRoute, "POST", "/api/admin/courses", { body: { slug: "diploma", title: "Diploma again" } });
  assert.equal(reuse.status, 201, "the slug is free again");

  // A draft somebody is enrolled in can't be deleted.
  t.db.sqlite.exec(
    "INSERT INTO students (id, name, phone, created_at, updated_at) VALUES (50, 'A', '+919800000050', 1, 1);" +
      "INSERT INTO enrollments (student_id, course_id, source, mode, starts_at, created_at, updated_at) VALUES (50, 3, 'manual', 'live', 1, 1, 1);",
  );
  assert.equal((await t.call(courseRoute, "DELETE", "/", { params: { id: "3" } })).status, 409);
});

test("outline: reorders, renames, swaps slugs, adds and removes, keeping ids", async () => {
  const t = await adminFixture();
  const course = (await t.call(courseRoute, "GET", "/", { params: { id: "1" } })).body;
  const [m1, m2, m3] = course.modules;
  const strip = (l) => ({ ...l, moduleId: undefined, position: undefined });
  // Swap the slugs of the first two lessons, move module 3 to the front, drop the last lesson,
  // and add a new module with a new lesson.
  const [a, b, ...restOfM1] = m1.lessons;
  const dropped = m3.lessons[m3.lessons.length - 1];
  t.db.sqlite.prepare("INSERT INTO students (id, name, phone, created_at, updated_at) VALUES (60, 'P', '+919800000060', 1, 1)").run();
  t.db.sqlite.prepare("INSERT INTO lesson_progress (student_id, lesson_id, position_seconds, updated_at) VALUES (60, ?, 5, 1)").run(a.id);
  t.db.sqlite.prepare("INSERT INTO lesson_progress (student_id, lesson_id, position_seconds, updated_at) VALUES (60, ?, 5, 1)").run(dropped.id);
  const body = {
    modules: [
      { id: m3.id, title: `${m3.title} (moved)`, lessons: m3.lessons.slice(0, -1).map(strip) },
      { id: m1.id, title: m1.title, lessons: [{ ...strip(a), slug: b.slug }, { ...strip(b), slug: a.slug, title: "Renamed" }, ...restOfM1.map(strip)] },
      { id: m2.id, title: m2.title, lessons: m2.lessons.map(strip) },
      { title: "Bonus", lessons: [{ slug: "bonus-look", title: "Bonus look", minutes: 7, videoProvider: "youtube", videoRef: "X6w8f8d0ON4" }] },
    ],
  };
  const before = contentVersion(t.db);
  const res = await t.call(outlineRoute, "PUT", "/", { params: { id: "1" }, body });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const out = res.body;
  assert.deepEqual(out.modules.map((m) => m.id).slice(0, 3), [m3.id, m1.id, m2.id]);
  assert.deepEqual(out.modules.map((m) => m.position), [1, 2, 3, 4]);
  assert.equal(out.modules[0].title, `${m3.title} (moved)`);
  assert.equal(out.modules[1].lessons[0].id, a.id, "ids are kept");
  assert.equal(out.modules[1].lessons[0].slug, b.slug);
  assert.equal(out.modules[1].lessons[1].slug, a.slug);
  assert.equal(out.modules[1].lessons[1].title, "Renamed");
  assert.deepEqual(out.modules[1].lessons.map((l) => l.position), out.modules[1].lessons.map((_, i) => i + 1));
  assert.equal(out.modules[3].lessons[0].videoRef, "X6w8f8d0ON4");
  assert.equal(out.lessonCount, 9, "one removed, one added");
  assert.equal(t.db.get("SELECT count(*) AS n FROM lessons WHERE id = ?", dropped.id).n, 0);
  assert.equal(t.db.get("SELECT count(*) AS n FROM lesson_progress WHERE lesson_id = ?", a.id).n, 1, "kept lesson keeps progress");
  assert.equal(t.db.get("SELECT count(*) AS n FROM lesson_progress WHERE lesson_id = ?", dropped.id).n, 0);
  assert.equal(contentVersion(t.db), before + 1);
  assert.equal(t.db.get("SELECT count(*) AS n FROM lessons WHERE slug LIKE 'tmp-reorder-%'").n, 0);

  const bad = async (modules, field) => {
    const r = await t.call(outlineRoute, "PUT", "/", { params: { id: "1" }, body: { modules } });
    assert.equal(r.status, 400, JSON.stringify(modules));
    assert.ok(r.body.fields[field], `${field}: ${JSON.stringify(r.body)}`);
  };
  const lesson = { slug: "x", title: "X" };
  await bad([{ title: "M", lessons: [lesson, { ...lesson }] }], "modules[0].lessons[1].slug");
  await bad([{ title: "M", lessons: [{ ...lesson, slug: "certificate" }] }], "modules[0].lessons[0].slug");
  await bad([{ title: "M", lessons: [{ ...lesson, slug: "tmp-reorder-5" }] }], "modules[0].lessons[0].slug");
  const foreign = t.db.get("SELECT id FROM lessons WHERE course_id = 2").id;
  await bad([{ title: "M", lessons: [{ ...lesson, id: foreign }] }], "modules[0].lessons[0].id");
  await bad([{ id: 4, title: "M", lessons: [] }], "modules[0].id");
  await bad([{ title: "M", lessons: [{ ...lesson, videoProvider: "r2", videoRef: "videos/missing.mp4" }] }], "modules[0].lessons[0].videoRef");
  await bad([{ title: "M", lessons: [{ ...lesson, videoProvider: "none", videoRef: "abc" }] }], "modules[0].lessons[0].videoRef");
  await bad([{ title: "M", lessons: [{ ...lesson, videoProvider: "stream", videoRef: "abc" }] }], "modules[0].lessons[0].videoProvider");
  await bad([{ title: "M", lessons: [{ ...lesson, minutes: 601 }] }], "modules[0].lessons[0].minutes");
  await bad("nope", "modules");

  t.db.sqlite
    .prepare("INSERT INTO media (key, kind, content_type, size_bytes, status, created_at, updated_at) VALUES ('videos/l1.mp4', 'video', 'video/mp4', 10, 'ready', 1, 1)")
    .run();
  const r2 = await t.call(outlineRoute, "PUT", "/", {
    params: { id: "1" },
    body: { modules: [{ title: "Only", lessons: [{ slug: "one", title: "One", videoProvider: "r2", videoRef: "videos/l1.mp4" }] }] },
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.lessonCount, 1);
  assert.equal(t.db.get("SELECT count(*) AS n FROM modules WHERE course_id = 1").n, 1, "left-out modules are deleted");
});

test("domain check: reachable marks it active (slug locked); a blip never unlocks it", async () => {
  const db = await createTestDb();
  const ok = async () => new Response("hi", { status: 200 });
  const down = async () => {
    throw new TypeError("fetch failed");
  };
  const seen = [];
  const spy = async (url, init) => {
    seen.push({ url, redirect: init.redirect });
    return new Response(null, { status: 522 });
  };
  const pending = await checkDomain(db, 2, "feelingsbeautycare.in", 1000, spy);
  assert.deepEqual(pending, { host: "diploma.feelingsbeautycare.in", status: "pending", probe: 522 });
  assert.deepEqual(seen, [{ url: "https://diploma.feelingsbeautycare.in/", redirect: "manual" }]);

  const active = await checkDomain(db, 2, "feelingsbeautycare.in", 1001, ok);
  assert.equal(active.status, "active");
  assert.equal(db.get("SELECT domain_status FROM courses WHERE id = 2").domain_status, "active");
  const blip = await checkDomain(db, 2, "feelingsbeautycare.in", 1002, down);
  assert.deepEqual(blip, { host: "diploma.feelingsbeautycare.in", status: "active", probe: "unreachable" });
});

test("deploy hook: debounced, released on failure, only to Cloudflare", async () => {
  const db = await createTestDb();
  const env = { DB: db, DEPLOY_HOOK_URL: "https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/abc" };
  const calls = [];
  const okFetch = async (url, init) => {
    calls.push({ url, method: init.method });
    return new Response("{}", { status: 200 });
  };
  const first = await requestRebuildAt(env, 10_000, okFetch);
  assert.deepEqual(first, { queued: true, nextAllowedAt: 10_120 });
  assert.deepEqual(calls, [{ url: env.DEPLOY_HOOK_URL, method: "POST" }]);
  assert.equal(JSON.parse(db.get("SELECT value FROM settings WHERE key = 'published_version'").value), 1);

  const second = await requestRebuildAt(env, 10_060, okFetch);
  assert.deepEqual(second, { queued: false, nextAllowedAt: 10_120, reason: "debounced" });
  assert.equal(calls.length, 1);

  const failing = async () => new Response("no", { status: 500 });
  const third = await requestRebuildAt(env, 10_200, failing);
  assert.deepEqual(third, { queued: false, nextAllowedAt: 10_200, reason: "hook_failed" });
  assert.equal(JSON.parse(db.get("SELECT value FROM settings WHERE key = 'last_rebuild_at'").value), 10_000, "claim released");
  const fourth = await requestRebuildAt(env, 10_201, okFetch);
  assert.equal(fourth.queued, true, "a retry right after a failure goes through");

  assert.deepEqual(await requestRebuildAt({ DB: db }, 20_000, okFetch), { queued: false, nextAllowedAt: 20_000, reason: "no_hook" });
  await assert.rejects(requestRebuildAt({ DB: db, DEPLOY_HOOK_URL: "https://evil.example/hook" }, 20_000, okFetch), ConfigError);
  await assert.rejects(requestRebuildAt({ DB: db, DEPLOY_HOOK_URL: "http://api.cloudflare.com/x" }, 20_000, okFetch), ConfigError);
});

test("publish status compares content_version with the live build.json", async () => {
  const db = await createTestDb();
  const assets = (version) => ({ fetch: async () => (version === null ? new Response("nf", { status: 404 }) : Response.json({ contentVersion: version })) });
  db.sqlite.exec("UPDATE settings SET value = '3' WHERE key = 'content_version'");
  const site = "https://courses.feelingsbeautycare.in/api/admin/publish/status";
  assert.equal((await publishStatus({ DB: db, ASSETS: assets(3) }, site, 5000)).state, "up_to_date");
  assert.equal((await publishStatus({ DB: db, ASSETS: assets(2) }, site, 5000)).state, "queued");
  assert.equal((await publishStatus({ DB: db, ASSETS: assets(null) }, site, 5000)).state, "unknown");
  db.sqlite.exec(
    "INSERT INTO settings (key, value, updated_at) VALUES ('published_version', '3', 1), ('last_rebuild_at', '4900', 1)",
  );
  const building = await publishStatus({ DB: db, ASSETS: assets(2) }, site, 5000);
  assert.deepEqual(building, { contentVersion: 3, publishedVersion: 3, liveVersion: 2, lastRebuildAt: 4900, nextAllowedAt: 5020, state: "building" });

  // Through the routes (no hook in this env).
  const t = await adminFixture({ ASSETS: assets(1) });
  const status = await t.call(publishStatusRoute, "GET", "/api/admin/publish/status");
  assert.equal(status.body.state, "up_to_date");
  const site2 = await t.call(publishSiteRoute, "POST", "/api/admin/publish");
  assert.equal(site2.status, 200);
  assert.equal(site2.body.rebuild.reason, "no_hook");
});
