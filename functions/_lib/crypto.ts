/**
 * Small WebCrypto helpers shared by checkout and enrollment. They run unchanged on Cloudflare's
 * Workers runtime and in Node 22 (scripts/test-checkout.mjs), which both have globalThis.crypto.
 */

const encoder = new TextEncoder();

/** Lowercase hex of HMAC-SHA256(message), keyed with `secret`. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toHex(new Uint8Array(mac));
}

/**
 * Compares two strings in time that depends only on their length, never on where they differ,
 * so a forged signature can't be guessed one character at a time.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  // Different lengths: still walk the longer one so the time doesn't hint at the right length.
  const length = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < length; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** `bytes` random bytes as lowercase hex (2 characters per byte). */
export function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
