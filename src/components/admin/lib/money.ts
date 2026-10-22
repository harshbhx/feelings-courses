/**
 * Money for the admin. The API counts integer paise (₹1 = 100); people type rupees. Parsing is
 * done on the digits, never with floats, so "2999.10" is exactly 299910 paise.
 */
import type { Paise } from "../../../shared/types.ts";

export type RupeeParse = { ok: true; paise: Paise | null } | { ok: false; error: string };

/**
 * Reads what someone typed in a rupee field. "" → null (no value). Accepts "2999", "2,999",
 * "₹ 2,999.50", "2999.5". Refuses negatives, letters and more than two decimals.
 */
export function parseRupees(input: string, opts: { max?: Paise } = {}): RupeeParse {
  const raw = input.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  if (!raw) return { ok: true, paise: null };
  if (raw.startsWith("-")) return { ok: false, error: "Enter an amount of zero or more." };
  const m = /^(\d{0,12})(?:\.(\d{0,2}))?$/.exec(raw);
  if (!m || (!m[1] && !m[2])) {
    if (/^\d*\.\d{3,}$/.test(raw)) return { ok: false, error: "Use at most two digits after the point (paise)." };
    return { ok: false, error: "Enter the amount in rupees, like 2999." };
  }
  const rupees = Number(m[1] || "0");
  const paise = rupees * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(paise)) return { ok: false, error: "That amount is too large." };
  if (opts.max !== undefined && paise > opts.max) return { ok: false, error: `Enter at most ${formatPaise(opts.max)}.` };
  return { ok: true, paise };
}

/** For a rupee input's value: 299900 → "2999", 299950 → "2999.50", null → "". */
export function paiseToInput(paise: Paise | null | undefined): string {
  if (paise === null || paise === undefined) return "";
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  return rest ? `${rupees}.${String(rest).padStart(2, "0")}` : String(rupees);
}

const whole = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0, minimumFractionDigits: 0 });
const exact = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 2 });

/** ₹2,999 or ₹2,999.50 (paise only when there are some). */
export function formatPaise(paise: Paise): string {
  return paise % 100 === 0 ? whole.format(paise / 100) : exact.format(paise / 100);
}

/** A course fee for lists: "₹2,999", "Free", "No fee yet". */
export function feeLabel(paise: Paise | null): string {
  if (paise === null) return "No fee yet";
  if (paise === 0) return "Free";
  return formatPaise(paise);
}

/** Short labels for chart axes: ₹950, ₹12K, ₹1.2L, ₹3.4Cr. */
export function paiseShort(paise: Paise): string {
  const rupees = paise / 100;
  const trim = (n: number) => (Math.round(n * 10) / 10).toString().replace(/\.0$/, "");
  if (rupees >= 10_000_000) return `₹${trim(rupees / 10_000_000)}Cr`;
  if (rupees >= 100_000) return `₹${trim(rupees / 100_000)}L`;
  if (rupees >= 1000) return `₹${trim(rupees / 1000)}K`;
  return `₹${Math.round(rupees)}`;
}
