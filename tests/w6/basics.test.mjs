// W6 admin UI logic: money, India time, slugs and YouTube links, the domain helper, errors and
// the sign-in redirect, filters and paging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { feeLabel, formatPaise, paiseShort, paiseToInput, parseRupees } from "../../src/components/admin/lib/money.ts";
import {
  addDays,
  ago,
  daysBetween,
  istDay,
  istDayStart,
  istInputValue,
  istTime,
  roughDuration,
  timeLeft,
  unixFromIstInput,
} from "../../src/components/admin/lib/time.ts";
import {
  courseAddresses,
  courseSlugFrom,
  courseSlugProblem,
  lessonSlugFrom,
  lessonSlugProblem,
  tidyCourseSlug,
  youtubeId,
} from "../../src/components/admin/lib/slug.ts";
import { domainSteps, domainView, probeText, coursesNeedingDomain } from "../../src/components/admin/lib/domain.ts";
import { describeError, safeNext, signInHref } from "../../src/components/admin/lib/errors.ts";
import { csvHref, hasFilters, pageInfo, readOrderFilters, readStudentFilters, toSearch } from "../../src/components/admin/lib/filters.ts";
import { COURSE_SLUG_RE, RESERVED_LABELS } from "../../src/shared/constants.ts";

// 2026-10-23 00:00 IST = 2026-10-22 18:30 UTC
const OCT23_IST = Date.UTC(2026, 9, 22, 18, 30) / 1000;

test("parseRupees reads what people type, exactly, in paise", () => {
  assert.deepEqual(parseRupees(""), { ok: true, paise: null });
  assert.deepEqual(parseRupees("  "), { ok: true, paise: null });
  assert.deepEqual(parseRupees("2999"), { ok: true, paise: 299900 });
  assert.deepEqual(parseRupees("₹ 2,999"), { ok: true, paise: 299900 });
  assert.deepEqual(parseRupees("2999.5"), { ok: true, paise: 299950 });
  assert.deepEqual(parseRupees("2999.10"), { ok: true, paise: 299910 });
  assert.deepEqual(parseRupees("0.29"), { ok: true, paise: 29 });
  assert.deepEqual(parseRupees(".5"), { ok: true, paise: 50 });
  assert.deepEqual(parseRupees("0"), { ok: true, paise: 0 });
  assert.deepEqual(parseRupees("Rs.500"), { ok: true, paise: 50000 });
  assert.equal(parseRupees("-5").ok, false);
  assert.equal(parseRupees("12a").ok, false);
  assert.equal(parseRupees("1.234").ok, false);
  assert.match(parseRupees("1.234").error, /two digits/);
  assert.equal(parseRupees(".").ok, false);
  assert.equal(parseRupees("2000", { max: 100000 }).ok, false);
});

test("paise come back as inputs and labels", () => {
  assert.equal(paiseToInput(299900), "2999");
  assert.equal(paiseToInput(299905), "2999.05");
  assert.equal(paiseToInput(null), "");
  assert.equal(formatPaise(299900), "₹2,999");
  assert.equal(formatPaise(10000000), "₹1,00,000");
  assert.equal(formatPaise(299950), "₹2,999.50");
  assert.equal(feeLabel(null), "No fee yet");
  assert.equal(feeLabel(0), "Free");
  assert.equal(paiseShort(120000000), "₹12L");
  assert.equal(paiseShort(1250000), "₹12.5K");
  assert.equal(paiseShort(95000), "₹950");
  for (const p of [0, 1, 99, 100, 12345, 299950, 99999999]) {
    const back = parseRupees(paiseToInput(p));
    assert.equal(back.ok && back.paise, p, `round trip ${p}`);
  }
});

