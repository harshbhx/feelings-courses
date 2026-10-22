// W6 admin UI logic: the course form and publish checklist, the outline editor, batches, coupons,
// refunds, students, dashboard numbers, publish wording, uploads and the activity log.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blankForm,
  canPublish,
  changedFields,
  courseInput,
  fieldId,
  formFromCourse,
  publishChecklist,
} from "../../src/components/admin/lib/course-form.ts";
import {
  addLesson,
  addModule,
  draftFromModules,
  findLesson,
  isDirty,
  moveLesson,
  moveLessonTo,
  moveModule,
  outlineRequest,
  parseOutlinePath,
  removeLesson,
  removedLessons,
  totals,
  updateLesson,
  validateDraft,
} from "../../src/components/admin/lib/outline.ts";
import { batchDates, batchInput, blankBatchForm, seatsLabel } from "../../src/components/admin/lib/batches.ts";
import { blankCouponForm, couponChanges, couponForm, couponInput, couponState, discountLabel, usesLabel } from "../../src/components/admin/lib/coupons.ts";
import { methodLabel, readRefundForm, refundableAmount, refundState } from "../../src/components/admin/lib/orders.ts";
import { accessState, deviceLabel, eraseConfirmed, normalizePhone, prettyPhone, whatsappHref } from "../../src/components/admin/lib/students.ts";
import { change, conversion, fillSeries, niceMax, splitPeriods, statsRange, sum } from "../../src/components/admin/lib/stats.ts";
import { publishView, rebuildMessage } from "../../src/components/admin/lib/publish.ts";
import { contentTypeFor, fileProblem, formatBytes, imageUrl, keyName, progressText } from "../../src/components/admin/lib/upload.ts";
import { auditDetails, auditHref, auditSentence } from "../../src/components/admin/lib/audit.ts";

const lesson = (id, position, extra = {}) => ({
  id,
  moduleId: 1,
  position,
  slug: `lesson-${id}`,
  title: `Lesson ${id}`,
  minutes: 10,
  videoProvider: "none",
  videoRef: null,
  vertical: false,
  captionsKey: null,
  durationSeconds: null,
  notes: null,
  freePreview: false,
  ...extra,
});

const course = (extra = {}) => ({
  id: 7,
  slug: "bridal-basics",
  title: "Bridal Basics",
  subtitle: null,
  description: null,
  teacher: "Urmi Mengar",
  format: "online",
  pricePaise: 299900,
  compareAtPaise: null,
  depositPaise: null,
  level: null,
  language: null,
  durationText: null,
  accessDays: 365,
  certificateTitle: null,
  details: { outcomes: ["Soft glam"], forWho: [], faqs: [], glimpses: [], highlights: [] },
  coverKey: null,
  ogImageKey: null,
  seoTitle: null,
  seoDescription: null,
  isDemo: false,
  status: "draft",
  domainStatus: "none",
  slugLocked: false,
  sortOrder: 0,
  publishedAt: null,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  modules: [{ id: 1, position: 0, title: "Basics", lessons: [lesson(11, 1), lesson(10, 0)] }],
  batches: [],
  lessonCount: 2,
  enrollmentCount: 0,
  ...extra,
});

// ---------------------------------------------------------------- course form

test("the course form round-trips a saved course without changes", () => {
  const c = course();
  const r = courseInput(formFromCourse(c));
  assert.equal(r.ok, true);
  assert.deepEqual(changedFields(c, r.input), {});
});

test("only changed fields are sent, lists are tidied", () => {
  const c = course();
  const v = formFromCourse(c);
  v.price = "3,499";
  v.outcomes = ["Soft glam", "  ", "HD base "];
  v.glimpses = [{ youtube: "https://youtu.be/dQw4w9WgXcQ", label: "Base" }, { youtube: "", label: "" }];
  const r = courseInput(v);
  assert.equal(r.ok, true);
  const diff = changedFields(c, r.input);
  assert.deepEqual(Object.keys(diff).sort(), ["details", "pricePaise"]);
  assert.equal(diff.pricePaise, 349900);
  assert.deepEqual(diff.details.outcomes, ["Soft glam", "HD base"]);
  assert.deepEqual(diff.details.glimpses, [{ youtubeId: "dQw4w9WgXcQ", label: "Base" }]);
});

