/**
 * Course covers in the browser. Glimpse covers are referenced by YouTube id; the page carries a
 * map from id to image URL (CoverData.astro), built at build time from src/assets/glimpses.
 */
import type { Cover } from "../../../lib/demo-store";

export interface GlimpseCover {
  id: string;
  label: string;
  src: string;
  /** Responsive sizes (glimpse-covers.ts); empty when there is no local copy. */
  srcset?: string;
}

let map: Record<string, GlimpseCover> | null = null;

export function glimpseCovers(): Record<string, GlimpseCover> {
  if (map) return map;
  map = {};
  try {
    const el = document.getElementById("cover-data");
    if (el?.textContent) map = JSON.parse(el.textContent) as Record<string, GlimpseCover>;
  } catch {
    /* no map: covers fall back to YouTube's own thumbnail below */
  }
  return map;
}

/** The image URL, its responsive sizes when there are any, and alt text for a course cover. */
export function coverImage(cover: Cover, title: string): { src: string; alt: string; srcset?: string } {
  if (cover.kind === "upload") return { src: cover.dataUrl, alt: `Cover photo for ${title}` };
  const g = glimpseCovers()[cover.id];
  if (g) return { src: g.src, alt: g.label, srcset: g.srcset || undefined };
  return { src: `https://i.ytimg.com/vi/${encodeURIComponent(cover.id)}/hqdefault.jpg`, alt: `Cover for ${title}` };
}
