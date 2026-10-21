/**
 * /admin/payments (DEMO): the example test transactions from src/lib/demo-store-students.ts, with
 * totals (this month, all time), a status filter, search and "Show more". Refund only says that
 * refunds work in the real version.
 *
 * The filters live in the URL (?status=, ?q=), so the student drawer can link to one payment
 * (?q=pay_…). ?preview=empty shows the screen as it looks before the first payment.
 */
import { $, $$, fill, h, icon, ready } from "../client/dom";
import { fullDate, inr, num, plural } from "../client/format";
import { getTxns, STATUS_LABELS, txnTotals, type Txn, type TxnStatus } from "../../../lib/demo-store-students";
import { methodIcon, methodText, refundButton, refundNotice, statusPill, txnDate } from "./txn-ui";

const PAGE = 25;
const STATUSES: TxnStatus[] = ["captured", "failed", "refunded"];

const params = new URLSearchParams(location.search);
const preview = params.get("preview") === "empty";
let txns: Txn[] = [];
let matches: Txn[] = [];
const state = {
  q: (params.get("q") ?? "").slice(0, 80),
  status: STATUSES.includes(params.get("status") as TxnStatus) ? (params.get("status") as TxnStatus) : ("" as TxnStatus | ""),
  shown: PAGE,
};

const norm = (text: string) => text.toLowerCase().normalize("NFKD").replace(/\s+/g, " ").trim();
const hidden = (text: string) => h("span", { class: "visually-hidden", text });
const filtersOn = () => Boolean(state.q || state.status);

function filterTxns(): Txn[] {
  const q = norm(state.q);
  return txns.filter((t) => {
    if (state.status && t.status !== state.status) return false;
    if (!q) return true;
    return [t.studentName, t.id, t.courseTitle, t.method, t.methodDetail, t.coupon ?? ""].some((v) => norm(v).includes(q));
  });
}

