/**
 * On-screen receipts (owner decision: no email service, so the receipt lives on a page the buyer
 * can keep, print or share on WhatsApp).
 *
 * - buildReceipt(db, orderId): the Receipt data (src/shared/types.ts). W3's GET /api/me/orders/:id
 *   returns it for a signed-in student.
 * - receiptKey / receiptPath: a capability link, /receipt/<orderId>?k=<key>, where key is an HMAC
 *   of the order id with APP_SECRET. Whoever has the link sees the receipt; nobody can guess one
 *   for another order. The page masks the phone number and leaves out the email.
 * - renderReceiptPage(): the HTML, rendered by functions/receipt/[id].ts.
 *
 * Owner decision (plan 10.5): a plain "Payment receipt" with its invoice number. No GSTIN, no tax
 * lines, ever. The business block is built field by field from PublicBusiness, so a stored gstin
 * can't leak in by accident.
 */
import type { CourseFormat, PublicBusiness, Receipt, ReceiptLine } from "../../src/shared/types.ts";
import { requireSecret } from "./config.ts";
import { hmacSha256Hex, timingSafeEqual } from "./crypto.ts";
import type { Db } from "./db/d1.ts";
import { getSetting } from "./db/settings.ts";
import type { Env } from "./env.ts";
import { listRefunds, maskPhone, toOrderSummary } from "./orders.ts";
import { formatRupees } from "./pricing.ts";

const PAID_STATES = new Set(["paid", "partially_refunded", "refunded"]);

interface ReceiptRow {
  id: number;
  razorpay_order_id: string | null;
  mode: "test" | "live";
  student_id: number;
  course_id: number;
  batch_id: number | null;
  payment_kind: "full" | "deposit";
  list_price_paise: number;
  discount_paise: number;
  amount_paise: number;
  currency: string;
  coupon_id: number | null;
  status: "created" | "paid" | "failed" | "partially_refunded" | "refunded";
  razorpay_payment_id: string | null;
  method: string | null;
  invoice_no: string | null;
  refunded_paise: number;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
  paid_at: number | null;
  course_slug: string;
  course_title: string;
  course_format: CourseFormat;
  student_name: string | null;
  student_phone: string | null;
  student_email: string | null;
  student_state: string | null;
  coupon_code: string | null;
  batch_title: string | null;
  batch_starts_on: string | null;
  batch_ends_on: string | null;
}

/** Extra facts the page shows that the shared Receipt type doesn't carry. */
export interface ReceiptExtras {
  courseFormat: CourseFormat;
  batch: { title: string; startsOn: string; endsOn: string | null } | null;
  /** When access to the recorded lessons from this order ends (null: no expiry or no enrollment). */
  accessUntil: number | null;
}

const FALLBACK_BUSINESS: PublicBusiness = {
  name: "Feelings Beauty Care",
  legalName: "Feelings Beauty Care",
  address: "",
  stateCode: "24",
  phone: "",
  whatsapp: "",
};

/** Public business facts only, copied field by field (never the stored gstin). */
export async function publicBusiness(db: Db): Promise<PublicBusiness> {
  const stored = await getSetting(db, "business");
  const pick = (key: keyof PublicBusiness) => (typeof stored?.[key] === "string" ? (stored[key] as string) : FALLBACK_BUSINESS[key]);
  return {
    name: pick("name"),
    legalName: pick("legalName"),
    address: pick("address"),
    stateCode: pick("stateCode"),
    phone: pick("phone"),
    whatsapp: pick("whatsapp"),
  };
}

