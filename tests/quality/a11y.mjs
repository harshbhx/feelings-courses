// Accessibility pass for every page in tests/quality/pages.mjs, in a real browser, at a phone
// (390 x 844) and a laptop (1280 x 900). CI only (.github/workflows/quality.yml): it needs Chromium.
//
//   npm i --no-save playwright@1.48.2 @axe-core/playwright@4.10.2
//   PW_CHANNEL=chrome ADMIN_COOKIE=… node tests/quality/a11y.mjs [outDir]
//
// For each page and width:
//   axe       WCAG 2.0, 2.1 and 2.2 A and AA rules plus axe's best practices; any violation fails;
//   keyboard  the first Tab lands on a visible skip link whose target exists, and following it moves
//             focus into the main content; the next 40 Tab stops are visible and show a focus ring;
//   motion    with prefers-reduced-motion: reduce, nothing loops and nothing runs longer than 300 ms
//             (the site's tiered rule, src/styles/motion.css: movement goes, short fades stay);
//   layout    no sideways scroll (CLAUDE.md rule 2);
//   language  <html lang> is set.
// Writes <outDir>/a11y.json and prints a Markdown summary; exit 1 when anything failed.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
// @ts-ignore: installed only by the quality workflow, never a dependency.
import { chromium } from "playwright";
// @ts-ignore: as above.
import { AxeBuilder } from "@axe-core/playwright";
import { PAGES, needsAdmin } from "./pages.mjs";

const outDir = path.resolve(process.argv[2] ?? "quality-report");
mkdirSync(outDir, { recursive: true });
const adminCookie = process.env.ADMIN_COOKIE ?? "";

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
];
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const TAB_STOPS = 40;

const results = [];
const problems = [];
const report = (page, viewport, kind, message) => problems.push({ page: page.name, url: page.url, viewport: viewport.name, kind, message });

async function settle(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Waits (at most 3 s) for entrance animations to end, so axe measures colours at full opacity. */
async function animationsDone(page) {
  await page.evaluate(() =>
    Promise.race([
      Promise.all(
        document
          .getAnimations()
          .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
          .map((a) => a.finished.catch(() => undefined)),
      ),
      new Promise((r) => setTimeout(r, 3000)),
    ]),
  );
}

/**
 * Puts the sequential focus starting point at the very top of the document, as when a keyboard
 * user arrives on the page (a script's autofocus or an earlier check may have moved it): focus a
 * temporary element placed first in <body>, then remove it on the next Tab.
 */
async function focusFromTop(page) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const start = document.createElement("span");
    start.id = "__quality_start";
    start.tabIndex = -1;
    document.body.prepend(start);
    start.focus();
  });
}

async function tab(page) {
  await page.keyboard.press("Tab");
  await page.evaluate(() => document.getElementById("__quality_start")?.remove());
}

async function keyboardChecks(page, target, viewport) {
  await focusFromTop(page);
  await tab(page);
  await settle(page);
  const skip = await page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLAnchorElement)) return { error: `first Tab lands on <${el?.tagName.toLowerCase() ?? "nothing"}>, not a skip link` };
    const href = el.getAttribute("href") ?? "";
    if (!href.startsWith("#") || !/skip/i.test(el.textContent ?? "")) return { error: `first Tab lands on "${(el.textContent ?? "").trim().slice(0, 40)}" (${href}), not a skip link` };
    const targetEl = document.getElementById(href.slice(1));
    if (!targetEl) return { error: `skip link points at ${href}, which doesn't exist` };
    const box = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (box.bottom <= 0 || box.width < 2 || style.visibility === "hidden" || style.opacity === "0") return { error: "skip link is not visible when focused" };
    return { href };
  });
  if (skip.error) {
    report(target, viewport, "keyboard", skip.error);
  } else {
    await page.keyboard.press("Enter");
    await settle(page);
    // After following the skip link, the next Tab must land inside the target (or on it).
    await page.keyboard.press("Tab");
    const inside = await page.evaluate((href) => {
      const t = document.getElementById(href.slice(1));
      const a = document.activeElement;
      return !!t && !!a && (t === a || t.contains(a) || !!(t.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING));
    }, skip.href);
    if (!inside) report(target, viewport, "keyboard", "after the skip link, Tab doesn't continue in the main content");
  }

  // Walk the Tab order: every stop is visible and shows a focus indicator.
  await focusFromTop(page);
  const seen = new Set();
  for (let i = 0; i < TAB_STOPS; i++) {
    await tab(page);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const box = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const ring =
        (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) ||
        (style.boxShadow && style.boxShadow !== "none");
      const label = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 2).join(".")}` : ""} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 30)}"`;
      // Elements inside an iframe (Razorpay, YouTube) report the frame itself.
      return { label, visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden", ring, inFrame: el.tagName === "IFRAME" };
    });
    if (!stop) break;
    if (seen.has(stop.label)) break; // wrapped around
    seen.add(stop.label);
    if (stop.inFrame) continue;
    if (!stop.visible) report(target, viewport, "focus", `Tab stop ${i + 1} is invisible: ${stop.label}`);
    else if (!stop.ring) report(target, viewport, "focus", `Tab stop ${i + 1} shows no focus ring: ${stop.label}`);
  }
}

