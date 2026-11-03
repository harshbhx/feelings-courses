// W3 course area data, progress, certificates and the student JSON API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claimCertificate, continueLesson, listEnrollments, loadLearnCourse, parseProgress, saveProgress } from "../../functions/_lib/learn.ts";
import { checkCertificate, issueCertificate, normalizeCertificateCode } from "../../functions/_lib/certificates.ts";
import { createAccessLink } from "../../functions/_lib/access-link.ts";
import { consumeLoginToken } from "../../functions/_lib/session.ts";
import { listOrders, updateStudent, deviceLabel } from "../../functions/_lib/students.ts";
import {
  handleCertificateCheck,
  handleCertificateClaim,
  handleLearnCourse,
  handleMe,
  handleMyOrders,
  handleMySession,
  handleMySessions,
  handlePlay,
  handleProgress,
  handleSignout,
} from "../../functions/_lib/student-api.ts";
import { SESSION_COOKIE } from "../../functions/_lib/config.ts";
import { cookiesFrom, postJson, readJson, req } from "../helpers/http.mjs";
import { ASHA, completeCourse, DAY, env, LIVE_KEYS, NOW, sessionCookie, setupDb } from "./fixtures.mjs";

test("listEnrollments: active first, with access state and lesson counts", async () => {
  const db = await setupDb();
  completeCourse(db, ASHA.id, 20);
  const list = await listEnrollments(env(db), ASHA.id, NOW);
  const bySlug = Object.fromEntries(list.map((e) => [e.courseSlug, e]));
  assert.deepEqual(Object.keys(bySlug).sort(), ["evening-class", "old-class", "selfmakeup", "studio-days"], "the deleted course is left out");
  assert.equal(bySlug.selfmakeup.active, true);
  assert.equal(bySlug.selfmakeup.totalLessons, 9);
  assert.equal(bySlug["old-class"].active, false, "expired");
  assert.equal(list.at(-1).courseSlug, "old-class", "inactive ones last");
  assert.equal(bySlug["evening-class"].completedLessons, 2);
  assert.deepEqual(bySlug["studio-days"].batch, {
    id: 221,
    title: "November mornings",
    startsOn: "2026-11-02",
    endsOn: "2026-11-20",
    scheduleText: "Mon to Fri, 10 am",
  });
  const live = await listEnrollments(env(db, LIVE_KEYS), ASHA.id, NOW);
  assert.equal(live.find((e) => e.courseSlug === "selfmakeup").active, false, "test-mode enrollment inactive under live keys");
});

test("loadLearnCourse: outline in order, progress, no video references", async () => {
  const db = await setupDb();
  await saveProgress(env(db), ASHA.id, { lessonId: 2, positionSeconds: 42 }, NOW);
  await saveProgress(env(db), ASHA.id, { lessonId: 1, positionSeconds: 0, completed: true }, NOW);
  const course = await loadLearnCourse(env(db), ASHA.id, "selfmakeup", NOW);
  assert.equal(course.course.title, "Self Makeup Masterclass");
  assert.equal(course.modules.length, 3);
  assert.deepEqual(course.modules[0].lessons.map((l) => l.slug), ["know-your-skin-type", "prep-and-priming", "foundation-shade-matching"]);
  assert.equal(course.modules[0].lessons[0].progress.completedAt, NOW);
  assert.equal(course.modules[0].lessons[1].progress.positionSeconds, 42);
  assert.equal(course.modules[0].lessons[2].progress, null);
  assert.equal(course.complete, false);
  assert.equal(continueLesson(course).slug, "prep-and-priming");
  assert.equal(JSON.stringify(course).includes("video_ref"), false);
  assert.equal(JSON.stringify(course).includes("v/2001.mp4"), false);

  assert.equal(await loadLearnCourse(env(db), ASHA.id, "old-class", NOW), null, "expired");
  assert.equal(await loadLearnCourse(env(db), ASHA.id, "diploma", NOW), null, "not enrolled");
  assert.equal(await loadLearnCourse(env(db), 2, "selfmakeup", NOW), null, "revoked");
});