/** The receipt of a paid (or refunded) order, or null when there is none to show. */
export async function buildReceipt(db: Db, orderId: number): Promise<(Receipt & { extras: ReceiptExtras }) | null> {
  if (!Number.isSafeInteger(orderId) || orderId < 1) return null;
  const row = await db
    .prepare(
      `SELECT o.*, c.slug AS course_slug, c.title AS course_title, c.format AS course_format,
              s.name AS student_name, s.phone AS student_phone, s.email AS student_email, s.state_code AS student_state,
              k.code AS coupon_code, b.title AS batch_title, b.starts_on AS batch_starts_on, b.ends_on AS batch_ends_on
       FROM orders o JOIN courses c ON c.id = o.course_id JOIN students s ON s.id = o.student_id
       LEFT JOIN coupons k ON k.id = o.coupon_id LEFT JOIN batches b ON b.id = o.batch_id
       WHERE o.id = ?`,
    )
    .bind(orderId)
    .first<ReceiptRow>();
  if (!row || !PAID_STATES.has(row.status)) return null;

  const enrollment = await db
    .prepare("SELECT expires_at FROM enrollments WHERE order_id = ? AND revoked_at IS NULL")
    .bind(orderId)
    .first<{ expires_at: number | null }>();

  const courseLine = row.batch_title ? `${row.course_title} (${row.batch_title})` : row.course_title;
  const lines: ReceiptLine[] = [{ label: courseLine, amountPaise: row.list_price_paise }];
  if (row.discount_paise > 0) {
    lines.push({ label: row.coupon_code ? `Coupon ${row.coupon_code}` : "Discount", amountPaise: -row.discount_paise });
  }
  if (row.payment_kind === "deposit") {
    lines.push({ label: "Booking amount paid online", amountPaise: row.amount_paise });
    lines.push({
      label: "Balance to pay at the studio",
      amountPaise: row.list_price_paise - row.discount_paise - row.amount_paise,
    });
  } else {
    lines.push({ label: "Total paid", amountPaise: row.amount_paise });
  }

  return {
    kind: "receipt",
    order: toOrderSummary(row),
    business: await publicBusiness(db),
    buyer: { name: row.student_name, phone: row.student_phone, email: row.student_email, stateCode: row.student_state },
    method: row.method,
    couponCode: row.coupon_code,
    listPaise: row.list_price_paise,
    discountPaise: row.discount_paise,
    lines,
    refunds: await listRefunds(db, orderId),
    extras: {
      courseFormat: row.course_format,
      batch: row.batch_title ? { title: row.batch_title, startsOn: row.batch_starts_on!, endsOn: row.batch_ends_on } : null,
      accessUntil: enrollment?.expires_at ?? null,
    },
  };
}

// ---------------------------------------------------------------- capability link

/** 32 hex characters (128 bits) of HMAC-SHA256("receipt:v1:<orderId>") keyed with APP_SECRET. */
export async function receiptKey(env: Partial<Env>, orderId: number): Promise<string> {
  const secret = requireSecret(env, "APP_SECRET");
  return (await hmacSha256Hex(secret, `receipt:v1:${orderId}`)).slice(0, 32);
}

/** /receipt/<orderId>?k=<key> */
export async function receiptPath(env: Partial<Env>, orderId: number): Promise<string> {
  return `/receipt/${orderId}?k=${await receiptKey(env, orderId)}`;
}

export async function checkReceiptKey(env: Partial<Env>, orderId: number, key: string | null): Promise<boolean> {
  if (!key || !/^[0-9a-f]{32}$/.test(key)) return false;
  return timingSafeEqual(key, await receiptKey(env, orderId));
}

// ---------------------------------------------------------------- page

const escapeHtml = (value: unknown): string =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** "23 Oct 2026, 2:05 pm" in India time. */
export function formatIst(unix: number, withTime = true): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit", hour12: true } : {}),
  };
  return new Intl.DateTimeFormat("en-IN", options).format(new Date(unix * 1000));
}

const METHODS: Record<string, string> = {
  upi: "UPI",
  card: "Card",
  netbanking: "Net banking",
  wallet: "Wallet",
  emi: "EMI",
  paylater: "Pay later",
};

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
};

