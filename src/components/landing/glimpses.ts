/**
 * Posters and player URLs for the vertical clips in `course.glimpses`.
 *
 * Posters: a local copy of a clip's cover lives in src/assets/glimpses/<youtube id>.webp (720×1280,
 * the cover YouTube shows for the Short). Astro builds small AVIF and WebP sizes from it, so the
 * page asks YouTube for nothing until a clip is tapped, and the hero's cover is a fast, same-origin
 * image. A clip without a local copy falls back to YouTube's own thumbnails (i.ytimg.com), best
 * first; Reel.astro's script steps down the list when one is missing.
 *
 * Player: youtube-nocookie (privacy-enhanced), created only when the visitor taps a clip; see
 * player.ts.
 */
import type { ImageMetadata } from "astro";

const files = import.meta.glob<{ default: ImageMetadata }>("../../assets/glimpses/*.{webp,jpg,jpeg,png}", { eager: true });

const local = new Map<string, ImageMetadata>(
  Object.entries(files).map(([file, mod]) => [file.split("/").pop()!.replace(/\.\w+$/, ""), mod.default]),
);

/** The local cover for a YouTube id, if one was added to src/assets/glimpses. */
export function localPoster(id: string): ImageMetadata | undefined {
  return local.get(id);
}

/**
 * YouTube's thumbnails for a Short, best first (checked on the main site, docs/05):
 * oardefault is the 1080×1920 cover; oar2 an automatic frame; hqdefault (480×360, the Short in its
 * middle between blurred bars) always exists. A missing size answers with a 120×90 grey image.
 */
export function remotePosters(id: string): string[] {
  const v = encodeURIComponent(id);
  return [
    `https://i.ytimg.com/vi_webp/${v}/oardefault.webp`,
    `https://i.ytimg.com/vi/${v}/oardefault.jpg`,
    `https://i.ytimg.com/vi/${v}/oar2.jpg`,
    `https://i.ytimg.com/vi/${v}/hqdefault.jpg`,
  ];
}
