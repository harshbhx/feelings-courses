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
}

export async function getGlimpseCovers(width = 480): Promise<GlimpseCover[]> {
  return Promise.all(
    course.glimpses.map(async (g) => {
      const img = local.get(g.id);
      const src = img
        ? (await getImage({ src: img, width, format: "webp", quality: 72 })).src
        : `https://i.ytimg.com/vi/${encodeURIComponent(g.id)}/oardefault.jpg`;
      return { id: g.id, label: g.label, src };
    }),
  );
}
