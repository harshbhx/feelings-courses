/** Number, money and date wording for the admin demo (Indian English, rupees, Indian grouping). */

const inrFormat = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
const numFormat = new Intl.NumberFormat("en-IN");

/** ₹1,04,965 */
export const inr = (rupees: number) => inrFormat.format(rupees);

/** 1,342 */
export const num = (n: number) => numFormat.format(n);

/** ₹12K, ₹1.2L: short labels for chart axes. */
export function inrShort(rupees: number): string {
  if (rupees >= 100000) return `₹${trim(rupees / 100000)}L`;
  if (rupees >= 1000) return `₹${trim(rupees / 1000)}K`;
  return `₹${rupees}`;
}

const trim = (n: number) => (Math.round(n * 10) / 10).toString().replace(/\.0$/, "");

/** "1 lesson", "9 lessons" */
export const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

/** "1 h 28 min", "45 min" */
export function duration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** 98xxxx1234 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "").slice(-10);
  if (digits.length < 10) return "xxxxxxxxxx";
  return `${digits.slice(0, 2)}xxxx${digits.slice(-4)}`;
}

/** 21 Oct */
export const dayMonth = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });

/** 21 Oct 2026 */
export const fullDate = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

/** Tuesday, 21 October */
export const longDate = (d: Date) => d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

/** 4:05 pm */
export const time = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true });

/** "Just now", "12 min ago", "3 h ago", "Yesterday", "21 Oct" */
export function ago(d: Date, now = new Date()): string {
  const diff = Math.max(0, now.getTime() - d.getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (d.getTime() >= startToday) return `${Math.floor(min / 60)} h ago`;
  if (d.getTime() >= startToday - 86400000) return `Yesterday, ${time(d)}`;
  return `${dayMonth(d)}, ${time(d)}`;
}

/** Two initials for an avatar: "Priya Patel" -> "PP". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** Signed percentage change, or null when there's nothing to compare against. */
export function change(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}