test("the course form checks what the API checks", () => {
  const v = blankForm();
  let r = courseInput(v);
  assert.equal(r.ok, false);
  assert.ok(r.errors.slug && r.errors.title);
  Object.assign(v, { slug: "Bridal-Basics", title: "Bridal", price: "50", compareAt: "40", format: "hybrid", deposit: "60", accessDays: "0" });
  r = courseInput(v);
  assert.equal(r.ok, false);
  assert.equal(r.errors.slug, undefined, "slug is lowercased first");
  assert.match(r.errors.compareAtPaise, /higher/);
  assert.match(r.errors.depositPaise, /less than the fee/);
  assert.match(r.errors.accessDays, /1 to 3650/);
  Object.assign(v, { price: "0.5", compareAt: "", deposit: "", accessDays: "" });
  r = courseInput(v);
  assert.match(r.errors.pricePaise, /at least ₹1/);
  Object.assign(v, { price: "0", faqs: [{ q: "When?", a: "" }], glimpses: [{ youtube: "nope", label: "x" }] });
  r = courseInput(v);
  assert.match(r.errors["details.faqs[0].a"], /answer/);
  assert.match(r.errors["details.glimpses[0].youtubeId"], /YouTube/);
  Object.assign(v, { faqs: [], glimpses: [], seoTitle: "x".repeat(71) });
  r = courseInput(v);
  assert.match(r.errors.seoTitle, /at most 70/);
  v.seoTitle = "";
  r = courseInput(v);
  assert.equal(r.ok, true);
  assert.equal(r.input.slug, "bridal-basics");
  assert.equal(r.input.pricePaise, 0);
  assert.equal(r.input.accessDays, null, "empty access = no end");
  assert.equal(r.input.depositPaise, null);
});

test("an online course never sends a booking amount", () => {
  const v = { ...blankForm(), slug: "abc", title: "A", price: "1000", deposit: "200", format: "online" };
  const r = courseInput(v);
  assert.equal(r.ok, true);
  assert.equal(r.input.depositPaise, null);
});

test("the publish checklist follows the format", () => {
  const online = publishChecklist(course());
  assert.equal(canPublish(online), true);
  assert.equal(online.find((i) => i.key === "cover").done, false);
  assert.equal(canPublish(publishChecklist(course({ pricePaise: null }))), false);
  assert.equal(canPublish(publishChecklist(course({ modules: [] }))), false);
  const batch = { id: 1, status: "open" };
  assert.equal(canPublish(publishChecklist(course({ format: "in_person", batches: [] }))), false);
  assert.equal(canPublish(publishChecklist(course({ format: "in_person", modules: [], batches: [batch] }))), true);
  assert.equal(canPublish(publishChecklist(course({ format: "in_person", batches: [{ ...batch, status: "closed" }] }))), false);
  assert.equal(canPublish(publishChecklist(course({ format: "hybrid", modules: [], batches: [batch] }))), true);
  assert.equal(canPublish(publishChecklist(course({ format: "hybrid", batches: [] }))), true);
  assert.equal(canPublish(publishChecklist(course({ slug: "admin" }))), false);
  assert.equal(fieldId("details.faqs[2].a"), "f-details-faqs-2-a");
});

// ---------------------------------------------------------------- outline

test("the outline draft is sorted by position and saves ids, order and new rows", () => {
  const draft = draftFromModules(course().modules);
  assert.deepEqual(draft[0].lessons.map((l) => l.id), [10, 11]);
  let d = addLesson(draft, 0, "Soft glam");
  d = addModule(d, "Advanced");
  d = addLesson(d, 1, "Soft glam");
  const body = outlineRequest(d);
  assert.deepEqual(body.modules.map((m) => m.id), [1, undefined]);
  assert.deepEqual(body.modules[0].lessons.map((l) => l.slug), ["lesson-10", "lesson-11", "soft-glam"]);
  assert.equal(body.modules[1].lessons[0].slug, "soft-glam-2", "new slugs stay unique across modules");
  assert.equal("id" in body.modules[1], false);
  assert.equal(isDirty(draft, draft), false);
  assert.equal(isDirty(draft, d), true);
});

