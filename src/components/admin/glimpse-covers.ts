/**
 * Build time: the glimpse clips from course.ts as course covers, for the admin's cover picker and
 * for courses rendered in the browser (catalog, /course). A local copy in src/assets/glimpses
 * (720×1280) is resized to a light WebP; a clip without one falls back to YouTube's thumbnail.
 */
import { getImage } from "astro:assets";
import type { ImageMetadata } from "astro";
import { course } from "../../data/course";

const files = import.meta.glob<{ default: ImageMetadata }>("../../assets/glimpses/*.{webp,jpg,jpeg,png}", { eager: true });
const local = new Map(Object.entries(files).map(([file, mod]) => [file.split("/").pop()!.replace(/\.\w+$/, ""), mod.default]));

export interface GlimpseCover {
  id: string;
  label: string;
  src: string;
  /** Responsive sizes for an <img srcset> (local copies only; empty for YouTube's thumbnail). */
  srcset: string;
}

/** Widths of the responsive set: a phone card, a tablet or desktop card, and either at 2x. */
const SRCSET_WIDTHS = [320, 480, 720];

export async function getGlimpseCovers(width = 480): Promise<GlimpseCover[]> {
  return Promise.all(
    course.glimpses.map(async (g) => {
      const img = local.get(g.id);
      if (!img) return { id: g.id, label: g.label, src: `https://i.ytimg.com/vi/${encodeURIComponent(g.id)}/oardefault.jpg`, srcset: "" };
      const [one, set] = await Promise.all([
        getImage({ src: img, width, format: "webp", quality: 72 }),
        getImage({ src: img, widths: SRCSET_WIDTHS.filter((w) => w <= img.width), format: "webp", quality: 72 }),
      ]);
      return { id: g.id, label: g.label, src: one.src, srcset: set.srcSet.attribute };
    }),
  );
}