test("saveProgress: clamps the position, toggles done, completes the enrollment once", async () => {
  const db = await setupDb();
  const e = env(db);
  const saved = await saveProgress(e, ASHA.id, { lessonId: 2001, positionSeconds: 99_999 }, NOW);
  assert.deepEqual(saved, { lessonId: 2001, completedAt: null, courseComplete: false });
  assert.equal(db.get("SELECT position_seconds FROM lesson_progress WHERE lesson_id = 2001").position_seconds, 300, "capped at the duration");

  await saveProgress(e, ASHA.id, { lessonId: 2001, positionSeconds: 10, completed: true }, NOW);
  await saveProgress(e, ASHA.id, { lessonId: 2001, positionSeconds: 20 }, NOW + 5);
  assert.equal(db.get("SELECT completed_at FROM lesson_progress WHERE lesson_id = 2001").completed_at, NOW, "a plain position save keeps the tick");
  await saveProgress(e, ASHA.id, { lessonId: 2001, positionSeconds: 20, completed: true }, NOW + 9);
  assert.equal(db.get("SELECT completed_at FROM lesson_progress WHERE lesson_id = 2001").completed_at, NOW, "first completion time kept");

  const last = await saveProgress(e, ASHA.id, { lessonId: 2002, positionSeconds: 0, completed: true }, NOW + 10);
  assert.equal(last.courseComplete, true);
  assert.equal(db.get("SELECT completed_at FROM enrollments WHERE id = 2").completed_at, NOW + 10);

  const undone = await saveProgress(e, ASHA.id, { lessonId: 2002, positionSeconds: 0, completed: false }, NOW + 20);
  assert.equal(undone.completedAt, null);
  assert.equal(undone.courseComplete, false);
  assert.equal(db.get("SELECT completed_at FROM enrollments WHERE id = 2").completed_at, NOW + 10, "the enrollment stays completed");
});

test("saveProgress refuses lessons of courses the student can't open", async () => {
  const db = await setupDb();
  assert.equal(await saveProgress(env(db), ASHA.id, { lessonId: 2101, positionSeconds: 1 }, NOW), null, "expired course");
  assert.equal(await saveProgress(env(db), ASHA.id, { lessonId: 10, positionSeconds: 1 }, NOW), null, "not enrolled (academy draft)");
  assert.equal(await saveProgress(env(db), 2, { lessonId: 1, positionSeconds: 1 }, NOW), null, "revoked");
  assert.equal(await saveProgress(env(db), ASHA.id, { lessonId: 99999, positionSeconds: 1 }, NOW), null, "no such lesson");
  assert.equal(db.get("SELECT count(*) AS n FROM lesson_progress").n, 0);
});

test("parseProgress validates the body", () => {
  assert.deepEqual(parseProgress({ lessonId: 3, positionSeconds: 12.7 }), { lessonId: 3, positionSeconds: 12, completed: undefined });
  assert.throws(() => parseProgress({ lessonId: "x", positionSeconds: 1 }), /lessonId/);
  assert.throws(() => parseProgress({ lessonId: 1, positionSeconds: -1 }), /positionSeconds/);
  assert.throws(() => parseProgress({ lessonId: 1, positionSeconds: Infinity }), /positionSeconds/);
  assert.throws(() => parseProgress({ lessonId: 1, positionSeconds: 1, completed: "yes" }), /completed/);
});

test("certificates: claim needs every lesson done; code format; reissue keeps the code", async () => {
  const db = await setupDb();
  const e = env(db);
  assert.deepEqual(await claimCertificate(e, ASHA.id, "selfmakeup", "Asha Patel", NOW), { ok: false, reason: "course_incomplete" });
  completeCourse(db, ASHA.id, 1);
  const first = await claimCertificate(e, ASHA.id, "selfmakeup", "  Asha   Patel ", NOW);
  assert.equal(first.ok, true);
  assert.match(first.certificate.code, /^[0-9A-HJKMNP-TV-Z]{10}$/);
  assert.equal(first.certificate.nameOnCertificate, "Asha Patel");
  assert.equal(first.certificate.title, "Certificate of completion from Feelings Beauty Care");
  assert.equal(first.certificate.verifyUrl, `https://courses.feelingsbeautycare.in/verify/${first.certificate.code}`);

  const again = await claimCertificate(e, ASHA.id, "selfmakeup", "Asha R. Patel", NOW + DAY);
  assert.equal(again.certificate.code, first.certificate.code, "the verify link keeps working");
  assert.equal(again.certificate.nameOnCertificate, "Asha R. Patel");
  assert.equal(again.certificate.issuedAt, NOW + DAY);
  assert.equal(db.get("SELECT count(*) AS n FROM certificates").n, 1);
  assert.equal(db.get("SELECT count(*) AS n FROM audit_log WHERE action = 'certificate.issue'").n, 2);

  db.sqlite.exec(`UPDATE certificates SET revoked_at = ${NOW}`);
  assert.deepEqual(await claimCertificate(e, ASHA.id, "selfmakeup", "Asha", NOW), { ok: false, reason: "revoked" });
  assert.equal(db.get("SELECT revoked_at FROM certificates").revoked_at, NOW);
});

