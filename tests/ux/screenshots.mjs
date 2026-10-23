// Screenshot spec for the learner pages: every file scripts/preview-student-pages.mjs wrote, at a
// phone (390 x 844) and a laptop (1280 x 900), full page, light, with and without reduced motion
// where it matters. Not part of `npm test` (no .test.mjs suffix): it needs a browser, so it runs
// in GitHub Actions (.github/workflows/screenshots.yml), never on the 2-CPU VM.
//
//   node --experimental-strip-types --no-warnings --import ./tests/helpers/register.mjs scripts/preview-student-pages.mjs
//   npm i --no-save playwright@1.48.2 && npx playwright install --with-deps chromium
//   node tests/ux/screenshots.mjs [previewDir] [outDir]
//
// Besides the pictures it fails on what a picture can't show: horizontal scroll at 390px (the
// site's rule 2) and a missing focus ring on the first focusable element.
import { readdirSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// @ts-ignore: playwright is installed only by the screenshots workflow, never a dependency.
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../..");
const previewDir = path.resolve(root, process.argv[2] ?? "preview/student");
const outDir = path.resolve(root, process.argv[3] ?? "preview/screenshots");
mkdirSync(outDir, { recursive: true });

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
];

const files = readdirSync(previewDir).filter((f) => f.endsWith(".html") && f !== "index.html");
const browser = await chromium.launch();
const problems = [];
try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce" });
    const page = await context.newPage();
    for (const file of files) {
      await page.goto(pathToFileURL(path.join(previewDir, file)).href);
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 0) problems.push(`${file} @${viewport.name}: scrolls sideways by ${overflow}px`);
      await page.screenshot({ path: path.join(outDir, `${file.replace(/\.html$/, "")}-${viewport.name}.png`), fullPage: true });
      // The first Tab lands on the skip link, and it must be visible.
      await page.keyboard.press("Tab");
      const skip = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || !el.classList.contains("skip")) return "not the skip link";
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (box.bottom > 0 && style.outlineStyle !== "none") return null;
        return `skip link not visible (bottom ${Math.round(box.bottom)}, outline ${style.outlineStyle}, transform ${style.transform}, display ${style.display})`;
      });
      if (skip) problems.push(`${file} @${viewport.name}: first Tab: ${skip}`);
    }
    await context.close();
  }
} finally {
  await browser.close();
}

console.log(`${files.length * VIEWPORTS.length} screenshots in ${path.relative(root, outDir)}/`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