test("lessons move within and across modules", () => {
  let d = draftFromModules(course().modules);
  d = addModule(d, "Two");
  d = moveLesson(d, 0, 0, 1);
  assert.deepEqual(d[0].lessons.map((l) => l.id), [11, 10]);
  d = moveLesson(d, 0, 1, 1); // last of module 0, down → first of module 1
  assert.deepEqual(d[0].lessons.map((l) => l.id), [11]);
  assert.deepEqual(d[1].lessons.map((l) => l.id), [10]);
  d = moveLesson(d, 1, 0, -1); // first of module 1, up → last of module 0
  assert.deepEqual(d[0].lessons.map((l) => l.id), [11, 10]);
  assert.equal(moveLesson(d, 0, 0, -1), d, "nothing above the first lesson");
  d = moveLessonTo(d, 0, 0, 1);
  assert.deepEqual(d[1].lessons.map((l) => l.id), [11]);
  d = moveModule(d, 1, -1);
  assert.equal(d[0].title, "Two");
  assert.deepEqual(findLesson(d, "l10"), [1, 0]);
});

test("removing a saved lesson is reported before saving", () => {
  const saved = draftFromModules(course().modules);
  const d = removeLesson(saved, 0, 0);
  assert.deepEqual(removedLessons(saved, d).map((l) => l.id), [10]);
  assert.deepEqual(removedLessons(saved, addLesson(saved, 0, "x")), []);
});

test("the outline is checked like the API, with the API's field paths", () => {
  let d = draftFromModules(course().modules);
  d = updateLesson(d, "l10", { slug: "lesson-11" });
  d = updateLesson(d, "l11", { videoProvider: "youtube", videoRef: "not-an-id" });
  d = addModule(d, "  ");
  const errors = validateDraft(d);
  assert.match(errors["modules[0].lessons[1].slug"], /Two lessons/);
  assert.match(errors["modules[0].lessons[1].videoRef"], /YouTube/);
  assert.match(errors["modules[1].title"], /title/);
  assert.deepEqual(parseOutlinePath("modules[0].lessons[1].slug"), { module: 0, lesson: 1, field: "slug" });
  assert.deepEqual(parseOutlinePath("modules[3].title"), { module: 3, lesson: null, field: "title" });
  assert.equal(parseOutlinePath("details.faqs[0]"), null);
  const r2 = updateLesson(draftFromModules(course().modules), "l10", { videoProvider: "r2", videoRef: null });
  assert.match(validateDraft(r2)["modules[0].lessons[0].videoRef"], /Upload/);
});

test("outline totals and stream lessons", () => {
  let d = draftFromModules(course().modules);
  d = updateLesson(d, "l10", { videoProvider: "r2", videoRef: "videos/2026/10/0123456789abcdef-a.mp4", freePreview: true });
  d = updateLesson(d, "l11", { videoProvider: "stream", videoRef: "abc" });
  assert.deepEqual(totals(d), { modules: 1, lessons: 2, minutes: 20, withVideo: 2, previews: 1 });
  const body = outlineRequest(d);
  assert.equal(body.modules[0].lessons[1].videoProvider, "none");
  assert.equal(body.modules[0].lessons[1].videoRef, null);
});

// ---------------------------------------------------------------- batches

test("batch form", () => {
  const v = { ...blankBatchForm(), title: "Nov weekend", startsOn: "2026-11-14", endsOn: "2026-11-13", seats: "4" };
  let r = batchInput(v, 6);
  assert.equal(r.ok, false);
  assert.match(r.errors.endsOn, /before/);
  assert.match(r.errors.seats, /6 seats/);
  r = batchInput({ ...v, endsOn: "2026-11-15", seats: "", price: "4999" });
  assert.deepEqual(r, {
    ok: true,
    input: { title: "Nov weekend", startsOn: "2026-11-14", endsOn: "2026-11-15", scheduleText: null, pricePaise: 499900, seats: null, status: "open" },
  });
  assert.equal(batchDates({ startsOn: "2026-11-14", endsOn: "2026-11-15" }), "14 Nov – 15 Nov 2026");
  assert.equal(batchDates({ startsOn: "2026-11-14", endsOn: null }), "14 Nov 2026");
  assert.equal(seatsLabel({ seats: 12, seatsTaken: 8 }), "8 of 12 seats booked");
});

// ---------------------------------------------------------------- coupons

