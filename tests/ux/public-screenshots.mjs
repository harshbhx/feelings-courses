// Screenshots of the public site (hub catalog, the three course formats, the empty hub, 404,
// thank-you and payment-failed) at a phone (390 x 844) and a laptop (1280 x 900), plus the states a
// full-page picture can't show: the phone's sticky enroll bar mid-page, the checkout sheet, an open
// FAQ and the curriculum accordion. Not part of `npm test`: it needs a browser, so it runs in
// GitHub Actions (.github/workflows/screenshots.yml), never on the 2-CPU VM.
//
//   node tests/ux/public-screenshots.mjs <dist> <outDir> <set>      set: showcase | empty
//
// It also fails on what a picture can't show: sideways scroll at 390px (rule 2), a skip link that
// stays hidden on the first Tab, and axe-core's serious or critical accessibility findings.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
// @ts-ignore: playwright and axe-core are installed only by the screenshots workflow.
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.resolve(root, process.argv[2] ?? "dist");
const outDir = path.resolve(root, process.argv[3] ?? "preview/public");
const set = process.argv[4] ?? "showcase";
mkdirSync(outDir, { recursive: true });

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".xml": "application/xml",
};

/** Cloudflare Pages' static rules, enough for these pages: /x serves x.html, unknown paths 404.html. */
function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]).replace(/\/+$/, "") || "/";
  const candidates = clean === "/" ? ["index.html"] : [clean.slice(1), `${clean.slice(1)}.html`, `${clean.slice(1)}/index.html`];
  for (const rel of candidates) {
    const file = path.join(dist, rel);
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) return file;
  }
  return null;
}

const server = createServer((req, res) => {
  const file = resolveFile(req.url ?? "/");
  const status = file ? 200 : 404;
  const target = file ?? path.join(dist, "404.html");
  res.writeHead(status, { "Content-Type": TYPES[path.extname(target)] ?? "application/octet-stream" });
  res.end(readFileSync(target));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1280", width: 1280, height: 900 },
];

const PAGES =
  set === "empty"
    ? [{ name: "hub-empty", path: "/" }]
    : [
        { name: "hub", path: "/" },
        { name: "online", path: "/c/selfmakeup" },
        { name: "studio", path: "/c/studio-basics" },
        { name: "hybrid", path: "/c/bridal" },
        { name: "404", path: "/no-such-page" },
        { name: "thank-you", path: "/thank-you" },
        { name: "payment-failed", path: "/payment-failed" },
      ];

const axeSource = readFileSync(path.join(root, "node_modules", "axe-core", "axe.min.js"), "utf8");
const problems = [];
const a11y = [];

/** Shows every scroll-revealed block and waits for fonts and images, so a full-page shot is complete. */
async function settle(page) {
  await page.evaluate(async () => {
    document.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("is-in"));
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => (img.loading = "eager"));
    await document.fonts.ready;
    const pending = Array.from(document.images)
      .filter((img) => !img.complete)
      .map(
        (img) =>
          new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          }),
      );
    await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, 5000))]);
  });
  await page.waitForTimeout(150);
}

const shot = (name) => path.join(outDir, `${name}.png`);

const browser = await chromium.launch();
try {
  for (const viewport of VIEWPORTS) {
    for (const motion of ["reduce", "no-preference"]) {
      // Full pages are shot with reduced motion (final states); the motion pass only checks for errors.
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: motion });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(err.message));
      for (const p of PAGES) {
        errors.length = 0;
        const res = await page.goto(origin + p.path, { waitUntil: "networkidle" });
        if (p.name !== "404" && res && res.status() !== 200) problems.push(`${p.name}: HTTP ${res.status()}`);
        await settle(page);
        if (errors.length) problems.push(`${p.name} @${viewport.name} (${motion}): script error: ${errors.join("; ")}`);
        if (motion !== "reduce") continue;

        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 0) problems.push(`${p.name} @${viewport.name}: scrolls sideways by ${overflow}px`);
        await page.screenshot({ path: shot(`${p.name}-${viewport.name}`), fullPage: true });

        // Accessibility: axe-core on the rendered page (once per page, at the phone width).
        if (viewport.name === "390") {
          await page.addScriptTag({ content: axeSource });
          const result = await page.evaluate(async () => {
            // @ts-ignore: injected above
            const r = await window.axe.run(document, { resultTypes: ["violations"] });
            return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
          });
          for (const v of result) {
            a11y.push(`${p.name}: [${v.impact}] ${v.id}: ${v.help} (${v.nodes.join(", ")})`);
            if (v.impact === "serious" || v.impact === "critical") problems.push(`${p.name}: axe ${v.impact} ${v.id}: ${v.help} at ${v.nodes.join(", ")}`);
          }
        }

        // The first Tab lands on the skip link, and it shows.
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.keyboard.press("Tab");
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const skip = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || !el.classList.contains("skip-link")) return `first Tab went to ${el?.tagName.toLowerCase()}.${el?.className}`;
          const box = el.getBoundingClientRect();
          return box.bottom > 0 && box.top < window.innerHeight ? null : "skip link not visible";
        });
        if (skip) problems.push(`${p.name} @${viewport.name}: ${skip}`);
      }
      await context.close();
    }
  }

  if (set === "showcase") {
    // States on the phone: the sticky bar mid-page, the curriculum and FAQ opened, the checkout sheet.
    const context = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: 2, reducedMotion: "reduce" });
    const page = await context.newPage();
    for (const p of ["online", "studio", "hybrid"]) {
      const target = { online: "/c/selfmakeup", studio: "/c/studio-basics", hybrid: "/c/bridal" }[p];
      await page.goto(origin + target, { waitUntil: "networkidle" });
      await settle(page);
      // Scroll in steps so the bar's IntersectionObserver sees the hero leave.
      for (const sel of ["#learn", "#curriculum", "#batches", "#faq"]) {
        const el = await page.$(sel);
        if (!el) continue;
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(250);
        const bar = await page.evaluate(() => document.querySelector("[data-enroll-bar]")?.classList.contains("is-shown") ?? false);
        if (bar) {
          await page.screenshot({ path: shot(`${p}-390-bar`) });
          break;
        }
      }
      const faq = await page.$("#faq details:not([open]) summary");
      if (faq) {
        await faq.click();
        await page.waitForTimeout(200);
        await (await page.$("#faq"))?.screenshot({ path: shot(`${p}-390-faq`) });
      }
      const mod = await page.$("#curriculum details:not([open]) summary");
      if (mod) {
        await mod.click();
        await page.waitForTimeout(200);
        await (await page.$("#curriculum"))?.screenshot({ path: shot(`${p}-390-curriculum`) });
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      const enroll = await page.$(".hero [data-enroll]");
      if (enroll) {
        await enroll.click();
        await page.waitForTimeout(400);
        const open = await page.evaluate(() => !!document.querySelector("dialog[open]"));
        if (open) await page.screenshot({ path: shot(`${p}-390-checkout`) });
        else problems.push(`${p}: the hero's enroll button didn't open the checkout`);
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}

writeFileSync(path.join(outDir, `a11y-${set}.txt`), a11y.length ? a11y.join("\n") + "\n" : "No axe-core findings.\n");
console.log(`${set}: screenshots in ${path.relative(root, outDir)}/; axe findings: ${a11y.length}`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
}
