/**
 * Server-rendered pages of the student area (W3): sign-in, account, course area, access links and
 * certificates. These pages are personal (or, for /verify, looked up live), so Functions render
 * them from D1 instead of the static build.
 *
 * Every page: escaped text only (html`` escapes every interpolation unless it is raw()), no
 * inline scripts or styles (the CSP below allows only same-origin files: /app/app.css and
 * /app/learn.js), no-store, noindex, frame-ancestors 'none' and no referrer (tokens and course
 * paths never leak to another site).
 */
import { getSetting } from "../db/settings.ts";
import type { Db } from "../db/d1.ts";
import { securityHeaders } from "../http.ts";

// ---------------------------------------------------------------- escaping

const RAW = Symbol("raw");
export interface Raw {
  [RAW]: string;
}

/** Marks trusted markup (built by html``) so it isn't escaped again. */
export function raw(markup: string): Raw {
  return { [RAW]: markup };
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Part = Raw | string | number | null | undefined | false | readonly Part[];

function render(part: Part): string {
  if (part === null || part === undefined || part === false) return "";
  if (Array.isArray(part)) return part.map(render).join("");
  if (typeof part === "object" && RAW in part) return part[RAW];
  return escapeHtml(part);
}

/** A template tag: interpolations are escaped; arrays are joined; raw() and nested html`` pass through. */
export function html(strings: TemplateStringsArray, ...values: Part[]): Raw {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += render(values[i]!) + (strings[i + 1] ?? "");
  return raw(out);
}

export function markup(value: Raw): string {
  return value[RAW];
}

// ---------------------------------------------------------------- formatting

const IST = 5.5 * 3600;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "23 Oct 2026" in India time. */
export function formatDate(unix: number): string {
  const d = new Date((unix + IST) * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "23 October 2026" (certificates). */
export function formatLongDate(unix: number): string {
  const d = new Date((unix + IST) * 1000);
  const long = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${d.getUTCDate()} ${long[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "₹4,999" or "₹4,999.50" (Indian digit grouping). */
export function formatRupees(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const rest = paise % 100;
  const digits = String(rupees);
  const last3 = digits.slice(-3);
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `₹${head ? `${head},${last3}` : last3}${rest ? `.${String(rest).padStart(2, "0")}` : ""}`;
}

/** "+91 ••••• •1578" for the video watermark. */
export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  const tail = phone.slice(-4);
  return phone.startsWith("+91") ? `+91 ••••• •${tail}` : `•••• ${tail}`;
}

// ---------------------------------------------------------------- responses

/** The pages' Content-Security-Policy: same-origin files only, nothing inline. */
export const PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; " +
  "font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function pageHeaders(extra: Record<string, string> = {}): Headers {
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": PAGE_CSP,
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    ...extra,
  });
  return securityHeaders(headers, { frameDeny: true });
}

/** An HTML response. `cookies` become Set-Cookie headers. */
export function page(body: Raw, status = 200, cookies: string[] = [], method = "GET"): Response {
  const headers = pageHeaders();
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(method === "HEAD" ? null : markup(body), { status, headers });
}

/** A redirect from a page (303 after a form POST, 302 otherwise), with the pages' headers. */
export function pageRedirect(location: string, cookies: string[] = [], status = 303): Response {
  const headers = pageHeaders({ Location: location });
  headers.delete("Content-Type");
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

/**
 * A form POST from one of these pages. Origin must be this site when the browser sends it, and
 * Sec-Fetch-Site must not say cross-site; together with SameSite=Lax cookies this stops CSRF,
 * including login CSRF on /signin.
 */
export function formFromSameSite(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin !== null) return origin === new URL(request.url).origin;
  const site = request.headers.get("Sec-Fetch-Site");
  return site === null || site === "same-origin" || site === "none";
}

// ---------------------------------------------------------------- layout

export interface Business {
  name: string;
  whatsapp: string | null;
}

/** The trading name and WhatsApp number from settings.business (never the GSTIN). */
export async function loadBusiness(db: Db | null): Promise<Business> {
  const fallback: Business = { name: "Feelings Beauty Care", whatsapp: null };
  if (!db) return fallback;
  try {
    const business = await getSetting(db, "business");
    if (!business) return fallback;
    const whatsapp = typeof business.whatsapp === "string" && /^\d{8,15}$/.test(business.whatsapp) ? business.whatsapp : null;
    return { name: typeof business.name === "string" && business.name ? business.name : fallback.name, whatsapp };
  } catch {
    return fallback;
  }
}

export function whatsappHref(business: Business, text: string): string | null {
  return business.whatsapp ? `https://wa.me/${business.whatsapp}?text=${encodeURIComponent(text)}` : null;
}

export interface LayoutOptions {
  title: string;
  business: Business;
  /** Show "My courses" and "Sign out" in the header. */
  signedIn?: boolean;
  /** Extra class on <body> ("print" for the certificate page). */
  bodyClass?: string;
  /** Load /app/learn.js (lesson pages). */
  script?: boolean;
}

export function layout(options: LayoutOptions, content: Raw): Raw {
  const help = whatsappHref(options.business, "Hi Urmi, I need help with my course account.");
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${options.title} | ${options.business.name}</title>
<link rel="stylesheet" href="/app/app.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${options.script ? html`<script type="module" src="/app/learn.js"></script>` : ""}
</head>
<body class="${options.bodyClass ?? ""}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap top-row">
    <a class="brand" href="/">${options.business.name}<span class="brand-sub">Courses</span></a>
    ${
      options.signedIn
        ? html`<nav class="top-nav" aria-label="Account">
    <a href="/account">My courses</a>
    <form method="post" action="/learn/logout"><button type="submit" class="linklike">Sign out</button></form>
  </nav>`
        : ""
    }
  </div>
</header>
<main id="main" class="wrap">
${content}
</main>
<footer class="foot">
  <div class="wrap">
    ${help ? html`<a href="${help}" rel="noopener noreferrer" target="_blank">Need help? Message us on WhatsApp</a>` : html`<span>${options.business.name}</span>`}
  </div>
</footer>
</body>
</html>`;
}

/** A short message page (link expired, not found, rate limited…). */
export function messagePage(options: LayoutOptions, heading: string, text: string, action?: { href: string; label: string }): Raw {
  return layout(
    options,
    html`<section class="card narrow">
  <h1>${heading}</h1>
  <p>${text}</p>
  ${action ? html`<p><a class="btn" href="${action.href}">${action.label}</a></p>` : ""}
</section>`,
  );
}