const coupon = (extra = {}) => ({
  id: 3,
  code: "REEL15",
  percentOff: 15,
  amountOffPaise: null,
  courseId: null,
  maxUses: 50,
  usedCount: 3,
  startsAt: null,
  expiresAt: null,
  active: true,
  allowFree: false,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

test("coupon states and labels", () => {
  const now = 1_800_000_000;
  assert.equal(couponState(coupon(), now), "active");
  assert.equal(couponState(coupon({ active: false }), now), "off");
  assert.equal(couponState(coupon({ expiresAt: now }), now), "expired");
  assert.equal(couponState(coupon({ usedCount: 50 }), now), "used_up");
  assert.equal(couponState(coupon({ startsAt: now + 60 }), now), "scheduled");
  assert.equal(discountLabel(coupon()), "15% off");
  assert.equal(discountLabel(coupon({ percentOff: null, amountOffPaise: 50000 })), "₹500 off");
  assert.equal(usesLabel(coupon()), "3 of 50 used");
  assert.equal(usesLabel(coupon({ maxUses: null })), "3 used");
});

test("coupon form: one kind of discount, India-time dates, no surprise free enrollments", () => {
  let r = couponInput({ ...blankCouponForm(), code: " reel 15 ", value: "15" });
  assert.equal(r.ok, true);
  assert.equal(r.input.code, "REEL15");
  assert.equal(r.input.percentOff, 15);
  assert.equal(r.input.amountOffPaise, null);
  r = couponInput({ ...blankCouponForm(), code: "R!", value: "0", maxUses: "0", startsAt: "2026-11-02T10:00", expiresAt: "2026-11-01T10:00" });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ["code", "expiresAt", "maxUses", "percentOff"]);
  r = couponInput({ ...blankCouponForm(), code: "FLAT500", kind: "amount", value: "500", allowFree: true });
  assert.equal(r.input.amountOffPaise, 50000);
  assert.equal(r.input.allowFree, false, "allowFree only for 100%");
  r = couponInput({ ...blankCouponForm(), code: "FREE", value: "100", allowFree: true });
  assert.equal(r.input.allowFree, true);
  r = couponInput({ ...couponForm(coupon()), maxUses: "2" }, coupon());
  assert.match(r.errors.maxUses, /3 times/);
});

test("coupon edits send only changes, and switching kind sends only the new one", () => {
  const saved = coupon();
  const same = couponInput(couponForm(saved), saved);
  assert.deepEqual(couponChanges(saved, same.input), {});
  const flat = couponInput({ ...couponForm(saved), kind: "amount", value: "300" }, saved);
  assert.deepEqual(couponChanges(saved, flat.input), { amountOffPaise: 30000 });
  const dated = couponInput({ ...couponForm(saved), expiresAt: "2026-12-31T23:59" }, saved);
  assert.deepEqual(Object.keys(couponChanges(saved, dated.input)), ["expiresAt"]);
});

// ---------------------------------------------------------------- refunds

const order = (extra = {}) => ({
  status: "paid",
  amountPaise: 299900,
  refundedPaise: 0,
  refunds: [],
  paidAt: 1000,
  refundableUntil: 1000 + 86400,
  ...extra,
});

test("the 24-hour refund window and what is left to refund", () => {
  const ok = refundState(order(), 1000 + 3600);
  assert.equal(ok.can, true);
  assert.equal(ok.remaining, 299900);
  assert.equal(ok.left, "23 h");
  assert.equal(refundState(order(), 1000 + 86400).can, false);
  assert.match(refundState(order(), 1000 + 86400).reason, /24-hour/);
  assert.match(refundState(order({ status: "created" }), 1).reason, /paid/);
  assert.match(refundState(order({ status: "refunded" }), 1).reason, /in full/);
  const partly = order({ status: "partially_refunded", refundedPaise: 100000, refunds: [{ amountPaise: 100000, status: "processed" }, { amountPaise: 50000, status: "pending" }, { amountPaise: 9999, status: "failed" }] });
  assert.equal(refundableAmount(partly), 149900);
  assert.equal(refundState({ ...partly, refunds: [...partly.refunds, { amountPaise: 149900, status: "pending" }] }, 1001).can, false);
  assert.equal(refundState(order({ amountPaise: 0 }), 1001).can, false);
});

test("the refund form: full refund sends no amount", () => {
  assert.deepEqual(readRefundForm("", "Changed her mind", 299900), { ok: true, amountPaise: undefined, reason: "Changed her mind" });
  assert.deepEqual(readRefundForm("2999", "x", 299900), { ok: true, amountPaise: undefined, reason: "x" });
  assert.deepEqual(readRefundForm("1000", "x", 299900), { ok: true, amountPaise: 100000, reason: "x" });
  const bad = readRefundForm("5000", "", 299900);
  assert.equal(bad.ok, false);
  assert.match(bad.errors.amountPaise, /₹2,999/);
  assert.match(bad.errors.reason, /reason/);
  assert.match(readRefundForm("0.5", "x", 299900).errors.amountPaise, /₹1/);
  assert.equal(methodLabel("upi"), "UPI");
  assert.equal(methodLabel(null), "—");
  assert.equal(methodLabel("bank_transfer"), "Bank_transfer");
});

// ---------------------------------------------------------------- students

test("students: phones like the API, access wording, erase confirmation", () => {
  assert.equal(normalizePhone("98250 12345"), "+919825012345");
  assert.equal(normalizePhone("+91 98250-12345"), "+919825012345");
  assert.equal(normalizePhone("09825012345"), "+919825012345");
  assert.equal(normalizePhone("919825012345"), "+919825012345");
  assert.equal(normalizePhone("+447700900123"), "+447700900123");
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone("+911234567890"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(prettyPhone("+919825012345"), "+91 98250 12345");
  assert.equal(whatsappHref("+919825012345", "Hi"), "https://wa.me/919825012345?text=Hi");
  assert.equal(whatsappHref(null), null);
  const now = 5000;
  assert.equal(accessState({ active: true, revokedAt: null, expiresAt: null, mode: "live" }, now), "active");
  assert.equal(accessState({ active: false, revokedAt: 10, expiresAt: null, mode: "live" }, now), "revoked");
  assert.equal(accessState({ active: false, revokedAt: null, expiresAt: 4000, mode: "live" }, now), "expired");
  assert.equal(accessState({ active: false, revokedAt: null, expiresAt: null, mode: "test" }, now), "test");
  assert.equal(eraseConfirmed("  priya   PATEL ", "Priya Patel"), true);
  assert.equal(eraseConfirmed("Priya", "Priya Patel"), false);
  assert.equal(eraseConfirmed("erase", null), true);
  assert.equal(deviceLabel("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36"), "Chrome on Android");
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
  assert.equal(deviceLabel(null), "Unknown device");
});

// ---------------------------------------------------------------- dashboard

test("stats: a full series, two periods and tidy axes", () => {
  const range = statsRange("2026-10-23", 7);
  assert.deepEqual(range, { from: "2026-10-10", to: "2026-10-23", split: "2026-10-17" });
  const row = (day, revenuePaise, paidOrders = 1, courseId = 1) => ({ day, courseId, views: 10, checkoutsStarted: 4, paidOrders, revenuePaise, refundsPaise: 0 });
  const points = fillSeries([row("2026-10-12", 100000), row("2026-10-20", 200000), row("2026-10-20", 50000, 1, 2), row("2026-09-01", 999)], range.from, range.to);
  assert.equal(points.length, 14);
  assert.equal(points.find((p) => p.day === "2026-10-20").revenuePaise, 250000);
  const [before, now] = splitPeriods(points, range.split);
  assert.equal(before.length, 7);
  assert.equal(now.length, 7);
  assert.equal(sum(now).revenuePaise, 250000);
  assert.equal(sum(before).revenuePaise, 100000);
  assert.equal(change(250000, 100000), 150);
  assert.equal(change(5, 0), null);
  assert.equal(conversion({ paidOrders: 1, checkoutsStarted: 3 }), 33.3);
  assert.equal(conversion({ paidOrders: 0, checkoutsStarted: 0 }), null);
  assert.equal(niceMax(0), 100000);
  for (const max of [1, 999, 299900, 1234567, 98765432]) {
    const top = niceMax(max);
    assert.ok(top >= max, `${max} → ${top}`);
    assert.ok(top < max * 4 + 100000, `${max} → ${top} is tidy but not huge`);
  }
});

test("publish wording", () => {
  const base = { contentVersion: 3, publishedVersion: 3, liveVersion: 3, lastRebuildAt: 1, nextAllowedAt: null };
  assert.equal(publishView({ ...base, state: "up_to_date" }).action, false);
  assert.equal(publishView({ ...base, state: "building" }).poll, true);
  assert.equal(publishView({ ...base, state: "queued" }).action, true);
  assert.equal(publishView({ ...base, state: "unknown" }).tone, "off");
  assert.equal(rebuildMessage({ queued: true, nextAllowedAt: 0 }, 0).tone, "success");
  assert.match(rebuildMessage({ queued: false, nextAllowedAt: 100, reason: "debounced" }, 0).text, /about 2 minutes/);
  assert.match(rebuildMessage({ queued: false, nextAllowedAt: 0, reason: "no_hook" }, 0).text, /deploy hook/);
  assert.equal(rebuildMessage({ queued: false, nextAllowedAt: 0, reason: "hook_failed" }, 0).tone, "error");
});

// ---------------------------------------------------------------- uploads

test("uploads are checked like W4 before any byte is sent", () => {
  assert.equal(fileProblem({ name: "a.mp4", type: "video/mp4", size: 10 }, "video"), null);
  assert.match(fileProblem({ name: "IMG_0001.MOV", type: "video/quicktime", size: 10 }, "video"), /MP4/);
  assert.match(fileProblem({ name: "a.mp4", type: "video/mp4", size: 5 * 1024 ** 3 }, "video"), /4 GB/);
  assert.match(fileProblem({ name: "a.svg", type: "image/svg+xml", size: 10 }, "image"), /JPEG/);
  assert.match(fileProblem({ name: "a.jpg", type: "image/jpeg", size: 0 }, "image"), /empty/);
  assert.equal(contentTypeFor({ name: "subs.vtt", type: "" }, "captions"), "text/vtt");
  assert.equal(contentTypeFor({ name: "clip.m4v", type: "video/x-m4v" }, "video"), "video/mp4");
  assert.equal(contentTypeFor({ name: "a.png", type: "image/jpeg" }, "image"), "image/png");
  assert.equal(contentTypeFor({ name: "a.exe", type: "" }, "file"), null);
  assert.equal(formatBytes(1536 * 1024 * 1024), "1.5 GB");
  assert.equal(formatBytes(640 * 1024 * 1024), "640 MB");
  assert.equal(progressText(0, 100 * 1024 * 1024, 0, 1000), "0% · 0 bytes of 100 MB");
  assert.match(progressText(50 * 1024 * 1024, 100 * 1024 * 1024, 0, 10_000), /^50% · 50 MB of 100 MB · about 10 seconds|a few seconds left$/);
  // A resumed upload measures speed from this session's bytes only.
  // 10 MB in 10 s with 140 MB to go: about 2 minutes, not the 23 s that counting the resumed 50 MB would claim.
  assert.match(progressText(60 * 1024 * 1024, 200 * 1024 * 1024, 0, 10_000, 50 * 1024 * 1024), /about 2 minutes left$/);
  assert.equal(keyName("videos/2026/10/0123456789abcdef-soft-glam.mp4"), "soft-glam.mp4");
  assert.equal(imageUrl("images/2026/10/0123456789abcdef-cover.webp"), "/media/i/images/2026/10/0123456789abcdef-cover.webp");
});

// ---------------------------------------------------------------- activity log

test("activity log sentences, links and details", () => {
  assert.equal(auditSentence("course.publish"), "Published a course");
  assert.equal(auditSentence("backup.run"), "Run (backup)");
  assert.equal(auditHref({ entity: "course", entityId: "4" }), "/admin/courses/edit?id=4");
  assert.equal(auditHref({ entity: "student", entityId: "9" }), "/admin/students?open=9");
  assert.equal(auditHref({ entity: "site", entityId: null }), null);
  assert.equal(auditHref({ entity: "course", entityId: "../x" }), "/admin/courses");
  assert.equal(auditDetails({ slug: { from: "a", to: "b" }, fields: ["title", "pricePaise"], ok: true }), "slug: a → b · fields: title, pricePaise · ok: true");
  assert.equal(auditDetails(null), "");
  assert.equal(auditDetails({ a: 1, b: 2, c: 3, d: 4, e: 5 }).split(" · ").length, 4);
});
