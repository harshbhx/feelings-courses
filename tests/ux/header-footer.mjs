// The shared header and footer, checked in a real browser and pictured for review. Not part of
// `npm test`: it needs a browser, so it runs in GitHub Actions (.github/workflows/screenshots.yml,
// job header-footer), never on the 2-CPU VM.
//
//   node tests/ux/header-footer.mjs <dist> <studentPreviewDir> <outDir>
//
// Public pages (built from the showcase fixture) at 390, 768 and 1280px:
// - the header at the top and stuck after a scroll: same height, nothing below it moves (layout
//   shift entries and main's position are compared), and it is still on screen;
// - phones and tablets: the menu opens, focus moves into it and stays in the header (Tab and
//   Shift+Tab wrap), the page behind is inert, Escape closes it and focus returns to the button;
//   every control in the header and the menu is at least 44 x 44px; with reduced motion the menu
//   runs no animation;
// - desktop: the navigation shows and the menu button doesn't;
// - axe-core (serious or critical fail) on the header with the menu open and on the footer;
// - pictures of each state, and the footer, for the contact sheets.
// Student pages (scripts/preview-student-pages.mjs output, served over http so the logo mask
// loads): the header and footer at 390 and 1280px, and no sideways scroll.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
// @ts-ignore: playwright and axe-core are installed only by the screenshots workflow.
import { chromium } from "playwright";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "../..");
const dist = path.resolve(root, process.argv[2] ?? "dist");
const student = path.resolve(root, process.argv[3] ?? "preview/student");
const outDir = path.resolve(root, process.argv[4] ?? "preview/header-footer");
const shotsDir = path.join(outDir, "shots");
const sheetsDir = path.join(outDir, "sheets");
mkdirSync(shotsDir, { recursive: true });
mkdirSync(sheetsDir, { recursive: true });

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
};

/** A static server for one folder: /x serves x.html, unknown paths the folder's 404.html. */
async function serve(dir) {
  const resolve = (urlPath) => {
    const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]).replace(/\/+$/, "") || "/";
    const candidates = clean === "/" ? ["index.html"] : [clean.slice(1), `${clean.slice(1)}.html`, `${clean.slice(1)}/index.html`];
    for (const rel of candidates) {
      const file = path.join(dir, rel);
      if (file.startsWith(dir) && existsSync(file) && statSync(file).isFile()) return file;
    }
    return null;
  };
  const server = createServer((req, res) => {
    const file = resolve(req.url ?? "/");
    const fallback = path.join(dir, "404.html");
    if (!file && !existsSync(fallback)) {
      res.writeHead(404).end();
      return;
    }
    const target = file ?? fallback;
    res.writeHead(file ? 200 : 404, { "Content-Type": TYPES[path.extname(target)] ?? "application/octet-stream" });
    res.end(readFileSync(target));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1280", width: 1280, height: 900 },
];
const PUBLIC = [
  { name: "hub", path: "/" },
  { name: "course", path: "/c/selfmakeup" },
  { name: "legal", path: "/legal" },
  { name: "thank-you", path: "/thank-you" },
  { name: "learn", path: "/learn" },
];
const STUDENT = ["account.html", "signin.html", "lesson.html", "certificate.html"];

const axeSource = readFileSync(path.join(root, "node_modules", "axe-core", "axe.min.js"), "utf8");
const problems = [];
const notes = [];
const shot = (name) => path.join(shotsDir, `${name}.png`);
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function settle(page) {
  await page.evaluate(async () => {
    document.querySelectorAll("[data-reveal]").forEach((el) => el.classList.add("is-in"));
    await document.fonts.ready;
  });
  await page.waitForTimeout(150);
}

async function axe(page, include, label) {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: axeSource });
  const result = await page.evaluate(async (sel) => {
    // @ts-ignore: injected above
    const r = await window.axe.run({ include: [sel] }, { resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
  }, include);
  for (const v of result) {
    notes.push(`${label}: [${v.impact}] ${v.id}: ${v.help} (${v.nodes.join(", ")})`);
    if (v.impact === "serious" || v.impact === "critical") problems.push(`${label}: axe ${v.impact} ${v.id}: ${v.help} at ${v.nodes.join(", ")}`);
  }
}

/** Controls that show and are smaller than 44 x 44px. */
const smallTargets = (page, scope) =>
  page.evaluate((sel) => {
    const out = [];
    for (const el of document.querySelectorAll(`${sel} a[href], ${sel} button`)) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || getComputedStyle(el).visibility === "hidden") continue;
      if (box.height < 43.5 || box.width < 43.5) out.push(`${el.textContent?.trim().replace(/\s+/g, " ") || el.getAttribute("aria-label")} (${Math.round(box.width)}x${Math.round(box.height)})`);
    }
    return out;
  }, scope);

