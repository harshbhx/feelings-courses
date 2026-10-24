/**
 * Receipts: a page the buyer can keep, print or share on WhatsApp, and (since 23 Oct 2026) the same
 * link in the receipt email (signin-links.ts sendReceiptEmail).
 *
 * - buildReceipt(db, orderId): the Receipt data (src/shared/types.ts). W3's GET /api/me/orders/:id
 *   returns it for a signed-in student.
 * - receiptKey / receiptPath: a capability link, /receipt/<orderId>?k=<key>, where key is an HMAC
 *   of the order id with APP_SECRET. Whoever has the link sees the receipt; nobody can guess one
 *   for another order. The page shows the buyer's name only: no phone, no email (someone who
 *   paid with another person's address must learn nothing more from it).
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
import { listRefunds, toOrderSummary } from "./orders.ts";
import { formatRupees } from "./pricing.ts";
import { batchLine, icon, layout, markup, messagePage, raw, type Business } from "./pages/html.ts";
import { MAX_DEVICES_PER_STUDENT } from "../../src/shared/constants.ts";

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

/**
 * The receipt's headers. It shares the student area's stylesheet and font (/app/app.css, same
 * origin), so no inline style is allowed; the one inline script is the print button, by hash.
 */
export async function receiptHeaders(): Promise<Record<string, string>> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
    // The key is in the URL: never send it on as a Referer.
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; style-src 'self'; font-src 'self'; script-src ${await printScriptHash()}; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}

export interface ReceiptPageOptions {
  /** Absolute URL of this receipt (for "Share on WhatsApp"). */
  shareUrl: string;
  /** https://<hub>: the "Start learning" link goes to <hub>/learn/<slug>. */
  hubOrigin: string;
  now: number;
}

/** The business line for the page frame (name and WhatsApp only; never the GSTIN). */
function frameBusiness(business: PublicBusiness): Business {
  const whatsapp = business.whatsapp.replace(/\D/g, "");
  return { name: business.name, whatsapp: /^\d{8,15}$/.test(whatsapp) ? whatsapp : null };
}

