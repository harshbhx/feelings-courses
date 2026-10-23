// The learner-facing pages Functions render (sign-in, account, course home, lesson, certificate,
// receipt and their empty, error and expired states): the brand look stays in one stylesheet, the
// pages stay CSP-clean and accessible, and each state says what the student needs to know.
// The pages come from the same world as scripts/preview-student-pages.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ICON_PATHS } from "../../functions/_lib/pages/icons.ts";
import { batchLine, formatClock, formatDay } from "../../functions/_lib/pages/html.ts";
import { receiptHeaders } from "../../functions/_lib/receipts.ts";
import { studentPages } from "../../scripts/preview-student-pages.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const read = (rel) => readFileSync(path.join(root, rel), "utf8");
const css = read("public/app/app.css");

let rendered;
async function pages() {
  if (!rendered) {
    rendered = {};
    for (const [file, [, render]] of Object.entries(await studentPages())) {
      const res = await render();
      rendered[file] = { status: res.status, headers: res.headers, body: await res.text() };
    }
  }
  return rendered;
}

// ---------------------------------------------------------------- brand and colour

/** The :root custom properties of a stylesheet that hold a plain hex colour. */
function hexTokens(source) {
  const out = {};
  for (const [, name, value] of source.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)) out[name] = value.toLowerCase();
  return out;
}