test("certificates: no wording means no certificate; bad names refused; not enrolled", async () => {
  const db = await setupDb();
  completeCourse(db, ASHA.id, 20);
  assert.deepEqual(await claimCertificate(env(db), ASHA.id, "evening-class", "Asha", NOW), { ok: false, reason: "no_certificate" });
  await assert.rejects(claimCertificate(env(db), ASHA.id, "selfmakeup", "A", NOW), /nameOnCertificate/);
  await assert.rejects(claimCertificate(env(db), ASHA.id, "selfmakeup", "x".repeat(81), NOW), /nameOnCertificate/);
  await assert.rejects(claimCertificate(env(db), ASHA.id, "selfmakeup", "Asha\u0000", NOW));
  assert.deepEqual(await claimCertificate(env(db), ASHA.id, "diploma", "Asha", NOW), { ok: false, reason: "not_enrolled" });
  await assert.rejects(issueCertificate(env(db), { studentId: ASHA.id, courseId: 20, name: "Asha" }), /no certificate/);
  await assert.rejects(issueCertificate(env(db), { studentId: 3, courseId: 1, name: "Erased" }), /No such student/);
});

test("checkCertificate: normalises codes; revoked and erased show nothing personal", async () => {
  const db = await setupDb();
  const cert = await issueCertificate(env(db), { studentId: ASHA.id, courseId: 1, name: "Asha Patel", actor: "admin", now: NOW });
  const view = await checkCertificate(db, cert.code.toLowerCase().replace(/(.{5})/, "$1-"));
  assert.equal(view.valid, true);
  assert.equal(view.name, "Asha Patel");
  assert.equal(view.course, "Self Makeup Masterclass");
  assert.equal(view.issuedOn, "2026-10-23");
  assert.equal(normalizeCertificateCode("abcd-efgh-io"), "ABCDEFGH10");
  assert.equal(normalizeCertificateCode("ABCDEFGHU1"), null, "U isn't in the alphabet");
  assert.equal(normalizeCertificateCode("short"), null);
  assert.equal((await checkCertificate(db, "ZZZZZZZZZZ")).valid, false);

  db.sqlite.exec(`UPDATE certificates SET revoked_at = ${NOW}`);
  const revoked = await checkCertificate(db, cert.code);
  assert.equal(revoked.valid, false);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.name, null);

  db.sqlite.exec("UPDATE certificates SET revoked_at = NULL; UPDATE students SET erased_at = 1, name = NULL, phone = NULL, email = NULL WHERE id = 1");
  const erased = await checkCertificate(db, cert.code);
  assert.deepEqual([erased.valid, erased.revoked, erased.name], [false, false, null]);
});

test("createAccessLink: one-time WhatsApp link to /account, 24 hours, audited", async () => {
  const db = await setupDb();
  const link = await createAccessLink(env(db), ASHA.id, { now: NOW });
  const url = new URL(link.url);
  assert.equal(url.origin, "https://courses.feelingsbeautycare.in");
  assert.equal(url.pathname, "/auth/continue");
  assert.equal(link.expiresAt, NOW + DAY);
  const wa = new URL(link.whatsappUrl);
  assert.equal(wa.hostname, "wa.me");
  assert.equal(wa.pathname, "/919876543210");
  assert.ok(wa.searchParams.get("text").includes(link.url));
  assert.ok(wa.searchParams.get("text").startsWith("Hi Asha,"));
  const used = await consumeLoginToken(db, url.searchParams.get("t"), NOW + 60);
  assert.deepEqual(used, { studentId: ASHA.id, purpose: "admin_link", redirectPath: "/account" });
  assert.equal(db.get("SELECT actor FROM audit_log WHERE action = 'student.access_link'").actor, "admin");
  await assert.rejects(createAccessLink(env(db), 3, { now: NOW }), /No such student/);
});