function syncUrl(): void {
  const next = new URLSearchParams();
  if (preview) next.set("preview", "empty");
  if (state.status) next.set("status", state.status);
  if (state.q) next.set("q", state.q);
  const query = next.toString();
  try {
    history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}`);
  } catch {
    /* the filters still work without the URL */
  }
}

// ── Rendering ─────────────────────────────────────────────────────────

function note(t: Txn): string | null {
  if (t.status === "failed") return t.reason;
  if (t.status === "refunded" && t.refundedAt) return `Refunded on ${fullDate(new Date(t.refundedAt))}`;
  if (t.coupon) return `Coupon ${t.coupon}`;
  return null;
}

function rowEl(t: Txn): HTMLLIElement {
  const text = note(t);
  return h(
    "li",
    { class: `pay-row is-${t.status}` },
    h("span", { class: "pay-ic", "aria-hidden": "true" }, methodIcon(t.method)),
    h(
      "span",
      { class: "pay-who" },
      t.studentId
        ? h("a", { class: "pay-name", href: `/admin/students?id=${encodeURIComponent(t.studentId)}` }, t.studentName)
        : h("span", { class: "pay-name", text: t.studentName }),
    ),
    h("span", { class: "pay-course" }, hidden("Course: "), t.courseTitle),
    h("span", { class: "pay-id txn-id" }, hidden("Payment id "), t.id),
    h("span", { class: "pay-method" }, hidden("Method: "), methodText(t)),
    h("span", { class: "pay-date" }, h("time", { datetime: t.at, text: txnDate(t.at) })),
    h("span", { class: "pay-status" }, hidden("Status: "), statusPill(t.status)),
    h("span", { class: "pay-amt num" }, hidden("Amount "), inr(t.amount)),
    text ? h("span", { class: "pay-note" }, text) : null,
    t.status === "captured" ? h("span", { class: "pay-act" }, refundButton(t)) : null,
  );
}

function renderTotals(): void {
  const totals = txnTotals(txns);
  const set = (key: string, value: string) => {
    const el = $(`[data-t="${key}"]`);
    if (el) el.textContent = value;
  };
  set("month", inr(totals.month.amount));
  set("month-label", `This month · ${totals.month.label}`);
  set("month-meta", totals.month.count ? `${plural(totals.month.count, "captured payment")}` : "No payments yet this month");
  set("all", inr(totals.all.amount));
  set(
    "all-meta",
    totals.all.since
      ? `${plural(totals.all.count, "captured payment")} since ${fullDate(new Date(totals.all.since))}`
      : "No payments yet",
  );
  const extra = [
    totals.refunded.count ? `${inr(totals.refunded.amount)} refunded` : null,
    totals.failed ? `${plural(totals.failed, "failed attempt")}` : null,
  ].filter(Boolean);
  set("all-extra", extra.length ? `Not counted: ${extra.join(", ")}` : "");
}

function renderSegments(): void {
  for (const button of $$<HTMLButtonElement>("[data-status]")) {
    button.setAttribute("aria-pressed", String((button.dataset.status ?? "") === state.status));
  }
}

function emptyState(): HTMLElement {
  return h(
    "div",
    { class: "empty pay-empty" },
    icon("receipt"),
    h("strong", { text: "No payments yet" }),
    h("p", { text: "When someone pays for a course, the payment shows up here with its status and method." }),
  );
}

function noResults(): HTMLElement {
  const label = state.status ? `${STATUS_LABELS[state.status].toLowerCase()} payments` : "payments";
  const what = state.q ? `No ${label} match “${state.q}”` : `No ${label} yet`;
  return h(
    "div",
    { class: "empty pay-empty" },
    icon("magnifying-glass"),
    h("strong", { text: what }),
    h("p", { text: "Search by student name, payment id (pay_…), method or coupon code." }),
    h("button", { type: "button", class: "btn btn-secondary", dataset: { clear: "" } }, "Show all payments"),
  );
}

let announceTimer = 0;
function announce(text: string): void {
  window.clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    const live = $("[data-live]");
    if (live) live.textContent = text;
  }, 450);
}

function render(focusFrom = -1): void {
  const list = $<HTMLUListElement>("[data-list]");
  const states = $("[data-states]");
  const more = $<HTMLButtonElement>("[data-more]");
  const count = $("[data-count]");
  if (!list || !states || !more || !count) return;

  matches = filterTxns();
  const shown = Math.min(state.shown, matches.length);
  document.body.classList.toggle("pay-is-empty", txns.length === 0);
  $("[data-clear-top]")?.toggleAttribute("hidden", !filtersOn());
  renderSegments();

  if (txns.length === 0) {
    fill(list);
    fill(states, emptyState());
    count.textContent = "No payments yet";
  } else if (matches.length === 0) {
    fill(list);
    fill(states, noResults());
    count.textContent = "No matches";
  } else {
    fill(states);
    fill(list, matches.slice(0, shown).map(rowEl));
    const noun = state.status ? `${STATUS_LABELS[state.status].toLowerCase()} payment` : "test payment";
    count.textContent =
      shown < matches.length ? `Showing ${num(shown)} of ${plural(matches.length, noun)}` : plural(matches.length, noun);
  }
  list.removeAttribute("aria-busy");

  const left = matches.length - shown;
  more.hidden = left <= 0;
  more.textContent = `Show ${num(Math.min(PAGE, left))} more`;

  if (focusFrom >= 0) {
    const row = list.children[focusFrom] as HTMLElement | undefined;
    const target = row?.querySelector<HTMLElement>("a, button");
    if (target) target.focus();
    else if (row) {
      row.tabIndex = -1;
      row.focus();
    }
  }
}

function update(): void {
  state.shown = PAGE;
  render();
  syncUrl();
  announce(matches.length ? `${plural(matches.length, "payment")} shown.` : "No payments match.");
}

function clearFilters(): void {
  state.q = "";
  state.status = "";
  const q = $<HTMLInputElement>("#pay-q");
  if (q) q.value = "";
  update();
  q?.focus();
}

// ── Start ─────────────────────────────────────────────────────────────

ready(() => {
  txns = preview ? [] : getTxns();
  renderTotals();

  const q = $<HTMLInputElement>("#pay-q");
  if (q) q.value = state.q;
  q?.addEventListener("input", () => {
    state.q = q.value.slice(0, 80);
    update();
  });
  q?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && q.value) {
      q.value = "";
      state.q = "";
      update();
    }
  });

  for (const button of $$<HTMLButtonElement>("[data-status]")) {
    button.addEventListener("click", () => {
      state.status = (button.dataset.status ?? "") as TxnStatus | "";
      update();
    });
  }

  $("[data-more]")?.addEventListener("click", () => {
    const from = state.shown;
    state.shown += PAGE;
    render(from);
  });

  document.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    if (target.closest("[data-refund]")) refundNotice();
    else if (target.closest("[data-clear], [data-clear-top]")) clearFilters();
  });

  render();
  syncUrl();
});