test("app.css mirrors the brand palette in src/styles/tokens.css", () => {
  const brand = hexTokens(read("src/styles/tokens.css"));
  const app = hexTokens(css);
  const shared = Object.keys(app).filter((name) => name in brand);
  assert.ok(shared.length >= 14, "the raw palette is mirrored");
  for (const name of shared) assert.equal(app[name], brand[name], `${name} matches tokens.css`);
  assert.match(css, /font-family: var\(--font\)/);
  assert.match(css, /"Plus Jakarta Sans Variable"/, "the brand typeface");
  for (const [, url] of css.matchAll(/url\("([^"]+)"\)/g)) {
    assert.ok(existsSync(path.join(root, "public/app", url)), `${url} is shipped in public/app`);
  }
});

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** White at `alpha` over `under`. */
const whiteOver = (under, alpha) =>
  `#${[1, 3, 5].map((i) => Math.round(255 * alpha + parseInt(under.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;

test("text colours reach 4.5:1 on every surface they sit on (WCAG AA)", () => {
  const t = hexTokens(css);
  const text = [
    ["body text on blush page", t["--ink-700"], t["--rose-50"]],
    ["muted on white", t["--ink-500"], t["--white"]],
    ["muted on blush page", t["--ink-500"], t["--rose-50"]],
    ["muted on tint (current lesson, alerts)", t["--ink-500"], t["--rose-100"]],
    ["sindoor link on white", t["--red-600"], t["--white"]],
    ["sindoor 'Up next' on tint", t["--red-600"], t["--rose-100"]],
    ["white on the primary button", t["--white"], t["--red-600"]],
    ["white on the pressed button", t["--white"], t["--red-700"]],
    ["green 'done' and 'verified' on white", t["--green-700"], t["--white"]],
    ["green on blush page", t["--green-700"], t["--rose-50"]],
    ["henna warning on tint", t["--henna-600"], t["--rose-100"]],
    ["white on the maroon resume band", t["--white"], t["--maroon-800"]],
    ["80% white on the maroon resume band", whiteOver(t["--maroon-800"], 0.8), t["--maroon-800"]],
    ["sindoor on white inside the maroon band's button", t["--red-600"], t["--white"]],
  ];
  for (const [what, fg, bg] of text) assert.ok(contrast(fg, bg) >= 4.5, `${what}: ${contrast(fg, bg).toFixed(2)}:1`);
  // Non-text (form borders, empty ticks): 3:1 (WCAG 1.4.11).
  assert.ok(contrast(t["--ink-300"], t["--white"]) >= 3, "control borders on white");
  assert.match(css, /:focus-visible \{\s*outline: 2px solid var\(--focus\)/, "a visible focus ring everywhere");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "motion stops for reduced motion");
});

test("icons for Functions pages are the same Phosphor paths as src/icons", () => {
  for (const [name, d] of Object.entries(ICON_PATHS)) {
    const svg = read(`src/icons/${name}.svg`);
    assert.ok(svg.includes(`d="${d}"`), `${name} matches src/icons/${name}.svg`);
  }
});

test("small formatters", () => {
  assert.equal(formatClock(192), "3:12");
  assert.equal(formatClock(3729), "1:02:09");
  assert.equal(formatClock(-4), "0:00");
  assert.equal(formatDay("2026-11-08"), "8 Nov 2026");
  assert.equal(formatDay("soon"), "soon");
  assert.equal(batchLine({ title: "Sunday workshop", startsOn: "2026-11-08", endsOn: null }), "Sunday workshop, 8 Nov 2026");
  assert.equal(batchLine({ title: "Dec", startsOn: "2026-12-01", endsOn: "2026-12-19" }), "Dec, 1 Dec 2026 to 19 Dec 2026");
});

// ---------------------------------------------------------------- every page

test("every student page: CSP-clean, one h1, labelled fields, English, no GSTIN", async () => {
  for (const [file, { status, body }] of Object.entries(await pages())) {
    assert.ok(status < 500, `${file} renders (${status})`);
    assert.ok(body.includes('<link rel="stylesheet" href="/app/app.css">'), `${file} uses the shared stylesheet`);
    assert.equal(/ style=/.test(body), false, `${file}: no inline style attribute`);
    assert.equal(/<style/.test(body), false, `${file}: no <style> block`);
    const inline = [...body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
    assert.ok(inline.length === 0 || file.startsWith("receipt"), `${file}: no inline script`);
    assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1, `${file}: one h1`);
    assert.equal(/<html lang="en"/.test(body), true, `${file}: lang`);
    assert.equal(/[ऀ-૿]/.test(body), false, `${file}: English only`);
    assert.equal(/GSTIN|gstin/.test(body), false, `${file}: never a GSTIN`);
    for (const [, tag] of body.matchAll(/<img([^>]*)>/g)) assert.match(tag, /\balt="/, `${file}: img has alt`);
    for (const [, tag] of body.matchAll(/<svg([^>]*)>/g)) {
      assert.ok(/aria-hidden="true"/.test(tag) || /role="img" aria-label="[^"]+"/.test(tag), `${file}: icons are hidden or labelled`);
    }
    for (const [, tag] of body.matchAll(/<input([^>]*)>/g)) {
      if (/type="hidden"/.test(tag)) continue;
      const id = /\bid="([^"]+)"/.exec(tag)?.[1];
      assert.ok(id && body.includes(`for="${id}"`), `${file}: input ${id ?? tag} has a label`);
    }
    assert.ok(body.includes('class="skip" href="#main"') && body.includes('id="main"'), `${file}: skip link`);
  }
});

test("sign-in explains a device signed out by the 2-device limit, and only then", async () => {
  const all = await pages();
  assert.ok(all["signin-device-ended.html"].body.includes("This device was signed out"));
  assert.ok(all["signin-device-ended.html"].body.includes("2 devices at a time"));
  assert.equal(all["signin.html"].body.includes("This device was signed out"), false);
  assert.ok(all["signin-error.html"].body.includes('role="alert"'));
  assert.ok(all["link-expired.html"].body.includes("Ask for a new link"), "an expired link offers WhatsApp");
});

test("account: course cards with progress and the next step; empty state; device slots", async () => {
  const all = await pages();
  const account = all["account.html"].body;
  assert.match(account, /<progress max="7" value="2"/);
  assert.ok(account.includes('href="/learn/everyday-glow"'));
  assert.ok(account.includes("Continue"));
  assert.ok(account.includes("Completed"), "a finished course says so");
  assert.ok(account.includes("Sunday workshop, 8 Nov 2026"), "batch dates read like dates");
  assert.equal(account.includes('href="/learn/old-class"'), false, "no link into an ended course");
  assert.equal((account.match(/class="slot used"/g) ?? []).length, 2, "both device slots in use");
  const empty = all["account-empty.html"].body;
  assert.ok(empty.includes("No courses yet"));
  assert.ok(empty.includes('href="/"'), "a way to the courses");
});

test("course home: resume band, current lesson marked, module totals, certificate card", async () => {
  const home = (await pages())["course-home.html"].body;
  assert.ok(home.includes('class="resume"'));
  assert.ok(home.includes("Up next · Lesson 3 of 7"));
  assert.ok(home.includes("Pick up at 3:12"), "where the student left off");
  assert.ok(home.includes('href="/learn/everyday-glow/foundation" aria-current="step"'));
  assert.ok(home.includes("2 of 3 done · 26 min"), "module progress and length");
  assert.ok(home.includes("Finish every lesson to get your certificate."));
  const done = (await pages())["course-complete.html"].body;
  assert.ok(done.includes("You&#39;ve finished every lesson."));
  assert.ok(done.includes("View and print"));
});

test("lesson page: resume note, outline with the current lesson, next lesson after done", async () => {
  const all = await pages();
  const lesson = all["lesson.html"].body;
  assert.ok(lesson.includes("Picking up where you left off, at 3:12."));
  assert.ok(lesson.includes('data-resume="192"'));
  assert.ok(lesson.includes('href="/learn/everyday-glow/foundation" aria-current="page"'));
  assert.ok(lesson.includes('data-next-lesson hidden'), "next-lesson button waits for 'done'");
  assert.ok(lesson.includes('class="player-wait"'), "a loading mark behind the video");
  assert.ok(lesson.includes('aria-label="Video: Choosing and blending foundation"'));
  assert.ok(lesson.includes('rel="next"') && lesson.includes('rel="prev"'));
  assert.ok(all["lesson-no-video.html"].body.includes("This lesson&#39;s video is being prepared."));
});

test("state pages: access ended, not in account, certificate not yet, not found", async () => {
  const all = await pages();
  assert.equal(all["access-ended.html"].status, 403);
  assert.ok(all["access-ended.html"].body.includes("Access lasts one year from purchase."));
  assert.ok(all["access-ended.html"].body.includes("Message us on WhatsApp"));
  assert.equal(all["not-in-account.html"].status, 404);
  assert.ok(all["not-in-account.html"].body.includes('href="/signin"'));
  assert.ok(all["certificate-almost.html"].body.includes("Finish every lesson"));
  assert.equal(all["verify-not-found.html"].status, 404);
  assert.equal(all["receipt-missing.html"].status, 404);
});

test("certificate: verified banner, the printable certificate on its own landscape page", async () => {
  const cert = (await pages())["certificate.html"].body;
  assert.ok(cert.includes("Verified: this certificate was issued by Feelings Beauty Care."));
  assert.ok(cert.includes('<p class="cert-name">Asha Patel</p>'));
  assert.ok(cert.includes("Bridal Makeup Academy certificate"));
  assert.ok(cert.includes("23 October 2026"));
  assert.equal(cert.includes("+919876543210") || cert.includes("asha@example.com"), false, "no contact details");
  assert.match(css, /@page certificate \{\s*size: A4 landscape;/);
  assert.match(css, /\.certificate \{\s*page: certificate;/);
});

test("receipts: thank-you and the next step first, studio and refunded variants, tighter CSP", async () => {
  const all = await pages();
  const online = all["receipt.html"].body;
  assert.ok(online.includes("Payment received"));
  assert.ok(online.includes("Thank you, Asha."));
  assert.ok(online.includes("Start learning"));
  assert.ok(online.includes('href="https://courses.feelingsbeautycare.in/learn/everyday-glow"'));
  assert.ok(online.includes("Coupon DIWALI10"));
  assert.ok(online.includes("Refund requests are accepted until"));
  assert.ok(online.includes("FBC/26-27/00012"));
  assert.equal(online.includes("9876543210"), false, "the phone is masked");
  const studio = all["receipt-studio.html"].body;
  assert.ok(studio.includes("See you at the studio"));
  assert.ok(studio.includes("Sunday workshop, 8 Nov 2026"));
  assert.equal(studio.includes("/learn/"), false, "no course area for a studio-only booking");
  assert.equal(studio.includes("Access until"), false);
  assert.equal((studio.match(/<tr class="total">/g) ?? []).length, 1, "one total: the booking amount");
  const refunded = all["receipt-refunded.html"].body;
  assert.ok(refunded.includes("Payment refunded"));
  assert.equal(refunded.includes("Start learning"), false);
  const csp = (await receiptHeaders())["Content-Security-Policy"];
  assert.equal(csp.includes("unsafe-inline"), false);
  assert.match(csp, /style-src 'self'; font-src 'self'/);
});
