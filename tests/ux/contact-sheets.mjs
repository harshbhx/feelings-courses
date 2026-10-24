// Contact sheets from the public screenshots: a few JPEGs a person can flip through on a phone,
// each under 1.5 MB. Uses sharp (already a dependency for Astro's images).
//
//   node tests/ux/contact-sheets.mjs [shotsDir] [outDir]
//
// Sheets:
// - phone-pages.jpg: every full page at 390px, side by side, scaled down;
// - phone-states.jpg: the sticky bar, open FAQ and curriculum, and the checkout sheet;
// - desktop-<page>.jpg: each full page at 1280px.
import { readdirSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve(import.meta.dirname, "../..");
const shotsDir = path.resolve(root, process.argv[2] ?? "preview/public");
const outDir = path.resolve(root, process.argv[3] ?? "preview/sheets");
mkdirSync(outDir, { recursive: true });

const MAX_BYTES = 1.5 * 1024 * 1024;
const BG = { r: 250, g: 246, b: 243 };
const files = readdirSync(shotsDir).filter((f) => f.endsWith(".png"));

const ORDER = ["hub", "hub-empty", "online", "studio", "hybrid", "404", "thank-you", "payment-failed"];
const rank = (f) => {
  const i = ORDER.findIndex((n) => f.startsWith(`${n}-`));
  return i < 0 ? ORDER.length : i;
};

/** A row of images scaled to `colWidth`, captions on top, written as JPEG under MAX_BYTES. */
async function sheet(names, colWidth, out, maxHeight = 7000) {
  if (names.length === 0) return;
  const gap = 24;
  const label = 44;
  const tiles = [];
  for (const name of names) {
    const img = sharp(path.join(shotsDir, name)).resize({ width: colWidth });
    const buf = await img.png().toBuffer();
    const meta = await sharp(buf).metadata();
    const height = Math.min(meta.height ?? 0, maxHeight);
    tiles.push({ name, buf: await sharp(buf).extract({ left: 0, top: 0, width: colWidth, height }).png().toBuffer(), height });
  }
  const width = gap + names.length * (colWidth + gap);
  const height = label + gap + Math.max(...tiles.map((t) => t.height)) + gap;
  const captions = tiles
    .map((t, i) => `<text x="${gap + i * (colWidth + gap)}" y="${label - 12}" font-family="sans-serif" font-size="22" fill="#5b2333">${t.name.replace(/\.png$/, "")}</text>`)
    .join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${label}">${captions}</svg>`);
  const composite = [{ input: svg, left: 0, top: 0 }, ...tiles.map((t, i) => ({ input: t.buf, left: gap + i * (colWidth + gap), top: label + gap }))];
  const base = sharp({ create: { width, height, channels: 3, background: BG } }).composite(composite);
  const png = await base.png().toBuffer();
  for (const quality of [82, 72, 62, 52, 42]) {
    await sharp(png).jpeg({ quality, mozjpeg: true }).toFile(out);
    if (statSync(out).size <= MAX_BYTES) return;
  }
  // Still too big: halve the size.
  const half = await sharp(png).resize({ width: Math.round(width / 2) }).png().toBuffer();
  await sharp(half).jpeg({ quality: 70, mozjpeg: true }).toFile(out);
}

const phonePages = files.filter((f) => /-390\.png$/.test(f)).sort((a, b) => rank(a) - rank(b));
const phoneStates = files.filter((f) => /-390-(bar|faq|curriculum|checkout)\.png$/.test(f)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
const desktop = files.filter((f) => /-1280\.png$/.test(f)).sort((a, b) => rank(a) - rank(b));

// Phone pages in groups of four, so each sheet stays readable.
for (let i = 0; i < phonePages.length; i += 4) {
  await sheet(phonePages.slice(i, i + 4), 360, path.join(outDir, `phone-pages-${i / 4 + 1}.jpg`), 9000);
}
for (let i = 0; i < phoneStates.length; i += 4) {
  await sheet(phoneStates.slice(i, i + 4), 390, path.join(outDir, `phone-states-${i / 4 + 1}.jpg`));
}
for (const f of desktop) await sheet([f], 1100, path.join(outDir, `desktop-${f.replace(/-1280\.png$/, "")}.jpg`), 9000);

console.log(`contact sheets in ${path.relative(root, outDir)}/: ${readdirSync(outDir).join(", ")}`);
