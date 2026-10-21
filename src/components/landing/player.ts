/**
 * The privacy-enhanced YouTube player, loaded only after a tap. Kept apart from glimpses.ts (which
 * globs the poster images) so the browser bundle that imports it stays a few bytes.
 */
export function embedUrl(id: string): string {
  const params = new URLSearchParams({ autoplay: "1", playsinline: "1", rel: "0", modestbranding: "1" });
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params}`;
}