test("students: orders list, profile update, device labels", async () => {
  const db = await setupDb();
  const orders = await listOrders(db, ASHA.id);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].refundableUntil, orders[0].paidAt + DAY);
  assert.equal(orders[0].razorpayPaymentId, ASHA.payment);
  assert.equal((await listOrders(db, 2)).length, 1, "refunded orders show; unpaid ones don't");

  const updated = await updateStudent(db, ASHA.id, { name: "Asha P." }, NOW);
  assert.equal(updated.name, "Asha P.");
  // The email is the account: a student can't change it (nor take someone else's) on their own.
  await assert.rejects(updateStudent(db, 2, { email: ASHA.email }, NOW), (err) => {
    assert.equal(err.name, "ValidationError");
    assert.equal(err.message.includes("asha"), false, "never says whose email it is");
    return true;
  });
  await assert.rejects(updateStudent(db, ASHA.id, { email: "new@example.com" }, NOW), /WhatsApp/);
  assert.equal(db.get("SELECT email FROM students WHERE id = ?", ASHA.id).email, ASHA.email);
  await assert.rejects(updateStudent(db, 2, { name: "" }, NOW), /name/);
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1"), "Safari on iPhone or iPad");
  assert.equal(deviceLabel("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"), "Chrome on Android");
  assert.equal(deviceLabel(null), "Unknown device");
});

// ---------------------------------------------------------------- the JSON API

test("API: signed-out requests get 401; strangers' courses 404", async () => {
  const db = await setupDb();
  assert.equal((await handleMe(req("/api/me"), env(db), NOW)).status, 401);
  assert.equal((await handleLearnCourse("selfmakeup")(req("/api/learn/selfmakeup"), env(db), NOW)).status, 401);
  const cookie = await sessionCookie(db, ASHA.id);
  const missing = await handleLearnCourse("diploma")(req("/api/learn/diploma", { cookie }), env(db), NOW);
  const nope = await handleLearnCourse("no-such-course")(req("/api/learn/no-such-course", { cookie }), env(db), NOW);
  assert.equal(missing.status, 404);
  assert.deepEqual(await readJson(missing), await readJson(nope), "a draft course and a missing one look the same");
});

test("API: GET /api/me, /api/learn/:slug, PUT /api/learn/progress", async () => {
  const db = await setupDb();
  const cookie = await sessionCookie(db, ASHA.id);
  const me = await readJson(await handleMe(req("/api/me", { cookie }), env(db), NOW));
  assert.equal(me.student.id, ASHA.id);
  assert.equal(me.enrollments.length, 4);

  const course = await handleLearnCourse("selfmakeup")(req("/api/learn/selfmakeup", { cookie }), env(db), NOW);
  assert.equal(course.status, 200);
  assert.equal(course.headers.get("Cache-Control"), "no-store");

  const put = (body, opts = {}) => req("/api/learn/progress", { method: "PUT", body, cookie, ...opts });
  const saved = await handleProgress(put({ lessonId: 1, positionSeconds: 30, completed: true }), env(db), NOW);
  assert.equal(saved.status, 200);
  assert.equal((await readJson(saved)).completedAt, NOW);
  assert.equal((await handleProgress(put({ lessonId: 2101, positionSeconds: 1 }), env(db), NOW)).status, 404);
  assert.equal((await handleProgress(put({ lessonId: 1, positionSeconds: "x" }), env(db), NOW)).status, 400);
  assert.equal((await handleProgress(put({ lessonId: 1, positionSeconds: 1 }, { origin: "https://evil.example" }), env(db), NOW)).status, 403);
  assert.equal((await handleProgress(put({ lessonId: 1, positionSeconds: 1 }, { cookie: undefined }), env(db), NOW)).status, 401);
});

test("API: play needs an enrollment, then defers to W4", async () => {
  const db = await setupDb();
  const cookie = await sessionCookie(db, ASHA.id);
  const notEnrolled = await handlePlay("diploma", "10")(req("/api/learn/diploma/lessons/10/play", { cookie }), env(db), NOW);
  assert.equal(notEnrolled.status, 404);
  const anon = await handlePlay("evening-class", "2001")(req("/api/learn/evening-class/lessons/2001/play"), env(db), NOW);
  assert.equal(anon.status, 401);
  // W4's playLesson (integration): links signed for this session, 2 hours at most.
  const secret = { APP_SECRET: "integration-test-app-secret-0123456789" };
  const enrolled = await handlePlay("evening-class", "2001")(req("/api/learn/evening-class/lessons/2001/play", { cookie }), env(db, secret), NOW);
  assert.equal(enrolled.status, 200);
  const info = await enrolled.json();
  const tokenHash = db.get("SELECT token_hash FROM sessions WHERE student_id = ? ORDER BY id DESC", ASHA.id).token_hash;
  const src = new URL(info.src, "https://courses.feelingsbeautycare.in");
  assert.equal(src.pathname, "/media/v/2001");
  assert.equal(src.searchParams.get("s"), tokenHash.slice(0, 16));
  assert.ok(info.expiresAt > NOW && info.expiresAt <= NOW + 2 * 3600);
  // Without APP_SECRET there are no signed links: a clear 503, not a broken player.
  const noSecret = await handlePlay("evening-class", "2001")(req("/api/learn/evening-class/lessons/2001/play", { cookie }), env(db), NOW);
  assert.equal(noSecret.status, 503);
});

