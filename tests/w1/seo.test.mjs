// src/lib/course-view.ts and src/lib/seo.ts: landing page wording, robots, sitemaps, JSON-LD.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedCourse, seedSnapshot } from "../../src/data/seed-snapshot.ts";
import { course as demoCourse } from "../../src/data/course.ts";
import { batchDates, clip, courseView, formatAccess, formatInr, seatsLabel } from "../../src/lib/course-view.ts";
import {
  courseIndexable,
  courseJsonLd,
  courseSitemapUrls,
  courseTitle,
  hubIndexable,
  hubOrigin,
  hubSitemapUrls,
  isPreviewBuild,
  jsonLdText,
  sitemapXml,
} from "../../src/lib/seo.ts";

const PROD = {};
const PREVIEW = { CF_PAGES_BRANCH: "feat/x" };

function realCourse(overrides = {}) {
  return { ...seedCourse(), isDemo: false, ...overrides };
}

test("formatInr, formatAccess, dates and seats", () => {
  assert.equal(formatInr(299900), "₹2,999");
  assert.equal(formatInr(1500000), "₹15,000");
  assert.equal(formatInr(299950), "₹2,999.50");
  assert.equal(formatInr(0), "Free");
  assert.equal(formatAccess(365), "12 months");
  assert.equal(formatAccess(730), "2 years");
  assert.equal(formatAccess(90), "3 months");
  assert.equal(formatAccess(45), "45 days");
  assert.equal(batchDates({ startsOn: "2026-11-03", endsOn: null }), "3 Nov 2026");
  assert.equal(batchDates({ startsOn: "2026-11-03", endsOn: "2027-02-28" }), "3 Nov 2026 to 28 Feb 2027");
  assert.equal(seatsLabel({ seatsLeft: null }), null);
  assert.equal(seatsLabel({ seatsLeft: 0 }), "Full");
  assert.equal(seatsLabel({ seatsLeft: 1 }), "1 seat left");
  assert.equal(clip("a ".repeat(200), 20).length <= 20, true);
});

test("the demo course reads the same as the demo page did (course.ts wording)", () => {
  const v = courseView(seedCourse());
  assert.equal(v.priceDisplay, demoCourse.price.display);
  assert.equal(v.accessText, demoCourse.access);
  assert.equal(v.eyebrow, `Online course by ${demoCourse.teacher}`);
  assert.equal(v.enrollLabel, `Enroll for ${demoCourse.price.display}`);
  assert.equal(v.lessonCount, demoCourse.modules.reduce((n, m) => n + m.lessons.length, 0));
  assert.deepEqual(v.stats.map((s) => s.unit), ["lessons", "minutes", "months access"]);
  assert.equal(v.hasLessons, true);
  assert.equal(v.hasBatches, false);
  assert.equal(v.depositDisplay, null);
});

test("hybrid and studio courses: batches, booking amount and duration", () => {
  const batches = [{ id: 1, title: "Nov batch", startsOn: "2026-11-03", endsOn: null, scheduleText: null, pricePaise: null, seatsLeft: 4 }];
  const hybrid = courseView(realCourse({ format: "hybrid", pricePaise: 1500000, depositPaise: 200000, durationText: "3 months", batches }));
  assert.equal(hybrid.hasBatches, true);
  assert.equal(hybrid.hasLessons, true);
  assert.equal(hybrid.depositDisplay, "₹2,000");
  assert.equal(hybrid.enrollLabel, "Book for ₹2,000");
  assert.equal(hybrid.formatLabel, "Studio and online course");
  assert.deepEqual(hybrid.stats.slice(0, 2).map((s) => s.unit), ["lessons", "minutes"]);

  const studio = courseView(realCourse({ format: "in_person", durationText: "5 days", batches }));
  assert.equal(studio.hasLessons, false, "a studio course never promises recorded lessons");
  assert.deepEqual(studio.stats, [{ value: "5", unit: "days" }, { value: "1", unit: "batch open" }]);
  assert.equal(studio.enrollLabel, `Enroll for ${studio.priceDisplay}`);

  const online = courseView(realCourse({ depositPaise: 200000 }));
  assert.equal(online.depositDisplay, null, "no booking amount for online courses");
});

