/**
 * Small pieces shared by the Payments screen and the student drawer: the status pill, the method
 * label, the payment date and the Refund notice. Styles: txn.css.
 */
import { h, icon } from "../client/dom";
import { toast } from "../client/ui";
import { dayMonth, fullDate, time } from "../client/format";
import { METHOD_LABELS, STATUS_LABELS, type Txn, type TxnMethod, type TxnStatus } from "../../../lib/demo-store-students";

export { TXN_ICONS } from "./icons";

const STATUS_ICON: Record<TxnStatus, string> = {
  captured: "check",
  failed: "x-circle",
  refunded: "arrow-counter-clockwise",
};

const METHOD_ICON: Record<TxnMethod, string> = {
  UPI: "device-mobile",
  Card: "credit-card",
  Netbanking: "bank",
};

/** "Captured", "Failed" or "Refunded", with an icon so the colour is never the only signal. */
export function statusPill(status: TxnStatus): HTMLElement {
  return h("span", { class: `pill pill-plain txn-pill txn-${status}` }, icon(STATUS_ICON[status]), STATUS_LABELS[status]);
}

export function methodIcon(method: TxnMethod, className = "icon"): SVGElement | Comment {
  return icon(METHOD_ICON[method], className);
}

/** "UPI", "Card · Visa ··1111", "Netbanking · HDFC Bank". */
export function methodText(t: Pick<Txn, "method" | "methodDetail">): string {
  return t.methodDetail ? `${METHOD_LABELS[t.method]} · ${t.methodDetail}` : METHOD_LABELS[t.method];
}

/** "21 Oct, 4:05 pm" this year, "21 Oct 2025" before. */
export function txnDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return d.getFullYear() === now.getFullYear() ? `${dayMonth(d)}, ${time(d)}` : fullDate(d);
}

/** What a Refund button does in the demo: it says so, and nothing else happens. */
export const REFUND_NOTICE = "Refunds work in the real version (Razorpay)";

export function refundNotice(): void {
  toast(REFUND_NOTICE, "info", 6000);
}

/** The Refund button for a captured payment. Its accessible name says which payment. */
export function refundButton(t: Pick<Txn, "id" | "studentName">, extraClass = ""): HTMLButtonElement {
  return h(
    "button",
    { type: "button", class: `btn btn-secondary btn-sm txn-refund ${extraClass}`.trim(), "data-refund": t.id },
    icon("arrow-counter-clockwise"),
    "Refund",
    h("span", { class: "visually-hidden", text: ` ${t.id} for ${t.studentName}` }),
  );
}
