/**
 * WebCrypto helpers shared by checkout, sessions, media signing and the admin. They run unchanged
 * on Cloudflare's Workers runtime and in Node 22 (the tests), which both have globalThis.crypto.
 *
 * Merged from the demo's checkout helpers and the recovered data-layer crypto (plan W0). Frozen
 * after W0: add a helper through a contract PR, never change one in place.
 */

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Lowercase hex SHA-256 of a string (64 characters). Session and token hashes use this. */
export async function sha256Hex(value: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

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

/** A random token: `bytes` random bytes, base64url without padding (32 bytes = 43 characters). */
export function randomToken(bytes = 32): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A random numeric code of `digits` digits, uniformly distributed (rejection sampling). */
export function randomDigits(digits = 6): string {
  const limit = 10 ** digits;
  // Largest multiple of `limit` below 2^32, so every code is equally likely.
  const ceiling = Math.floor(0x1_0000_0000 / limit) * limit;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    if (buffer[0]! < ceiling) return String(buffer[0]! % limit).padStart(digits, "0");
  }
}

/** Crockford base32 alphabet (no I, L, O, U). Certificate codes use it. */
export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** `length` random Crockford base32 characters (uniform: 256 is a multiple of 32). */
export function randomCrockford(length = 10): string {
  const raw = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of raw) out += CROCKFORD[byte % 32];
  return out;
}
