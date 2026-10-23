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
import { ICON_PATHS, type IconName } from "./icons.ts";
import { site } from "../../../src/data/site.ts";

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

/** "2026-11-08" → "8 Nov 2026" (a calendar date, no time zone shift); anything else as it is. */
export function formatDay(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : isoDate;
}

/** "Sunday workshop, 8 Nov 2026" or "December batch, 1 Dec 2026 to 19 Dec 2026". */
export function batchLine(batch: { title: string; startsOn: string; endsOn: string | null }): string {
  const from = formatDay(batch.startsOn);
  return batch.endsOn && batch.endsOn !== batch.startsOn ? `${batch.title}, ${from} to ${formatDay(batch.endsOn)}` : `${batch.title}, ${from}`;
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
  /** Extra class on <body> ("certificate-page" for the certificate). */
  bodyClass?: string;
  /** Load /app/learn.js (lesson pages). */
  script?: boolean;
  /** A wider column (the course home and lesson pages: video plus the lesson list). */
  wide?: boolean;
  /** Marks the header's "My courses" link as the current page. */
  current?: "account";
}

// ---------------------------------------------------------------- icons and small parts

/** A Phosphor icon (functions/_lib/pages/icons.ts). Decorative unless it gets a label. */
export function icon(name: IconName, label?: string): Raw {
  const a11y = label ? html`role="img" aria-label="${label}"` : raw(`aria-hidden="true" focusable="false"`);
  return html`<svg class="icon" ${a11y} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor"><path d="${ICON_PATHS[name]}"/></svg>`;
}

/** "3:05" or "1:02:09" for a position in a video. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

/** "1 lesson", "9 lessons". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The progress bar and its words: a native <progress> (screen readers announce it) and "3 of 9 lessons done". */
export function progressLine(done: number, total: number): Raw {
  return html`<p class="progress-line"><progress max="${total}" value="${done}" aria-label="Course progress">${done} of ${total}</progress>
  <span class="count">${done} of ${total} ${total === 1 ? "lesson" : "lessons"} done</span></p>`;
}

/** An alert (error), notice (done) or info line with its icon. */
export function callout(kind: "alert" | "notice" | "info", text: string | Raw, id?: string): Raw {
  const name: IconName = kind === "alert" ? "warning-circle" : kind === "notice" ? "check-circle" : "info";
  const role = kind === "alert" ? "alert" : "status";
  return html`<p class="${kind}"${id ? html` id="${id}"` : ""} role="${role}">${icon(name)}<span>${text}</span></p>`;
}

const LEGAL_LINKS = [
  { href: "/terms", label: "Terms" },
  { href: "/refunds", label: "Refunds" },
  { href: "/privacy", label: "Privacy" },
];
const MAIN_HOST = new URL(site.mainUrl).host;

export function layout(options: LayoutOptions, content: Raw): Raw {
  const help = whatsappHref(options.business, "Hi Urmi, I need help with my course account.");
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#ffffff">
<title>${options.title} | ${options.business.name}</title>
<link rel="preload" href="/app/fonts/plus-jakarta-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/app/app.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${options.script ? html`<script type="module" src="/app/learn.js"></script>` : ""}
</head>
<body class="${options.bodyClass ?? ""}">
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap${options.wide ? " wide" : ""} top-row">
    <a class="brand" href="${options.signedIn ? "/account" : "/"}"><span class="brand-logo" aria-hidden="true"></span><span class="visually-hidden">${options.business.name} </span><span class="brand-sub">Courses</span></a>
    <nav class="top-nav" aria-label="Main">
    <a class="nav-link nav-wide" href="/">${icon("squares-four")}<span>All courses</span></a>
    ${
      options.signedIn
        ? html`<a class="nav-link" href="/account"${options.current === "account" ? raw(` aria-current="page"`) : ""}>${icon("book-open-text")}<span>My courses</span></a>
    <form method="post" action="/learn/logout"><button type="submit" class="nav-link">${icon("sign-out")}<span class="nav-label-optional">Sign out</span></button></form>`
        : html`<a class="nav-link" href="/signin">${icon("user")}<span>Sign in</span></a>`
    }
    ${help ? html`<a class="nav-link nav-wide" href="${help}" rel="noopener noreferrer" target="_blank">${icon("whatsapp")}<span>Help</span></a>` : ""}
  </nav>
  </div>
</header>
<main id="main" class="wrap${options.wide ? " wide" : ""}">
${content}
</main>
<footer class="foot">
  <div class="wrap${options.wide ? " wide" : ""} foot-row">
    <div class="foot-brand">
      <a class="foot-logo" href="${site.mainUrl}"><span class="brand-logo" aria-hidden="true"></span><span class="visually-hidden">${options.business.name}, main site</span></a>
      <p>${options.business.name}, ${site.address.city}. Since ${site.foundedYear}.</p>
    </div>
    <ul class="foot-links" aria-label="Help and links">
      ${help ? html`<li><a href="${help}" rel="noopener noreferrer" target="_blank">${icon("whatsapp")}Need help? Message us on WhatsApp</a></li>` : ""}
      <li><a href="/">All courses</a></li>
      <li><a href="${site.social.instagram}" rel="noopener noreferrer" target="_blank">${icon("instagram")}Instagram</a></li>
      <li><a href="${site.mainUrl}">${MAIN_HOST}${icon("arrow-up-right")}</a></li>
    </ul>
  </div>
  <div class="wrap${options.wide ? " wide" : ""} foot-legal">
    <p>© ${new Date().getUTCFullYear()} ${options.business.name}</p>
    <nav class="foot-policies" aria-label="Policies">${LEGAL_LINKS.map((l) => html`<a href="${l.href}">${l.label}</a>`)}</nav>
  </div>
</footer>
</body>
</html>`;
}

export type Tone = "accent" | "ok" | "warn" | "info";

export interface MessageExtras {
  /** The icon in the circle above the heading. */
  icon?: IconName;
  tone?: Tone;
  /** A second, quieter action (opens WhatsApp when external). */
  secondary?: { href: string; label: string; external?: boolean };
}

/** A short state page (link expired, not found, rate limited…): an icon, a heading, a line and one clear next step. */
export function messagePage(
  options: LayoutOptions,
  heading: string,
  text: string,
  action?: { href: string; label: string },
  extras: MessageExtras = {},
): Raw {
  const tone = extras.tone ?? "accent";
  const second = extras.secondary;
  return layout(
    options,
    html`<section class="card narrow state tone-${tone}">
  <span class="state-icon">${icon(extras.icon ?? "info")}</span>
  <h1>${heading}</h1>
  <p>${text}</p>
  ${
    action || second
      ? html`<div class="btn-row">
    ${action ? html`<a class="btn" href="${action.href}">${action.label}</a>` : ""}
    ${second ? html`<a class="btn btn-quiet" href="${second.href}"${second.external ? raw(` target="_blank" rel="noopener noreferrer"`) : ""}>${second.external ? icon("whatsapp") : ""}${second.label}</a>` : ""}
  </div>`
      : ""
  }
</section>`,
  );
}
