/**
 * Input checks shared by the data-access functions. Each one returns the tidy value or throws a
 * ValidationError naming the field. Inputs come from requests, so nothing trusts TypeScript types.
 */
import { ValidationError } from "./errors.ts";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Control characters, except tab and newline in multi-line text.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const CONTROL_SINGLE_LINE = /[\u0000-\u001F\u007F]/;
/** Latest timestamp accepted: 9999-12-31. */
const MAX_TIMESTAMP = 253_402_300_799;

export function isMissing(value: unknown): value is null | undefined {
  return value === undefined || value === null;
}

/** A positive whole number id. */
export function id(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ValidationError(field, `${field} must be a positive whole number.`);
  }
  return value;
}

/** A whole number in [min, max]. */
export function int(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(field, `${field} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

export function optionalInt(value: unknown, field: string, min: number, max: number): number | null {
  return isMissing(value) ? null : int(value, field, min, max);
}

/** Unix seconds. */
export function timestamp(value: unknown, field: string): number {
  return int(value, field, 0, MAX_TIMESTAMP);
}

export function optionalTimestamp(value: unknown, field: string): number | null {
  return isMissing(value) ? null : timestamp(value, field);
}

/** The `now` a caller passed (tests do), or the clock. */
export function now(value: unknown): number {
  return isMissing(value) ? Math.floor(Date.now() / 1000) : timestamp(value, "now");
}

/** Money in paise, a whole number in [min, max]. */
export function paise(value: unknown, field: string, min = 0, max = 100_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(field, `${field} must be a whole number of paise from ${min} to ${max}.`);
  }
  return value;
}

export interface TextRules {
  min?: number;
  max: number;
  /** Keeps line breaks (descriptions, notes). Single-line text has its whitespace collapsed. */
  multiline?: boolean;
}

/** Required text, normalised (NFC, trimmed). */
export function text(value: unknown, field: string, rules: TextRules): string {
  const tidy = optionalText(value, field, rules);
  if (tidy === null) throw new ValidationError(field, `${field} is required.`, "required");
  return tidy;
}

/** Optional text: undefined, null and blank all become null. */
export function optionalText(value: unknown, field: string, rules: TextRules): string | null {
  if (isMissing(value)) return null;
  if (typeof value !== "string") throw new ValidationError(field, `${field} must be text.`);
  let tidy = value.normalize("NFC");
  tidy = rules.multiline
    ? tidy.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim()
    : tidy.replace(/\s+/g, " ").trim();
  if (tidy === "") return null;
  if ((rules.multiline ? CONTROL : CONTROL_SINGLE_LINE).test(tidy)) {
    throw new ValidationError(field, `${field} contains characters that aren't allowed.`);
  }
  const min = rules.min ?? 1;
  if (tidy.length < min || tidy.length > rules.max) {
    throw new ValidationError(field, `${field} must be ${min} to ${rules.max} characters.`);
  }
  return tidy;
}

/** A URL slug: lowercase letters and digits joined by single hyphens, up to 80 characters. */
export function slug(value: unknown, field = "slug"): string {
  if (typeof value !== "string") throw new ValidationError(field, `${field} must be text.`);
  const tidy = value.trim().toLowerCase();
  if (tidy.length < 1 || tidy.length > 80 || !SLUG.test(tidy)) {
    throw new ValidationError(field, `${field} must be lowercase words joined by hyphens, like "soft-glam".`);
  }
  return tidy;
}

/** One of a fixed set of strings. */
export function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(field, `${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

/** A yes/no flag, stored as 0 or 1. */
export function flag(value: unknown, field: string): 0 | 1 {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new ValidationError(field, `${field} must be true or false.`);
}

/**
 * A phone number as E.164. Indian mobiles may be typed as 10 digits, with 0, 91 or +91 in front;
 * other countries need + and the country code. Same rule as checkout's normalisePhone().
 */
export function phone(value: unknown, field = "phone"): string {
  if (typeof value !== "string") throw new ValidationError(field, `${field} must be text.`);
  const compact = value.replace(/[\s().-]/g, "");
  const indian = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(compact);
  if (indian) return `+91${indian[1]}`;
  if (/^\+[1-9]\d{7,14}$/.test(compact) && !compact.startsWith("+91")) return compact;
  throw new ValidationError(field, "Enter a 10-digit mobile number, or an international number starting with +.");
}

export function optionalPhone(value: unknown, field = "phone"): string | null {
  if (isMissing(value) || (typeof value === "string" && value.trim() === "")) return null;
  return phone(value, field);
}

/** An email address, trimmed and lowercased (so it is unique however it was typed). */
export function email(value: unknown, field = "email"): string {
  if (typeof value !== "string") throw new ValidationError(field, `${field} must be text.`);
  const tidy = value.trim().toLowerCase();
  if (tidy.length > 254 || !/^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/.test(tidy)) {
    throw new ValidationError(field, "Enter an email like name@example.com.");
  }
  return tidy;
}

export function optionalEmail(value: unknown, field = "email"): string | null {
  if (isMissing(value) || (typeof value === "string" && value.trim() === "")) return null;
  return email(value, field);
}

/** A coupon code: trimmed and uppercased, 3 to 32 of A-Z, 0-9, "_" and "-". */
export function couponCode(value: unknown, field = "code"): string {
  if (typeof value !== "string") throw new ValidationError(field, `${field} must be text.`);
  const tidy = value.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(tidy)) {
    throw new ValidationError(field, "A coupon code is 3 to 32 letters, digits, hyphens or underscores.");
  }
  return tidy;
}

/** A Razorpay id such as order_... or pay_... (letters, digits and underscores). */
export function razorpayId(value: unknown, field: string, prefix?: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(value) || (prefix && !value.startsWith(prefix))) {
    throw new ValidationError(field, `${field} is not a valid Razorpay id.`);
  }
  return value;
}

/** Who did something, for the audit log: "admin", "student:12", "razorpay", "system". */
export function actor(value: unknown): string {
  if (isMissing(value)) return "system";
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:@+-]{1,120}$/.test(value)) {
    throw new ValidationError("actor", "actor must be 1 to 120 letters, digits or _.:@+-");
  }
  return value;
}

/** Page size and offset for lists. */
export function page(limit: unknown, offset: unknown, defaultLimit = 25): { limit: number; offset: number } {
  return {
    limit: isMissing(limit) ? defaultLimit : int(limit, "limit", 1, 100),
    offset: isMissing(offset) ? 0 : int(offset, "offset", 0, 1_000_000),
  };
}

/** A search term as a LIKE pattern ("%term%", with % _ and \ escaped), or null for no search. */
export function likePattern(value: unknown, field = "search"): string | null {
  const term = optionalText(value, field, { max: 100 });
  if (term === null) return null;
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