/** The print button's script. Its hash goes in the page's CSP. */
const PRINT_SCRIPT = `document.getElementById("print").addEventListener("click",function(){window.print()});`;
let printHash: Promise<string> | null = null;
function printScriptHash(): Promise<string> {
  printHash ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(PRINT_SCRIPT))
    .then((buf) => `'sha256-${btoa(String.fromCharCode(...new Uint8Array(buf)))}'`);
  return printHash;
}

export async function receiptHeaders(): Promise<Record<string, string>> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    // The key is in the URL: never send it on as a Referer.
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src ${await printScriptHash()}; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

export interface ReceiptPageOptions {
  /** Absolute URL of this receipt (for "Share on WhatsApp"). */
  shareUrl: string;
  /** https://<hub>: the "Start learning" link goes to <hub>/learn/<slug>. */
  hubOrigin: string;
  now: number;
}

export function renderReceiptPage(receipt: Receipt & { extras: ReceiptExtras }, options: ReceiptPageOptions): string {
  const { order, business, extras } = receipt;
  const test = order.mode === "test";
  const number = order.invoiceNo ?? `TEST-${order.id}`;
  const money = (p: number) => escapeHtml(formatRupees(p));
  const rows = receipt.lines
    .map((line, i) => {
      const total = i === receipt.lines.length - 1 || line.label === "Booking amount paid online";
      return `<tr${total ? ' class="total"' : ""}><th scope="row">${escapeHtml(line.label)}</th><td>${money(line.amountPaise)}</td></tr>`;
    })
    .join("");
  const refunds = receipt.refunds
    .filter((r) => r.status !== "failed")
    .map(
      (r) =>
        `<li>${money(r.amountPaise)} ${r.status === "processed" ? "refunded" : "refund in progress"} on ${escapeHtml(formatIst(r.createdAt, false))}. Banks take 5 to 7 working days to show it.</li>`,
    )
    .join("");
  const canRefund = order.status === "paid" && order.refundableUntil !== null && options.now < order.refundableUntil;
  const wa = (text: string, to = "") => `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
  const shareLink = wa(`My receipt ${number} from ${business.name}: ${options.shareUrl}`);
  const askLink = business.whatsapp
    ? wa(`Hi, I have a question about my payment ${number} (${order.courseTitle}).`, business.whatsapp.replace(/\D/g, ""))
    : null;
  const learnLink = extras.courseFormat !== "in_person" ? `${options.hubOrigin}/learn/${encodeURIComponent(order.courseSlug)}` : null;

  return `<!doctype html>
<html lang="en-IN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Receipt ${escapeHtml(number)} | ${escapeHtml(business.name)}</title>
<style>
:root{--ink:#2b1d1a;--muted:#6f5f5a;--line:#eadfdb;--bg:#fbf7f5;--card:#fff;--accent:#b3261e;--ok:#1d6b3a}
@media (prefers-color-scheme:dark){:root{--ink:#f3ebe8;--muted:#bfb0ab;--line:#3b302d;--bg:#191312;--card:#221a19;--accent:#ff8a80;--ok:#7fd49b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:40rem;margin:0 auto;padding:24px 16px 48px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px}
h1{font-size:1.5rem;margin:0 0 4px}
.muted{color:var(--muted);font-size:.9rem}
.test{background:#fff4ce;color:#5c4400;border-radius:10px;padding:10px 12px;margin:0 0 16px;font-weight:600}
.badge{display:inline-block;border-radius:999px;padding:2px 10px;font-size:.85rem;font-weight:600;border:1px solid currentColor}
.badge.paid{color:var(--ok)}.badge.refunded,.badge.partially_refunded{color:var(--accent)}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:16px 0}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
table{width:100%;border-collapse:collapse;margin:16px 0}
th,td{padding:8px 0;border-bottom:1px solid var(--line);text-align:left;font-weight:400}
td{text-align:right;white-space:nowrap;padding-left:12px}
tr.total th,tr.total td{font-weight:700}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 16px;border-radius:999px;border:1px solid var(--line);color:var(--ink);text-decoration:none;font:inherit;background:none;cursor:pointer}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.note{margin-top:16px;font-size:.95rem}
ul{padding-left:20px}
@media print{body{background:#fff;color:#000}.actions,.test-hide{display:none}.card{border:0;padding:0}}
</style>
</head>
<body>
<main>
${test ? '<p class="test">Test payment: no real money was charged.</p>' : ""}
<div class="card">
<p class="muted">${escapeHtml(business.name)}${business.address ? ` · ${escapeHtml(business.address)}` : ""}${business.phone ? ` · ${escapeHtml(business.phone)}` : ""}</p>
<h1>Payment receipt</h1>
<span class="badge ${escapeHtml(order.status)}">${escapeHtml(STATUS_LABEL[order.status] ?? order.status)}</span>
<dl>
<dt>Receipt no.</dt><dd>${escapeHtml(number)}</dd>
<dt>Date</dt><dd>${order.paidAt ? escapeHtml(formatIst(order.paidAt)) : ""}</dd>
<dt>Name</dt><dd>${escapeHtml(receipt.buyer.name ?? "")}</dd>
${receipt.buyer.phone ? `<dt>Phone</dt><dd>${escapeHtml(maskPhone(receipt.buyer.phone))}</dd>` : ""}
<dt>Course</dt><dd>${escapeHtml(order.courseTitle)}</dd>
${extras.batch ? `<dt>Batch</dt><dd>${escapeHtml(extras.batch.title)}, from ${escapeHtml(extras.batch.startsOn)}${extras.batch.endsOn ? ` to ${escapeHtml(extras.batch.endsOn)}` : ""}</dd>` : ""}
${receipt.method ? `<dt>Paid by</dt><dd>${escapeHtml(METHODS[receipt.method] ?? receipt.method)}</dd>` : ""}
${order.razorpayPaymentId ? `<dt>Payment id</dt><dd>${escapeHtml(order.razorpayPaymentId)}</dd>` : ""}
${extras.accessUntil ? `<dt>Access until</dt><dd>${escapeHtml(formatIst(extras.accessUntil, false))}</dd>` : ""}
</dl>
<table><tbody>${rows}</tbody></table>
${refunds ? `<ul class="note">${refunds}</ul>` : ""}
${canRefund ? `<p class="note">Changed your mind? Refund requests are accepted until ${escapeHtml(formatIst(order.refundableUntil!))}. Message us on WhatsApp.</p>` : ""}
<p class="note muted">Keep this page: it is your receipt. You can save it as a PDF with Print, or send the link to yourself on WhatsApp.</p>
<div class="actions">
${learnLink && order.status !== "refunded" ? `<a class="btn primary" href="${escapeHtml(learnLink)}">Start learning</a>` : ""}
<a class="btn" href="${escapeHtml(shareLink)}" target="_blank" rel="noopener noreferrer">Share on WhatsApp</a>
${askLink ? `<a class="btn" href="${escapeHtml(askLink)}" target="_blank" rel="noopener noreferrer">Message us</a>` : ""}
<button class="btn" id="print" type="button">Print or save as PDF</button>
</div>
</div>
</main>
<script>${PRINT_SCRIPT}</script>
</body>
</html>`;
}

/** The small page shown for a wrong link or an unpaid order. */
export function renderReceiptMissing(): string {
  return `<!doctype html><html lang="en-IN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Receipt not found</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#fbf7f5;color:#2b1d1a}main{max-width:36rem;margin:0 auto;padding:48px 16px}@media (prefers-color-scheme:dark){body{background:#191312;color:#f3ebe8}}</style>
</head><body><main><h1>Receipt not found</h1><p>This receipt link isn't valid, or the payment isn't complete yet. If you paid, wait a minute and open the link again, or message us on WhatsApp with your payment id.</p></main></body></html>`;
}
