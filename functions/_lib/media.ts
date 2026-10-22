/**
 * Signed media URLs (plan 1.6). STUB: signature frozen by W0, body by W4.
 *
 *   /media/<kind>/<lessonId>?e=<exp>&s=<sidTag>&sig=<hmac>
 *   sig = HMAC-SHA256(APP_SECRET, "<kind>|<lessonId>|<exp>|<sidTag>")
 * kind "v" = video, "c" = captions. sidTag = first 16 hex of the session's tokenHash, or "public"
 * for free previews. ttl defaults to config.ts MEDIA_URL_TTL (2 h).
 */
import type { Env } from "./env.ts";
import { notImplemented } from "./stub.ts";

export async function signMediaUrl(
  env: Env,
  input: { kind: "v" | "c"; lessonId: number; sessionTag: string; ttl?: number },
): Promise<string> {
  return notImplemented("signMediaUrl", "W4");
}