export function renderReceiptPage(receipt: Receipt & { extras: ReceiptExtras }, options: ReceiptPageOptions): string {
  const { order, business, extras } = receipt;
  const test = order.mode === "test";
  const number = order.invoiceNo ?? `TEST-${order.id}`;
  const money = (p: number) => escapeHtml(formatRupees(p));
  const rows = receipt.lines
    .map((line, i) => {
      // The amount paid is the total: the last line, or the booking amount when the balance is paid at the studio.
      const deposit = receipt.lines.some((l) => l.label === "Booking amount paid online");
      const total = deposit ? line.label === "Booking amount paid online" : i === receipt.lines.length - 1;
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
  const refunded = order.status === "refunded";
  const firstName = receipt.buyer.name?.trim().split(/\s+/)[0] ?? "";
  const i = (name: Parameters<typeof icon>[0]) => markup(icon(name));
  const batch = extras.batch ? escapeHtml(batchLine(extras.batch)) : "";

  const head = refunded
    ? `<div class="paid-head is-refund"><span class="state-icon">${i("receipt")}</span><div><h1>Payment refunded</h1><p class="muted">This payment was refunded. The receipt below shows the details.</p></div></div>`
    : `<div class="paid-head"><span class="state-icon">${i("check-circle")}</span><div><h1>${order.status === "partially_refunded" ? "Payment received, partly refunded" : "Payment received"}</h1><p class="muted">${firstName ? `Thank you, ${escapeHtml(firstName)}. ` : "Thank you. "}${learnLink ? "Your course is ready to watch." : "Your seat is booked."}</p></div></div>`;

  const nextStep = refunded
    ? ""
    : learnLink
      ? `<section class="card next-step" aria-labelledby="next-h"><h2 id="next-h">Your course is ready</h2>
<p>Watch on your phone or laptop${extras.accessUntil ? `, until ${escapeHtml(formatIst(extras.accessUntil, false))}` : ""}, on up to ${MAX_DEVICES_PER_STUDENT} devices.${extras.batch ? ` Your studio batch: ${batch}.` : ""}</p>
<div class="btn-row"><a class="btn" href="${escapeHtml(learnLink)}">${i("play-fill")}Start learning</a></div></section>`
      : `<section class="card next-step" aria-labelledby="next-h"><h2 id="next-h">See you at the studio</h2>
<p>${extras.batch ? `Your batch: ${batch}.` : "We'll confirm your batch dates on WhatsApp."}${business.address ? ` ${escapeHtml(business.address)}.` : ""}</p>
${askLink ? `<div class="btn-row"><a class="btn btn-quiet" href="${escapeHtml(askLink)}" target="_blank" rel="noopener noreferrer">${i("whatsapp")}Message us</a></div>` : ""}</section>`;

  const body = `${test ? `<p class="test-banner" role="note">${i("info")}Test payment: no real money was charged.</p>` : ""}
${head}
${nextStep}
<section class="card" aria-labelledby="receipt-h">
<p class="receipt-biz">${escapeHtml(business.name)}${business.address ? ` · ${escapeHtml(business.address)}` : ""}${business.phone ? ` · ${escapeHtml(business.phone)}` : ""}</p>
<div class="receipt-title"><h2 id="receipt-h">Payment receipt</h2><span class="badge ${escapeHtml(order.status)}">${escapeHtml(STATUS_LABEL[order.status] ?? order.status)}</span></div>
<dl class="facts">
<dt>Receipt no.</dt><dd>${escapeHtml(number)}</dd>
<dt>Date</dt><dd>${order.paidAt ? escapeHtml(formatIst(order.paidAt)) : ""}</dd>
<dt>Name</dt><dd>${escapeHtml(receipt.buyer.name ?? "")}</dd>
<dt>Course</dt><dd>${escapeHtml(order.courseTitle)}</dd>
${extras.batch ? `<dt>Batch</dt><dd>${batch}</dd>` : ""}
${receipt.method ? `<dt>Paid by</dt><dd>${escapeHtml(METHODS[receipt.method] ?? receipt.method)}</dd>` : ""}
${order.razorpayPaymentId ? `<dt>Payment ID</dt><dd><code>${escapeHtml(order.razorpayPaymentId)}</code></dd>` : ""}
${extras.accessUntil && extras.courseFormat !== "in_person" ? `<dt>Access until</dt><dd>${escapeHtml(formatIst(extras.accessUntil, false))}</dd>` : ""}
</dl>
<table class="amounts"><caption class="visually-hidden">Amounts</caption><tbody>${rows}</tbody></table>
${refunds ? `<ul class="refunds">${refunds}</ul>` : ""}
${canRefund ? `<p class="info keep">${i("info")}<span>Changed your mind? Refund requests are accepted until ${escapeHtml(formatIst(order.refundableUntil!))}. Message us on WhatsApp.</span></p>` : ""}
<p class="muted small keep">Keep this page: it is your receipt. You can save it as a PDF with Print, or send the link to yourself on WhatsApp. ${order.razorpayPaymentId ? "Your payment ID also signs you in on a new device." : ""}</p>
</section>
<div class="btn-row no-print">
<a class="btn btn-quiet" href="${escapeHtml(shareLink)}" target="_blank" rel="noopener noreferrer">${i("whatsapp")}Share on WhatsApp</a>
${askLink && learnLink ? `<a class="btn btn-quiet" href="${escapeHtml(askLink)}" target="_blank" rel="noopener noreferrer">Message us</a>` : ""}
<button class="btn btn-quiet" id="print" type="button">${i("download-simple")}Print or save as PDF</button>
</div>
<script>${PRINT_SCRIPT}</script>`;

  return markup(layout({ title: `Receipt ${number}`, business: frameBusiness(business) }, raw(body)));
}

/** The small page shown for a wrong link or an unpaid order. */
export function renderReceiptMissing(): string {
  return markup(
    messagePage(
      { title: "Receipt not found", business: { name: FALLBACK_BUSINESS.name, whatsapp: null } },
      "Receipt not found",
      "This receipt link isn't valid, or the payment isn't complete yet. If you paid, wait a minute and open the link again, or message us on WhatsApp with your payment id.",
      { href: "/signin", label: "Sign in to see your payments" },
      { icon: "receipt", tone: "info" },
    ),
  );
}