const pub = await serve(dist);
const stu = existsSync(student) ? await serve(student) : null;
const browser = await chromium.launch();
try {
  for (const viewport of VIEWPORTS) {
    for (const motion of ["reduce", "no-preference"]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: motion });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (err) => errors.push(err.message));
      // Every layout shift the page reports, from the start.
      await page.addInitScript(() => {
        // @ts-ignore
        window.__shifts = [];
        new PerformanceObserver((list) => {
          // @ts-ignore
          for (const e of list.getEntries()) window.__shifts.push({ value: e.value, recent: e.hadRecentInput });
        }).observe({ type: "layout-shift", buffered: true });
      });

      for (const p of PUBLIC) {
        const label = `${p.name} @${viewport.name}${motion === "reduce" ? "" : " (motion)"}`;
        errors.length = 0;
        await page.goto(pub.origin + p.path, { waitUntil: "networkidle" });
        await settle(page);
        const header = await page.$("header.site-header, header.learn-header");
        if (!header) {
          problems.push(`${label}: no header`);
          continue;
        }
        const isSite = await page.evaluate(() => !!document.querySelector("header.site-header"));
        const tag = motion === "reduce" ? "" : "-motion";

        // At the top.
        await page.evaluate(() => window.scrollTo(0, 0));
        await frames(page);
        const before = await page.evaluate(() => {
          const h = document.querySelector("header.site-header, header.learn-header");
          const main = document.querySelector("main");
          return { h: h.offsetHeight, main: main.getBoundingClientRect().top + window.scrollY };
        });
        if (motion === "reduce") await page.screenshot({ path: shot(`${p.name}-${viewport.name}-top`), clip: { x: 0, y: 0, width: viewport.width, height: 200 } });

        // Scrolled: the header stays, settles, and nothing moves.
        await page.evaluate(() => {
          // @ts-ignore
          window.__shifts.length = 0;
        });
        await page.mouse.wheel(0, 900);
        await page.waitForTimeout(500);
        const after = await page.evaluate(() => {
          const h = document.querySelector("header.site-header, header.learn-header");
          const main = document.querySelector("main");
          const box = h.getBoundingClientRect();
          // @ts-ignore
          const shift = window.__shifts.filter((s) => !s.recent).reduce((sum, s) => sum + s.value, 0);
          return { h: h.offsetHeight, main: main.getBoundingClientRect().top + window.scrollY, top: box.top, bottom: box.bottom, stuck: h.classList.contains("is-stuck"), shift, y: window.scrollY };
        });
        if (after.y > 0) {
          if (after.h !== before.h) problems.push(`${label}: header height changed on scroll (${before.h} → ${after.h})`);
          if (Math.abs(after.main - before.main) > 0.5) problems.push(`${label}: main moved on scroll (${before.main} → ${after.main})`);
          if (after.shift > 0.005) problems.push(`${label}: layout shift ${after.shift.toFixed(4)} while scrolling`);
          if (after.bottom <= 0 || after.top < -12) problems.push(`${label}: header not on screen after scrolling (top ${after.top}, bottom ${after.bottom})`);
          if (isSite && !after.stuck) problems.push(`${label}: header not marked stuck after scrolling`);
          if (motion === "reduce") await page.screenshot({ path: shot(`${p.name}-${viewport.name}-scrolled`), clip: { x: 0, y: 0, width: viewport.width, height: 200 } });
        }
        const small = await smallTargets(page, "header");
        if (small.length) problems.push(`${label}: header targets under 44px: ${small.join(", ")}`);

        if (isSite) {
          const desktop = viewport.width >= 1024;
          const visible = await page.evaluate(() => ({
            nav: getComputedStyle(document.querySelector(".site-header .nav")).display !== "none",
            toggle: getComputedStyle(document.querySelector("[data-menu-toggle]")).display !== "none",
          }));
          if (desktop && (!visible.nav || visible.toggle)) problems.push(`${label}: desktop shows the menu button or hides the navigation`);
          if (!desktop && (visible.nav || !visible.toggle)) problems.push(`${label}: phone/tablet shows the navigation or hides the menu button`);

          if (!desktop) {
            // The menu: open, focus inside, trapped, inert page, Escape.
            await page.click("[data-menu-toggle]");
            await page.waitForTimeout(motion === "reduce" ? 100 : 600);
            const open = await page.evaluate(() => {
              const panel = document.querySelector("[data-menu-panel]");
              const toggle = document.querySelector("[data-menu-toggle]");
              const box = panel.getBoundingClientRect();
              return {
                shown: !panel.hidden && box.height > 0,
                expanded: toggle.getAttribute("aria-expanded"),
                focusInside: panel.contains(document.activeElement),
                inert: document.querySelector("main").inert,
                running: document.getAnimations().filter((a) => a.playState === "running" && panel.contains(a.effect?.target ?? null)).length,
                fits: box.right <= window.innerWidth + 0.5,
                sideways: document.documentElement.scrollWidth - window.innerWidth,
              };
            });
            if (!open.shown) problems.push(`${label}: the menu didn't open`);
            if (open.expanded !== "true") problems.push(`${label}: aria-expanded is ${open.expanded} with the menu open`);
            if (!open.focusInside) problems.push(`${label}: focus didn't move into the menu`);
            if (!open.inert) problems.push(`${label}: the page behind the menu isn't inert`);
            if (!open.fits || open.sideways > 0) problems.push(`${label}: the open menu doesn't fit the screen`);
            if (motion === "reduce" && open.running) problems.push(`${label}: ${open.running} animations run in the menu with reduced motion`);
            const smallMenu = await smallTargets(page, "[data-menu-panel]");
            if (smallMenu.length) problems.push(`${label}: menu targets under 44px: ${smallMenu.join(", ")}`);
            if (motion === "reduce") {
              await page.screenshot({ path: shot(`${p.name}-${viewport.name}-menu`) });
              if (p.name === "hub") await axe(page, "header.site-header", `${label} menu open`);
            }

            // Tab and Shift+Tab stay inside the header.
            let escaped = null;
            for (const [key, times] of [["Tab", 14], ["Shift+Tab", 18]]) {
              for (let i = 0; i < times; i++) {
                await page.keyboard.press(key);
                const inside = await page.evaluate(() => !!document.activeElement?.closest("header.site-header"));
                if (!inside) {
                  escaped = await page.evaluate(() => `${document.activeElement?.tagName.toLowerCase()}.${document.activeElement?.className}`);
                  break;
                }
              }
              if (escaped) break;
            }
            if (escaped) problems.push(`${label}: focus left the open menu (to ${escaped})`);

            await page.keyboard.press("Escape");
            await frames(page);
            const closed = await page.evaluate(() => ({
              hidden: document.querySelector("[data-menu-panel]").hidden,
              focusOnToggle: document.activeElement === document.querySelector("[data-menu-toggle]"),
              inert: document.querySelector("main").inert,
              expanded: document.querySelector("[data-menu-toggle]").getAttribute("aria-expanded"),
            }));
            if (!closed.hidden || closed.expanded !== "false") problems.push(`${label}: Escape didn't close the menu`);
            if (!closed.focusOnToggle) problems.push(`${label}: focus didn't return to the menu button after Escape`);
            if (closed.inert) problems.push(`${label}: the page stayed inert after closing the menu`);
          }
        }

        // The footer.
        const footer = await page.$("footer.site-footer");
        if (footer) {
          await footer.scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
          if (motion === "reduce") {
            // The sticky header would sit over the top of the footer in the picture.
            await page.addStyleTag({ content: "header.site-header, header.learn-header { visibility: hidden !important; }" });
            await footer.screenshot({ path: shot(`${p.name}-${viewport.name}-footer${tag}`) });
            if (viewport.name === "390") await axe(page, "footer.site-footer", `${label} footer`);
          }
          const smallFoot = await smallTargets(page, "footer.site-footer");
          if (smallFoot.length) problems.push(`${label}: footer targets under 44px: ${smallFoot.join(", ")}`);
        } else problems.push(`${label}: no footer`);

        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (sideways > 0) problems.push(`${label}: scrolls sideways by ${sideways}px`);
        if (errors.length) problems.push(`${label}: script error: ${errors.join("; ")}`);
      }
      await context.close();
    }
  }

  // Student pages (Functions output).
  if (stu) {
    for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
      const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce" });
      const page = await context.newPage();
      for (const file of STUDENT) {
        const name = `student-${file.replace(/\.html$/, "")}`;
        await page.goto(`${stu.origin}/${file}`, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const header = await page.$("header.top");
        if (header) await header.screenshot({ path: shot(`${name}-${viewport.name}-header`) });
        const footer = await page.$("footer.foot");
        if (footer) await footer.screenshot({ path: shot(`${name}-${viewport.name}-footer`) });
        const logo = await page.evaluate(() => {
          const el = document.querySelector("header.top .brand-logo");
          return el ? el.getBoundingClientRect().width : 0;
        });
        if (logo < 80) problems.push(`${name} @${viewport.name}: logo missing or too small (${logo}px)`);
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (sideways > 0) problems.push(`${name} @${viewport.name}: scrolls sideways by ${sideways}px`);
        const small = await smallTargets(page, "header.top");
        if (small.length) problems.push(`${name} @${viewport.name}: header targets under 44px: ${small.join(", ")}`);
        if (viewport.name === "390" && file === "account.html") await axe(page, "body", `${name} @390`);
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
  pub.server.close();
  stu?.server.close();
}

// ---------------------------------------------------------------- contact sheets (JPEG, < 1.5 MB)

const MAX_BYTES = 1.5 * 1024 * 1024;
const BG = { r: 250, g: 246, b: 243 };

/** Images stacked in rows of `perRow`, each scaled to `colWidth`, captioned, as one JPEG under 1.5 MB. */
async function sheet(names, colWidth, perRow, out) {
  if (names.length === 0) return;
  const gap = 24;
  const label = 40;
  const tiles = [];
  for (const name of names) {
    const buf = await sharp(path.join(shotsDir, name)).resize({ width: colWidth }).png().toBuffer();
    const meta = await sharp(buf).metadata();
    tiles.push({ name: name.replace(/\.png$/, ""), buf, height: meta.height ?? 0 });
  }
  const rows = [];
  for (let i = 0; i < tiles.length; i += perRow) rows.push(tiles.slice(i, i + perRow));
  const width = gap + perRow * (colWidth + gap);
  let y = gap;
  const composite = [];
  for (const row of rows) {
    const rowH = Math.max(...row.map((t) => t.height));
    const captions = row
      .map((t, i) => `<text x="${gap + i * (colWidth + gap)}" y="28" font-family="sans-serif" font-size="22" fill="#5b2333">${t.name}</text>`)
      .join("");
    composite.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${label}">${captions}</svg>`), left: 0, top: y });
    row.forEach((t, i) => composite.push({ input: t.buf, left: gap + i * (colWidth + gap), top: y + label }));
    y += label + rowH + gap;
  }
  const png = await sharp({ create: { width, height: y, channels: 3, background: BG } }).composite(composite).png().toBuffer();
  for (const quality of [80, 70, 60, 50, 40]) {
    await sharp(png).jpeg({ quality, mozjpeg: true }).toFile(out);
    if (statSync(out).size <= MAX_BYTES) return;
  }
  const half = await sharp(png).resize({ width: Math.round(width / 2) }).png().toBuffer();
  await sharp(half).jpeg({ quality: 70, mozjpeg: true }).toFile(out);
}

const all = readdirSync(shotsDir).filter((f) => f.endsWith(".png")).sort();
const pick = (re) => all.filter((f) => re.test(f));
await sheet(pick(/^(hub|course|learn)-390-(top|scrolled)\.png$/), 390, 2, path.join(sheetsDir, "1-header-phone.jpg"));
await sheet(pick(/-390-menu\.png$/), 390, 4, path.join(sheetsDir, "2-menu-phone.jpg"));
await sheet(pick(/^(hub|course|learn)-768-(top|scrolled|menu)\.png$/), 768, 3, path.join(sheetsDir, "3-tablet.jpg"));
await sheet(pick(/^(hub|course|legal|learn)-1280-(top|scrolled)\.png$/), 1280, 2, path.join(sheetsDir, "4-header-desktop.jpg"));
await sheet(pick(/^(hub|thank-you|learn)-390-footer\.png$/), 390, 3, path.join(sheetsDir, "5-footer-phone.jpg"));
await sheet(pick(/^(hub|thank-you)-(768|1280)-footer\.png$/), 1024, 1, path.join(sheetsDir, "6-footer-desktop.jpg"));
await sheet(pick(/^student-.*-390-(header|footer)\.png$/), 390, 4, path.join(sheetsDir, "7-student-phone.jpg"));
await sheet(pick(/^student-.*-1280-(header|footer)\.png$/), 1280, 2, path.join(sheetsDir, "8-student-desktop.jpg"));

writeFileSync(path.join(outDir, "a11y.txt"), notes.length ? notes.join("\n") + "\n" : "No axe-core findings.\n");
console.log(`header-footer: ${all.length} pictures, sheets: ${readdirSync(sheetsDir).join(", ")}; axe findings: ${notes.length}`);
if (problems.length) {
  console.error(problems.join("\n"));
  process.exitCode = 1;
}
