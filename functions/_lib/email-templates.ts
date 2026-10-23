/**
 * The emails the platform sends, plain text first and simple HTML second (inline styles: mail apps
 * ignore style sheets). Every value is escaped; links are only ever ours (hub origin + path).
 *
 * - signInEmail: the link asked for at /signin (15 minutes, once).
 * - receiptEmail: after a payment: the receipt link, and a sign-in link (15 minutes, once).
 * - enrolledEmail: after a free enrollment: a sign-in link (15 minutes, once).
 * - adminLinkEmail: the link Urmi makes in the admin (24 hours, once).
 *
 * No GSTIN and no tax lines (owner decision). No tracking pixels, no images: a plain, honest mail.
 */
import type { EmailMessage } from "./email.ts";

export interface EmailBrand {
  /** Trading name, "Feelings Beauty Care". */
  name: string;
  /** wa.me link for help, or null. */
  whatsappUrl: string | null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const INK = "#1e1214";
const MUTED = "#5c4a4d";
const ACCENT = "#b3121b";

interface Block {
  /** A paragraph of text. */
  p?: string;
  /** Label: value lines (a small table). */
  rows?: [string, string][];
  /** A button. */
  button?: { href: string; label: string };
  /** Small print. */
  small?: string;
}

function render(brand: EmailBrand, to: string, subject: string, heading: string, blocks: Block[]): EmailMessage {
  const help = brand.whatsappUrl ? `Questions? Message us on WhatsApp: ${brand.whatsappUrl}` : null;
  const textParts: string[] = [heading, ""];
  for (const b of blocks) {
    if (b.p) textParts.push(b.p, "");
    if (b.rows) textParts.push(...b.rows.map(([k, v]) => `${k}: ${v}`), "");
    if (b.button) textParts.push(`${b.button.label}:`, b.button.href, "");
    if (b.small) textParts.push(b.small, "");
  }
  if (help) textParts.push(help, "");
  textParts.push(`${brand.name}`);
  const text = textParts.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  const body = blocks
    .map((b) => {
      const out: string[] = [];
      if (b.p) out.push(`<p style="font-size:16px;line-height:1.55;margin:0 0 16px;color:${INK}">${escapeHtml(b.p)}</p>`);
      if (b.rows) {
        out.push(
          `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px;font-size:15px;color:${INK}">${b.rows
            .map(
              ([k, v]) =>
                `<tr><td style="padding:4px 16px 4px 0;color:${MUTED}">${escapeHtml(k)}</td><td style="padding:4px 0;font-weight:600">${escapeHtml(v)}</td></tr>`,
            )
            .join("")}</table>`,
        );
      }
      if (b.button) {
        out.push(
          `<p style="margin:0 0 16px"><a href="${escapeHtml(b.button.href)}" style="display:inline-block;padding:13px 22px;background:${ACCENT};color:#ffffff;text-decoration:none;border-radius:999px;font-weight:700;font-size:16px">${escapeHtml(b.button.label)}</a></p>`,
          `<p style="font-size:13px;line-height:1.5;margin:0 0 16px;color:${MUTED};word-break:break-all">Or open this link: ${escapeHtml(b.button.href)}</p>`,
        );
      }
      if (b.small) out.push(`<p style="font-size:14px;line-height:1.5;margin:0 0 16px;color:${MUTED}">${escapeHtml(b.small)}</p>`);
      return out.join("\n");
    })
    .join("\n");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px 16px;background:#ffffff;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:${INK}">
<div style="max-width:520px;margin:0 auto">
<p style="font-size:14px;font-weight:700;letter-spacing:.02em;margin:0 0 20px;color:${ACCENT}">${escapeHtml(brand.name)}</p>
<h1 style="font-size:22px;line-height:1.3;margin:0 0 16px;color:${INK}">${escapeHtml(heading)}</h1>
${body}
${help ? `<p style="font-size:14px;line-height:1.5;margin:24px 0 0;color:${MUTED}">Questions? <a href="${escapeHtml(brand.whatsappUrl!)}" style="color:${ACCENT}">Message us on WhatsApp</a>.</p>` : ""}
</div>
</body></html>`;
  return { to, subject, text, html };
}

const NOT_YOU = "If you didn't ask for this, you can ignore this email: nobody can sign in without the link.";
const ONCE_15 = "The link works once, for 15 minutes. Open it on the phone or computer where you want to watch.";

export function signInEmail(brand: EmailBrand, to: string, url: string): EmailMessage {
  return render(brand, to, `Your sign-in link for ${brand.name} courses`, "Open your course", [
    { p: "Tap the button to sign in to your course." },
    { button: { href: url, label: "Sign in" } },
    { small: ONCE_15 },
    { small: NOT_YOU },
  ]);
}

export interface ReceiptEmailInput {
  courseTitle: string;
  amount: string;
  paidOn: string;
  paymentId: string;
  invoiceNo: string | null;
  receiptUrl: string | null;
  signInUrl: string | null;
}

export function receiptEmail(brand: EmailBrand, to: string, r: ReceiptEmailInput): EmailMessage {
  const rows: [string, string][] = [
    ["Course", r.courseTitle],
    ["Paid", r.amount],
    ["Date", r.paidOn],
    ["Payment ID", r.paymentId],
  ];
  if (r.invoiceNo) rows.splice(1, 0, ["Receipt no.", r.invoiceNo]);
  const blocks: Block[] = [{ p: `Thank you. Your payment for ${r.courseTitle} is confirmed.` }, { rows }];
  if (r.receiptUrl) blocks.push({ p: "Your receipt, to print or save as a PDF:" }, { button: { href: r.receiptUrl, label: "View receipt" } });
  if (r.signInUrl) blocks.push({ p: "Open your course on this phone or computer:" }, { button: { href: r.signInUrl, label: "Open my course" } }, { small: ONCE_15 });
  blocks.push({ small: "Later, sign in any time at the course site with this email address: we send you a fresh link." });
  return render(brand, to, `Payment received: ${r.courseTitle}`, "Payment received", blocks);
}

export function enrolledEmail(brand: EmailBrand, to: string, courseTitle: string, signInUrl: string | null): EmailMessage {
  const blocks: Block[] = [{ p: `You're enrolled in ${courseTitle}.` }];
  if (signInUrl) blocks.push({ button: { href: signInUrl, label: "Open my course" } }, { small: ONCE_15 });
  blocks.push({ small: "Later, sign in any time at the course site with this email address: we send you a fresh link." }, { small: NOT_YOU });
  return render(brand, to, `You're enrolled: ${courseTitle}`, "You're enrolled", blocks);
}

export function adminLinkEmail(brand: EmailBrand, to: string, name: string | null, url: string): EmailMessage {
  const hello = name ? `Hi ${name.split(" ")[0]},` : "Hi,";
  return render(brand, to, `Your sign-in link for ${brand.name} courses`, "Open your course", [
    { p: `${hello} here is your link to open your course.` },
    { button: { href: url, label: "Sign in" } },
    { small: "The link works once and expires in 24 hours. Please don't share it." },
  ]);
}
