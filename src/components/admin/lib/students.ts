/**
 * Students: access wording, phone checks for "Add student" (same rule as the API), and the erase
 * confirmation (the owner types the student's name).
 */
import { normalizePhone } from "../../../shared/constants.ts";
import type { EnrollmentSummary, Unix } from "../../../shared/types.ts";

export type AccessState = "active" | "expired" | "revoked" | "test";

export function accessState(e: Pick<EnrollmentSummary, "active" | "revokedAt" | "expiresAt" | "mode">, now: Unix): AccessState {
  if (e.active) return "active";
  if (e.revokedAt !== null) return "revoked";
  if (e.expiresAt !== null && e.expiresAt <= now) return "expired";
  return "test";
}

export const ACCESS_LABELS: Record<AccessState, string> = {
  active: "Has access",
  expired: "Access ended",
  revoked: "Access removed",
  test: "Test payment",
};

/**
 * A phone as the API stores it (E.164), or null when it isn't one: a 10-digit Indian mobile with or
 * without +91, 0 or spaces, or +<country><number>. The API's own rule (src/shared/constants.ts).
 */
export { normalizePhone };

/** Light email check (the API checks again). */
export const looksLikeEmail = (s: string) => {
  const tidy = s.trim().toLowerCase();
  return tidy.length <= 254 && /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}$/.test(tidy);
};

/** The erase button unlocks when the typed name matches (case and extra spaces ignored). */
export function eraseConfirmed(typed: string, name: string | null): boolean {
  const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  if (!name) return norm(typed) === "erase";
  return norm(typed) === norm(name);
}

/** "+91 98250 12345" for showing a full E.164 Indian number. */
export function prettyPhone(phone: string | null): string {
  if (!phone) return "—";
  const m = /^\+91(\d{5})(\d{5})$/.exec(phone);
  return m ? `+91 ${m[1]} ${m[2]}` : phone;
}

/** wa.me link for a phone (digits only), or null. */
export function whatsappHref(phone: string | null, text?: string): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return null;
  return `https://wa.me/${digits}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** "Chrome on Android" from a user agent, for the devices list. */
export function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /iPhone|iPad/.test(ua) ? (/iPad/.test(ua) ? "iPad" : "iPhone") : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /SamsungBrowser/.test(ua)
      ? "Samsung Internet"
      : /Instagram/.test(ua)
        ? "Instagram"
        : /CriOS|Chrome\//.test(ua)
          ? "Chrome"
          : /FxiOS|Firefox\//.test(ua)
            ? "Firefox"
            : /Safari\//.test(ua)
              ? "Safari"
              : "";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Unknown device";
}