// PW_CHANNEL=chrome uses the runner's Google Chrome (no browser download).
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
try {
  for (const viewport of VIEWPORTS) {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const context = await browser.newContext({ viewport, reducedMotion });
      const adminContext = adminCookie ? await browser.newContext({ viewport, reducedMotion, extraHTTPHeaders: { Cookie: adminCookie } }) : null;
      for (const target of PAGES) {
        const ctx = needsAdmin(target) && adminContext ? adminContext : context;
        const page = await ctx.newPage();
        const consoleErrors = [];
        // A state page that answers 4xx on purpose (404, link expired…) logs its own status: not a bug.
        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          if (/^Failed to load resource/.test(msg.text()) && msg.location().url === target.url) return;
          consoleErrors.push(`${msg.text()} (${msg.location().url || "?"})`);
        });
        try {
          await page.goto(target.url, { waitUntil: "networkidle", timeout: 30_000 });
          await settle(page);
          if (reducedMotion === "reduce") {
            // Motion: half a second after load and after scrolling to the end (scroll reveals included),
            // nothing loops and nothing longer than 300 ms is still running.
            await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
            await settle(page);
            await page.waitForTimeout(500);
            const moving = await page.evaluate(() =>
              document
                .getAnimations()
                .filter((a) => {
                  const t = a.effect?.getComputedTiming();
                  return a.playState === "running" && t && (t.duration === Infinity || Number(t.duration) > 300 || t.iterations === Infinity);
                })
                .map((a) => {
                  const el = a.effect && "target" in a.effect ? a.effect.target : null;
                  return `${a.constructor.name} ${"animationName" in a ? a.animationName : "transitionProperty" in a ? a.transitionProperty : ""} on ${el ? el.tagName.toLowerCase() + (el.className ? "." + String(el.className).split(" ")[0] : "") : "?"}`;
                }),
            );
            for (const m of moving) report(target, viewport, "motion", `animates with reduced motion: ${m}`);
            await page.close();
            continue;
          }
          const lang = await page.evaluate(() => document.documentElement.lang);
          if (!lang) report(target, viewport, "language", "<html> has no lang");
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 0) report(target, viewport, "layout", `scrolls sideways by ${overflow}px`);

          await animationsDone(page);
          const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
          for (const v of axe.violations) {
            const nodes = v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ");
            report(target, viewport, `axe ${v.impact ?? ""}`.trim(), `${v.id}: ${v.help} (${v.nodes.length}x: ${nodes})`);
          }
          results.push({ page: target.name, url: target.url, finalUrl: page.url(), viewport: viewport.name, violations: axe.violations.length, passes: axe.passes.length, incomplete: axe.incomplete.map((i) => i.id) });

          await keyboardChecks(page, target, viewport);
          for (const e of consoleErrors) report(target, viewport, "console", e.slice(0, 160));
        } catch (err) {
          report(target, viewport, "load", String(err?.message ?? err).split("\n")[0]);
        } finally {
          if (!page.isClosed()) await page.close();
        }
      }
      await context.close();
      await adminContext?.close();
    }
  }
} finally {
  await browser.close();
}

writeFileSync(path.join(outDir, "a11y.json"), JSON.stringify({ generatedAt: new Date().toISOString(), results, problems }, null, 2));

console.log(`### Accessibility (axe ${TAGS.join(", ")}; keyboard; reduced motion)\n`);
console.log(`${PAGES.length} pages x ${VIEWPORTS.length} widths. ${problems.length} problem(s).\n`);
if (problems.length) {
  console.log("| Page | Width | Check | Problem |\n|---|---|---|---|");
  for (const p of problems) console.log(`| ${p.page} | ${p.viewport} | ${p.kind} | ${p.message.replace(/\|/g, "\\|")} |`);
  process.exitCode = 1;
}