test("API: sessions list and sign-out of one device or all", async () => {
  const db = await setupDb();
  const laptop = await sessionCookie(db, ASHA.id, { now: NOW - 10, userAgent: "Laptop" });
  const phone = await sessionCookie(db, ASHA.id, { userAgent: "Phone" });
  const list = await readJson(await handleMySessions(req("/api/me/sessions", { cookie: phone }), env(db), NOW));
  assert.deepEqual(list.map((s) => [s.userAgent, s.current]), [["Phone", true], ["Laptop", false]]);

  const other = list.find((s) => !s.current);
  const del = await handleMySession(String(other.id))(req(`/api/me/sessions/${other.id}`, { method: "DELETE", cookie: phone }), env(db), NOW);
  assert.equal(del.status, 204);
  assert.equal((await handleMe(req("/api/me", { cookie: laptop }), env(db), NOW)).status, 401);

  const bina = await sessionCookie(db, 2);
  const binaId = db.get("SELECT id FROM sessions WHERE student_id = 2").id;
  const steal = await handleMySession(String(binaId))(req(`/api/me/sessions/${binaId}`, { method: "DELETE", cookie: phone }), env(db), NOW);
  assert.equal(steal.status, 404, "another student's session can't be touched");
  assert.equal((await handleMe(req("/api/me", { cookie: bina }), env(db), NOW)).status, 200);

  const out = await handleSignout(postJson("/api/auth/signout", { all: true }, { cookie: phone }), env(db), NOW);
  assert.equal(out.status, 204);
  assert.equal(cookiesFrom(out)[SESSION_COOKIE].attributes["max-age"], "0");
  assert.equal((await handleMe(req("/api/me", { cookie: phone }), env(db), NOW)).status, 401);
});

test("API: orders, profile update, certificate claim", async () => {
  const db = await setupDb();
  const cookie = await sessionCookie(db, ASHA.id);
  const orders = await readJson(await handleMyOrders(req("/api/me/orders", { cookie }), env(db), NOW));
  assert.equal(orders[0].invoiceNo, "TEST-1");

  const put = await handleMe(req("/api/me", { method: "PUT", body: { name: "Asha Patel" }, cookie }), env(db), NOW);
  assert.equal(put.status, 200);

  const early = await handleCertificateClaim("selfmakeup")(postJson("/api/learn/selfmakeup/certificate", { nameOnCertificate: "Asha" }, { cookie }), env(db), NOW);
  assert.equal(early.status, 409);
  assert.equal((await readJson(early)).error, "course_incomplete");
  completeCourse(db, ASHA.id, 1);
  const ok = await handleCertificateClaim("selfmakeup")(postJson("/api/learn/selfmakeup/certificate", { nameOnCertificate: "Asha" }, { cookie }), env(db), NOW);
  assert.equal(ok.status, 200);
  const cert = await readJson(ok);
  const check = await readJson(await handleCertificateCheck(cert.code)(req(`/api/certificates/${cert.code}`), env(db), NOW));
  assert.deepEqual(check, { valid: true, name: "Asha", course: "Self Makeup Masterclass", issuedOn: "2026-10-23", revoked: false });
});

test("API: the public certificate check is rate limited per IP", async () => {
  const db = await setupDb();
  let last;
  for (let i = 0; i < 31; i++) last = await handleCertificateCheck("ZZZZZZZZZZ")(req("/api/certificates/ZZZZZZZZZZ", { ip: "203.0.113.50" }), env(db), NOW);
  assert.equal(last.status, 429);
  const other = await handleCertificateCheck("ZZZZZZZZZZ")(req("/api/certificates/ZZZZZZZZZZ", { ip: "203.0.113.51" }), env(db), NOW);
  assert.equal(other.status, 200);
  assert.deepEqual(await readJson(other), { valid: false, name: null, course: null, issuedOn: null, revoked: false });
});