test("India time: days, inputs and wording do not depend on the browser's zone", () => {
  assert.equal(istDay(OCT23_IST), "2026-10-23");
  assert.equal(istDay(OCT23_IST - 1), "2026-10-22");
  assert.equal(istDayStart("2026-10-23"), OCT23_IST);
  assert.equal(istDayStart("2026-02-30"), null);
  assert.equal(istDayStart("23-10-2026"), null);
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.deepEqual(daysBetween("2026-12-30", "2027-01-02"), ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  assert.equal(istInputValue(OCT23_IST + 18.5 * 3600), "2026-10-23T18:30");
  assert.equal(unixFromIstInput("2026-10-23T18:30"), OCT23_IST + 18.5 * 3600);
  assert.equal(unixFromIstInput(""), null);
  assert.equal(unixFromIstInput("2026-10-23T25:00"), undefined);
  assert.equal(unixFromIstInput("tomorrow"), undefined);
  assert.equal(istTime(OCT23_IST + 18.5 * 3600), "6:30 pm");
});

test("relative times and durations", () => {
  const now = OCT23_IST + 15 * 3600; // 3 pm
  assert.equal(ago(now - 20, now), "Just now");
  assert.equal(ago(now - 600, now), "10 min ago");
  assert.equal(ago(now - 3 * 3600, now), "3 h ago");
  assert.match(ago(now - 20 * 3600, now), /^Yesterday, 7:00 pm$/);
  assert.match(ago(now - 5 * 86400, now), /^18 Oct, /);
  assert.match(ago(now - 400 * 86400, now), /^\d{1,2} \S+ 2025$/);
  assert.equal(roughDuration(10), "a few seconds");
  assert.equal(roughDuration(80), "about a minute");
  assert.equal(roughDuration(600), "about 10 minutes");
  assert.equal(roughDuration(3600), "about an hour");
  assert.equal(roughDuration(5 * 3600), "about 5 hours");
  assert.equal(timeLeft(5 * 3600 + 12 * 60 + 5), "5 h 12 min");
  assert.equal(timeLeft(38 * 60), "38 min");
  assert.equal(timeLeft(3 * 3600), "3 h");
  assert.equal(timeLeft(10), "under a minute");
});

test("course slugs: suggestions are always valid, problems match the API", () => {
  assert.equal(courseSlugFrom("Bridal Makeup & Hair"), "bridal-makeup-and-hair");
  assert.equal(courseSlugFrom("  Café Glam!!  "), "cafe-glam");
  assert.equal(courseSlugFrom("Academy"), "academy-course");
  assert.equal(courseSlugFrom("मेकअप"), "");
  const long = courseSlugFrom("The complete professional bridal and party makeup masterclass for beginners");
  assert.ok(long.length <= 40 && COURSE_SLUG_RE.test(long), long);
  for (const t of ["A b", "Hello---World", "x".repeat(80), "Glam 2027"]) {
    const s = courseSlugFrom(t);
    assert.ok(s === "" || courseSlugProblem(s) === null, `${t} → ${s}`);
  }
  assert.equal(tidyCourseSlug("Bridal Basics_2"), "bridal-basics-2");
  assert.equal(tidyCourseSlug("a--b"), "a-b");
  assert.equal(courseSlugProblem("bridal-basics"), null);
  assert.match(courseSlugProblem(""), /Choose/);
  assert.match(courseSlugProblem("admin"), /reserved/);
  assert.match(courseSlugProblem("a"), /2 to 40/);
  assert.match(courseSlugProblem("-ab"), /2 to 40/);
  assert.match(courseSlugProblem("a--b"), /2 to 40/);
  for (const r of RESERVED_LABELS) assert.ok(courseSlugProblem(r), r);
});

test("lesson slugs are unique and never reserved", () => {
  assert.equal(lessonSlugFrom("Soft glam"), "soft-glam");
  assert.equal(lessonSlugFrom("Soft glam", new Set(["soft-glam"])), "soft-glam-2");
  assert.equal(lessonSlugFrom("Soft glam", new Set(["soft-glam", "soft-glam-2"])), "soft-glam-3");
  assert.equal(lessonSlugFrom("Certificate"), "certificate-lesson");
  assert.equal(lessonSlugFrom("!!!"), "lesson");
  assert.equal(lessonSlugProblem("soft-glam"), null);
  assert.match(lessonSlugProblem("index"), /reserved/);
  assert.match(lessonSlugProblem("Soft Glam"), /hyphens/);
  assert.match(lessonSlugProblem(""), /web address/);
  assert.match(lessonSlugProblem("tmp-reorder-3"), /reserved/);
});

test("YouTube ids from ids and every kind of link", () => {
  const id = "dQw4w9WgXcQ";
  for (const v of [
    id,
    `https://www.youtube.com/watch?v=${id}&t=10s`,
    `https://youtu.be/${id}?si=abc`,
    `youtube.com/shorts/${id}`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/live/${id}`,
  ]) {
    assert.equal(youtubeId(v), id, v);
  }
  assert.equal(youtubeId("https://vimeo.com/123"), null);
  assert.equal(youtubeId("https://evil.com/watch?v=dQw4w9WgXcQ"), null);
  assert.equal(youtubeId("short"), null);
});

test("course addresses and the Cloudflare helper", () => {
  const a = courseAddresses("bridal-basics");
  assert.equal(a.host, "bridal-basics.feelingsbeautycare.in");
  assert.equal(a.subdomainUrl, "https://bridal-basics.feelingsbeautycare.in/");
  assert.equal(a.hubUrl, "https://courses.feelingsbeautycare.in/c/bridal-basics");
  const steps = domainSteps("bridal-basics");
  assert.ok(steps.length >= 4 && steps.length <= 5);
  assert.equal(steps.filter((s) => s.copy).length, 1);
  assert.equal(steps.find((s) => s.copy).copy, "bridal-basics.feelingsbeautycare.in");
  assert.ok(steps.some((s) => (s.detail ?? "").includes("feelings-courses.pages.dev")));
  assert.equal(domainView("active", "x1").tone, "live");
  assert.equal(domainView("pending", "x1").tone, "wait");
  assert.equal(domainView("none", "x1").tone, "off");
  assert.match(probeText("timeout", "pending"), /5 seconds/);
  assert.match(probeText("unreachable", "pending"), /doesn't exist/);
  assert.match(probeText(522, "pending"), /522/);
  assert.match(probeText(404, "pending"), /HTTP 404/);
  assert.match(probeText(200, "active"), /live/);
  assert.equal(
    coursesNeedingDomain([
      { status: "published", domainStatus: "none" },
      { status: "draft", domainStatus: "pending" },
      { status: "archived", domainStatus: "none" },
      { status: "published", domainStatus: "active" },
    ]),
    2,
  );
});

test("errors read well for the owner", () => {
  const e = (status, code, message = "Server says", retryAfter = null) => ({ status, code, message, retryAfter });
  assert.equal(describeError(e(0, "network_error", "You seem to be offline.")).kind, "offline");
  assert.equal(describeError(e(401, "unauthorized")).kind, "signin");
  assert.equal(describeError(e(503, "platform_not_configured")).kind, "setup");
  const coming = describeError(e(501, "not_implemented"));
  assert.equal(coming.kind, "coming");
  assert.equal(coming.retry, false);
  const wait = describeError(e(429, "admin_locked", "Too many wrong passwords. Sign-in is locked for a while to keep the admin safe.", 3000));
  assert.match(wait.message, /about 50 minutes/);
  assert.match(describeError(e(429, "rate_limited", "Too many tries. Please wait a little and try again.", 120)).message, /^Too many tries\. Try again in about 2 minutes\.$/);
  assert.equal(describeError(e(409, "in_use", "Archive it instead.")).message, "Archive it instead.");
  assert.equal(describeError(e(500, "server_error", "boom")).retry, true);
  assert.doesNotMatch(describeError(e(500, "server_error", "SQL boom")).message, /SQL/);
});

test("the sign-in redirect only ever goes to admin pages", () => {
  assert.equal(safeNext("/admin/courses/edit?id=4"), "/admin/courses/edit?id=4");
  assert.equal(safeNext("/admin/students?q=priya%20p"), "/admin/students?q=priya%20p");
  assert.equal(safeNext(null), "/admin/dashboard");
  for (const bad of ["https://evil.com", "//evil.com/admin/x", "/admin/../learn", "/learn", "/admin\\x", "javascript:alert(1)", "/admin/x?y=<script>"]) {
    assert.equal(safeNext(bad), "/admin/dashboard", bad);
  }
  assert.equal(signInHref("/admin/dashboard"), "/admin");
  assert.equal(signInHref("/admin/payments?status=paid"), "/admin?next=%2Fadmin%2Fpayments%3Fstatus%3Dpaid");
});

test("filters live in the address bar and only known values come back", () => {
  assert.deepEqual(readStudentFilters("?q=%20priya%20&course=3&page=2"), { q: "priya", course: 3, page: 2 });
  assert.deepEqual(readStudentFilters("?course=abc&page=-1"), { q: undefined, course: undefined, page: undefined });
  assert.deepEqual(readOrderFilters("?status=paid&from=2026-10-01&to=2026-10-31&course=2"), {
    status: "paid",
    course: 2,
    from: "2026-10-01",
    to: "2026-10-31",
    page: undefined,
  });
  assert.deepEqual(readOrderFilters("?status=hacked&from=2026-13-01"), { status: undefined, course: undefined, from: undefined, to: undefined, page: undefined });
  assert.equal(toSearch({ q: "priya p", course: undefined, page: 1 }), "?q=priya+p");
  assert.equal(toSearch({ page: 3 }), "?page=3");
  assert.equal(toSearch({}), "");
  assert.equal(csvHref("/api/admin/orders.csv", { status: "paid", page: 4 }), "/api/admin/orders.csv?status=paid");
  assert.equal(csvHref("/api/admin/students.csv", {}), "/api/admin/students.csv");
  assert.equal(hasFilters({ page: 2 }), false);
  assert.equal(hasFilters({ q: "a" }), true);
});

test("paging labels", () => {
  assert.deepEqual(pageInfo(2, 25, 112), { page: 2, pages: 5, hasPrev: true, hasNext: true, label: "26–50 of 112" });
  assert.equal(pageInfo(5, 25, 112).label, "101–112 of 112");
  assert.equal(pageInfo(9, 25, 112).page, 5);
  assert.deepEqual(pageInfo(1, 25, 0), { page: 1, pages: 1, hasPrev: false, hasNext: false, label: "None" });
  assert.equal(pageInfo(1, 25, 1500).label, "1–25 of 1,500");
});