test("preview builds and demo content are never indexed", () => {
  assert.equal(isPreviewBuild(PROD), false);
  assert.equal(isPreviewBuild({ CF_PAGES_BRANCH: "main" }), false);
  assert.equal(isPreviewBuild(PREVIEW), true);
  assert.equal(courseIndexable(seedCourse(), PROD), false, "seed is demo");
  assert.equal(courseIndexable(realCourse(), PROD), true);
  assert.equal(courseIndexable(realCourse(), PREVIEW), false);
  assert.equal(hubIndexable(seedSnapshot(0), PROD), false);
  assert.equal(hubOrigin({ HUB_HOST: "Courses.Example.in" }), "https://courses.example.in");
  assert.equal(hubOrigin({ HUB_HOST: "not a host" }), "https://courses.feelingsbeautycare.in");
});

test("titles fall back to '<title> by <teacher> | <business>'", () => {
  assert.equal(courseTitle(seedCourse(), "Feelings Beauty Care"), `${demoCourse.title} by ${demoCourse.teacher} | Feelings Beauty Care`);
  assert.equal(courseTitle(realCourse({ seoTitle: "  Custom  " }), "X"), "Custom");
});

test("sitemaps: hub lists catalog, hub-hosted courses and legal pages; course hosts list themselves", () => {
  const snap = { ...seedSnapshot(Date.UTC(2026, 9, 23) / 1000) };
  assert.deepEqual(hubSitemapUrls(snap, PROD), [], "all demo: empty sitemap");

  const onHub = realCourse({ id: 2, slug: "diploma", canonicalUrl: "https://courses.feelingsbeautycare.in/c/diploma" });
  const ownHost = realCourse({ id: 3, slug: "crashcourse", domainActive: true, canonicalUrl: "https://crashcourse.feelingsbeautycare.in/" });
  const real = { ...snap, courses: [seedCourse(), onHub, ownHost] };
  const urls = hubSitemapUrls(real, PROD).map((u) => u.loc);
  assert.deepEqual(urls, [
    "https://courses.feelingsbeautycare.in/",
    "https://courses.feelingsbeautycare.in/c/diploma",
    "https://courses.feelingsbeautycare.in/legal/terms",
    "https://courses.feelingsbeautycare.in/legal/refunds",
    "https://courses.feelingsbeautycare.in/legal/privacy",
    "https://courses.feelingsbeautycare.in/legal/delivery",
  ]);
  assert.deepEqual(hubSitemapUrls(real, PREVIEW), []);
  assert.deepEqual(courseSitemapUrls(ownHost, real, PROD).map((u) => u.loc), ["https://crashcourse.feelingsbeautycare.in/"]);
  assert.deepEqual(courseSitemapUrls(onHub, real, PROD), [], "no active domain: listed by the hub");

  const xml = sitemapXml([{ loc: "https://x.in/?a=1&b=<2>", lastmod: "2026-10-23" }]);
  assert.match(xml, /<loc>https:\/\/x\.in\/\?a=1&amp;b=&lt;2&gt;<\/loc><lastmod>2026-10-23<\/lastmod>/);
  assert.match(sitemapXml([]), /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">\n<\/urlset>/);
});

test("JSON-LD: a Course with offers and instances, no ratings, script-safe", () => {
  const batches = [{ id: 1, title: "Nov </script> batch", startsOn: "2026-11-03", endsOn: "2027-02-28", scheduleText: null, pricePaise: null, seatsLeft: 4 }];
  const business = seedSnapshot(0).settings.business;
  const ld = courseJsonLd(realCourse({ format: "hybrid", batches }), business);
  assert.equal(ld["@type"], "Course");
  assert.equal(ld.offers.priceCurrency, "INR");
  assert.equal(ld.offers.price, "2999.00");
  assert.deepEqual(ld.hasCourseInstance.map((i) => i.courseMode), ["online", "onsite"]);
  const text = jsonLdText(ld);
  assert.ok(!text.includes("</script>"));
  assert.ok(!/aggregateRating|review/i.test(text), "no ratings or reviews in structured data");
  assert.ok(!/gstin/i.test(text));
  assert.deepEqual(JSON.parse(text), ld, "escapes round-trip");
});
