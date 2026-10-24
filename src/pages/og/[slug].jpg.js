/**
 * Link-preview pictures (1200×630 JPEG) for every published course, made at build time with sharp:
 * /og/<slug>.jpg. A course page uses its own when the admin set no share image (ogImageUrl).
 *
 * The picture: the studio's logo in white on the maroon band (the brand's one deep colour), with a
 * short sindoor-red rule, beside the course's own photo: the cover of its first glimpse, or for
 * the founder's courses without one her cut-out portrait on blush. No words: WhatsApp, Instagram
 * and X print the page's title and description under the picture, and text drawn here would
 * depend on the build machine's fonts.
 *
 * Plain JavaScript: it runs only in Node at build time, and the Astro project has no Node typings.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { courses } from "../../data/snapshot";
import { site } from "../../data/site";

const W = 1200;
const H = 630;
const PHOTO_W = 520;
// tokens.css: --maroon-800, --rose-100, --red-400 (the accent on deep).
const MAROON = { r: 0x5c, g: 0x0a, b: 0x14 };
const BLUSH = { r: 0xfb, g: 0xec, b: 0xeb };
const RED_ON_DEEP = "#f05750";

const assets = path.join(process.cwd(), "src", "assets");

export function getStaticPaths() {
  return courses.map((course) => ({ params: { slug: course.slug }, props: { course } }));
}

/** The logo's shape, filled white (logo.webp is the mark on transparency). */
/** @param {number} width */
async function whiteLogo(width) {
  const resized = sharp(path.join(assets, "brand", "logo.webp")).resize({ width });
  const { data, info } = await resized.ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const input = await sharp({ create: { width: info.width, height: info.height, channels: 3, background: "#ffffff" } })
    .joinChannel(data, { raw: { width: info.width, height: info.height, channels: 1 } })
    .png()
    .toBuffer();
  return { input, width: info.width, height: info.height };
}

/** @param {import("../../shared/types").PublicCourse} course */
async function photo(course) {
  const glimpse = course.details.glimpses.map((g) => path.join(assets, "glimpses", `${g.youtubeId}.webp`)).find((f) => existsSync(f));
  if (glimpse) {
    return sharp(await readFile(glimpse)).resize({ width: PHOTO_W, height: H, fit: "cover", position: "attention" }).png().toBuffer();
  }
  const panel = sharp({ create: { width: PHOTO_W, height: H, channels: 3, background: BLUSH } });
  if (course.teacher !== site.founder) return panel.png().toBuffer();
  const cutout = await sharp(path.join(assets, "photos", "urmi-mengar.webp")).resize({ height: H - 30 }).png().toBuffer();
  const { width = 0 } = await sharp(cutout).metadata();
  return panel
    .composite([{ input: cutout, left: Math.max(0, Math.round((PHOTO_W - width) / 2)), top: 30 }])
    .png()
    .toBuffer();
}

/** @type {import("astro").APIRoute} */
export const GET = async ({ props }) => {
  const course = props.course;
  const logo = await whiteLogo(420);
  const left = W - PHOTO_W;
  const logoLeft = Math.round((left - logo.width) / 2);
  const logoTop = Math.round((H - logo.height) / 2) - 24;
  const rule = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="8"><rect width="72" height="8" rx="4" fill="${RED_ON_DEEP}"/></svg>`,
  );
  const jpeg = await sharp({ create: { width: W, height: H, channels: 3, background: MAROON } })
    .composite([
      { input: await photo(course), left, top: 0 },
      { input: logo.input, left: logoLeft, top: logoTop },
      { input: rule, left: Math.round((left - 72) / 2), top: logoTop + logo.height + 40 },
    ])
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return new Response(new Uint8Array(jpeg), { headers: { "Content-Type": "image/jpeg" } });
};
