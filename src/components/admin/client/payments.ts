/**
 * Payments: orders list with filters, CSV export, the order drawer (refund, re-check with Razorpay),
 * and Razorpay events with Replay. Refund, sync and replay run W2's code (refundOrder, syncOrder,
 * processWebhookEvent) through the admin API; W2 enforces the 24-hour window and the key mode again.
 */
import type { AdminOrdersQuery, Page } from "../../../shared/api";
import type { AdminOrder, OrderStatus, WebhookEventRow } from "../../../shared/types";
import { admin, asApiError } from "./api";
import { fillCourseSelect } from "./course-options";
import { $, fill, h, icon, ready } from "./dom";
import { field, input, setErrors, switchRow, textarea } from "./fields";
import { emptyBox, errorBox, loadInto, skeleton } from "./states";
import { busy, confirmDialog, formDialog, nextId, toast } from "./ui";
import { describeError } from "../lib/errors";
import { csvHref, hasFilters, pageInfo, readOrderFilters, toSearch } from "../lib/filters";
import { formatPaise } from "../lib/money";
import { ORDER_STATUS_LABELS, methodLabel, razorpayPaymentUrl, readRefundForm, refundState } from "../lib/orders";
import { ago, istDateTime, unixNow } from "../lib/time";

let filters: AdminOrdersQuery = {};

function statusPill(s: OrderStatus): HTMLElement {
  return h("span", { class: s === "paid" ? "pill pill-live" : s === "failed" ? "pill pill-bad" : "pill", text: ORDER_STATUS_LABELS[s] });
}

// ---------------------------------------------------------------- list

function rowFor(o: AdminOrder): HTMLElement {
  return h(
    "tr",
    null,
    h(
      "td",
      { class: "dt-main" },
      h(
        "button",
        { type: "button", class: "dt-row-btn", onClick: () => void openOrder(o.id) },
        h("span", { text: o.studentName ?? "Erased student" }),
        h("span", { class: "dt-sub", text: `${o.courseTitle}${o.couponCode ? ` · ${o.couponCode}` : ""}${o.mode === "test" ? " · test" : ""}` }),
      ),
    ),
    h("td", { class: "num amount-strong", dataset: { label: "Amount" } }, formatPaise(o.amountPaise), o.refundedPaise ? h("span", { class: "dt-sub", text: ` (−${formatPaise(o.refundedPaise)})` }) : null),
    h("td", { dataset: { label: "Status" } }, statusPill(o.status)),
    h("td", { dataset: { label: "Method" }, text: methodLabel(o.method) }),
    h("td", { dataset: { label: "Date" }, text: istDateTime(o.paidAt ?? o.createdAt) }),
  );
}

function renderList(data: Page<AdminOrder>): void {
  const region = $("[data-region]")!;
  const pager = $("[data-pager]")!;
  const info = pageInfo(data.page, data.pageSize, data.total);
  if (!data.items.length) {
    pager.hidden = true;
    fill(
      region,
      hasFilters(filters)
        ? emptyBox({ icon: "receipt", title: "No payments match", text: "Try another status, course or dates.", action: h("button", { type: "button", class: "btn btn-secondary", onClick: clearFilters }, "Clear filters") })
        : emptyBox({ icon: "receipt", title: "No payments yet", text: "Payments show here as soon as someone checks out." }),
    );
    return;
  }
  fill(
    region,
    h(
      "table",
      { class: "dt" },
      h("caption", { class: "visually-hidden", text: `Payments, ${info.label}` }),
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { scope: "col", text: "Student and course" }),
          h("th", { scope: "col", class: "num", text: "Amount" }),
          h("th", { scope: "col", text: "Status" }),
          h("th", { scope: "col", text: "Method" }),
          h("th", { scope: "col", text: "Date" }),
        ),
      ),
      h("tbody", null, data.items.map(rowFor)),
    ),
  );
  pager.hidden = info.pages <= 1;
  const label = $("[data-page-label]");
  if (label) label.textContent = info.label;
  const prev = $<HTMLButtonElement>("[data-prev]");
  const next = $<HTMLButtonElement>("[data-next]");
  if (prev) prev.disabled = !info.hasPrev;
  if (next) next.disabled = !info.hasNext;
}

function syncUrl(): void {
  const open = new URLSearchParams(location.search).get("open");
  history.replaceState(null, "", `/admin/payments${toSearch({ ...filters, open: open ?? undefined })}`);
  const exp = $<HTMLAnchorElement>("[data-export]");
  if (exp) exp.href = csvHref("/api/admin/orders.csv", filters);
  const clear = $("[data-clear]");
  if (clear) clear.hidden = !hasFilters(filters);
}

function loadList(): void {
  const err = $("[data-filter-err]");
  if (filters.from && filters.to && filters.to < filters.from) {
    if (err) err.textContent = "The “To” date is before the “From” date.";
    return;
  }
  if (err) err.textContent = "";
  syncUrl();
  void loadInto($("[data-region]")!, () => admin("GET /api/admin/orders", {}, filters), renderList, { what: "the payments", rows: 5 });
}

function clearFilters(): void {
  filters = {};
  for (const sel of ["[data-status]", "[data-course]", "[data-from]", "[data-to]"]) {
    const el = $<HTMLInputElement | HTMLSelectElement>(sel);
    if (el) el.value = "";
  }
  loadList();
}

// ---------------------------------------------------------------- order drawer

let drawer: HTMLDialogElement | null = null;

function setOpenParam(id: number | null): void {
  const p = new URLSearchParams(location.search);
  if (id === null) p.delete("open");
  else p.set("open", String(id));
  const s = p.toString();
  history.replaceState(null, "", `/admin/payments${s ? `?${s}` : ""}`);
}

async function openOrder(id: number): Promise<void> {
  if (!drawer) {
    const titleId = nextId("ord");
    drawer = h(
      "dialog",
      { class: "drawer", "aria-labelledby": titleId },
      h(
        "div",
        { class: "drawer-head" },
        h("h2", { class: "dlg-title drawer-title", id: titleId, text: "Payment" }),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: () => drawer?.close() }, icon("close")),
      ),
      h("div", { class: "drawer-body", dataset: { drawerBody: "" } }),
    );
    drawer.addEventListener("close", () => {
      setOpenParam(null);
      drawer?.remove();
      drawer = null;
    });
    drawer.addEventListener("click", (e) => {
      if (e.target === drawer) drawer?.close();
    });
    document.body.append(drawer);
    drawer.showModal();
  }
  setOpenParam(id);
  const body = drawer.querySelector<HTMLElement>("[data-drawer-body]")!;
  fill(body, skeleton(4));
  try {
    renderOrder(await admin("GET /api/admin/orders/:id", { id }));
  } catch (err) {
    fill(body, errorBox(err, { what: "this payment", retry: () => void openOrder(id) }));
  }
}

function renderOrder(o: AdminOrder): void {
  if (!drawer) return;
  const title = drawer.querySelector(".drawer-title");
  if (title) title.textContent = `${formatPaise(o.amountPaise)} · ${ORDER_STATUS_LABELS[o.status]}`;
  const body = drawer.querySelector<HTMLElement>("[data-drawer-body]")!;
  const now = unixNow();
  const r = refundState(o, now);
  const kv = (label: string, value: Node | string | null) => (value === null ? [] : [h("dt", { text: label }), h("dd", null, value)]);
  const refundBtn = h("button", { type: "button", class: "btn btn-primary btn-sm", onClick: () => refundDialog(o) }, icon("arrow-counter-clockwise"), "Refund");
  const syncBtn = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, icon("arrow-counter-clockwise"), "Re-check with Razorpay");
  syncBtn.addEventListener("click", () =>
    void busy(syncBtn, async () => {
      try {
        const fresh = await admin("POST /api/admin/orders/:id/sync", { id: o.id });
        toast("Up to date with Razorpay.");
        renderOrder(fresh);
        loadList();
      } catch (err) {
        toast(describeError(asApiError(err)).message, describeError(asApiError(err)).kind === "coming" ? "info" : "error");
      }
    }),
  );

  fill(
    body,
    h(
      "section",
      { class: "drawer-section" },
      h(
        "dl",
        { class: "kv" },
        ...kv("Student", h("a", { class: "link-btn", href: `/admin/students?open=${o.studentId}` }, o.studentName ?? "Erased student", icon("arrow-right"))),
        ...kv("Phone", o.studentPhoneMasked),
        ...kv("Course", o.courseTitle),
        ...kv("Status", statusPill(o.status)),
        ...kv("Mode", o.mode === "test" ? "Test (no real money)" : "Live"),
        ...kv("Invoice no.", o.invoiceNo),
        ...kv("Created", istDateTime(o.createdAt)),
        ...kv("Paid", o.paidAt ? istDateTime(o.paidAt) : null),
        ...kv("Method", methodLabel(o.method)),
        ...kv("Failure", o.failureReason),
      ),
    ),
    h(
      "section",
      { class: "drawer-section" },
      h("h3", { class: "section-title", text: "Amount" }),
      h(
        "dl",
        { class: "kv" },
        ...kv("Price", formatPaise(o.listPricePaise)),
        ...(o.discountPaise ? kv(`Discount${o.couponCode ? ` (${o.couponCode})` : ""}`, `−${formatPaise(o.discountPaise)}`) : []),
        ...kv(o.paymentKind === "deposit" ? "Paid (booking amount)" : "Paid", h("strong", { text: formatPaise(o.amountPaise) })),
        ...(o.refundedPaise ? kv("Refunded", `−${formatPaise(o.refundedPaise)}`) : []),
      ),
    ),
    o.refunds.length
      ? h(
          "section",
          { class: "drawer-section" },
          h("h3", { class: "section-title", text: "Refunds" }),
          h(
            "ul",
            { class: "sub-list" },
            o.refunds.map((rf) =>
              h(
                "li",
                { class: "sub-item" },
                h(
                  "div",
                  { class: "sub-item-head" },
                  h("strong", { text: formatPaise(rf.amountPaise) }),
                  h("span", { class: rf.status === "processed" ? "pill pill-live" : rf.status === "failed" ? "pill pill-bad" : "pill pill-wait", text: rf.status === "processed" ? "Refunded" : rf.status === "failed" ? "Failed" : "On its way" }),
                ),
                h("span", { class: "dt-sub", text: `${istDateTime(rf.createdAt)}${rf.reason ? ` · ${rf.reason}` : ""}${rf.revokeAccess ? " · access ended" : ""}` }),
              ),
            ),
          ),
        )
      : null,
    h(
      "section",
      { class: "drawer-section" },
      h("h3", { class: "section-title", text: "Refund" }),
      r.can
        ? h("p", { class: "refund-window" }, icon("clock"), `Refundable for ${r.left} more (until ${istDateTime(r.until)}). Up to ${formatPaise(r.remaining)}.`)
        : h("p", { class: "field-hint", text: r.reason }),
      h("div", { class: "btn-row" }, r.can ? refundBtn : null, o.razorpayPaymentId || o.razorpayOrderId ? syncBtn : null),
    ),
    o.razorpayPaymentId || o.razorpayOrderId
      ? h(
          "section",
          { class: "drawer-section" },
          h("h3", { class: "section-title", text: "Razorpay" }),
          h(
            "dl",
            { class: "kv" },
            ...kv("Payment id", o.razorpayPaymentId ? h("code", { text: o.razorpayPaymentId }) : null),
            ...kv("Order id", o.razorpayOrderId ? h("code", { text: o.razorpayOrderId }) : null),
          ),
          o.razorpayPaymentId
            ? h("a", { class: "link-btn", href: razorpayPaymentUrl(o.razorpayPaymentId), target: "_blank", rel: "noopener" }, "Open in Razorpay", icon("arrow-square-out"))
            : null,
        )
      : null,
  );
}

function refundDialog(o: AdminOrder): void {
  const now = unixNow();
  const state = refundState(o, now);
  if (!state.can) {
    toast(state.reason, "info");
    return;
  }
  const amount = input({ inputmode: "decimal", placeholder: String(state.remaining / 100), dataset: { field: "amountPaise" } });
  const reason = textarea({ rows: 2, maxlength: 300, placeholder: "Asked within 24 hours, couldn't attend", dataset: { field: "reason" } });
  const revoke = switchRow({ label: "End their access too", hint: "Usually yes for a full refund. Off: they keep the course.", checked: true });
  amount.addEventListener("input", () => {
    const partial = amount.value.trim() !== "" && amount.value.trim() !== String(state.remaining / 100);
    revoke.input.checked = !partial;
  });
  formDialog({
    title: `Refund ${o.studentName ?? "this payment"}`,
    intro: `Up to ${formatPaise(state.remaining)} can be refunded, for ${state.left} more. Razorpay returns it to the same card or UPI in 5–7 working days.`,
    submit: "Refund",
    danger: true,
    body: [
      field({ label: "Amount", control: amount, affix: "₹", optional: true, hint: `Empty: the full ${formatPaise(state.remaining)}.` }),
      field({ label: "Reason", control: reason, hint: "Kept in the activity log." }),
      revoke.row,
    ],
    onSubmit: async (d) => {
      const r = readRefundForm(amount.value, reason.value, state.remaining);
      if (!r.ok) {
        setErrors(d.form, r.errors);
        return false;
      }
      const sure = await confirmDialog({
        title: `Refund ${r.amountPaise === undefined ? formatPaise(state.remaining) : formatPaise(r.amountPaise)}?`,
        body: `Money goes back to ${o.studentName ?? "the student"}${revoke.input.checked ? " and their access ends" : ""}. This can't be undone.`,
        confirm: "Yes, refund",
        danger: true,
      });
      if (!sure) return false;
      try {
        await admin("POST /api/admin/orders/:id/refund", { id: o.id }, { ...(r.amountPaise !== undefined ? { amountPaise: r.amountPaise } : {}), reason: r.reason, revoke: revoke.input.checked });
        toast("Refund started. Razorpay confirms it in a few minutes.");
        void openOrder(o.id);
        loadList();
        return true;
      } catch (err) {
        const e = asApiError(err);
        setErrors(d.form, e.fields);
        d.setMessage(describeError(e).message);
        return false;
      }
    },
  });
}

// ---------------------------------------------------------------- Razorpay events

function renderWebhooks(rows: WebhookEventRow[]): void {
  const root = $("[data-webhooks]")!;
  if (!rows.length) {
    fill(root, emptyBox({ icon: "check-circle", title: ($<HTMLInputElement>("[data-pending]")?.checked ? "Nothing waiting" : "No events yet"), text: "Razorpay sends one when a payment or refund changes." }));
    return;
  }
  const now = unixNow();
  fill(
    root,
    h(
      "table",
      { class: "dt" },
      h("caption", { class: "visually-hidden", text: "Razorpay events, newest first" }),
      h("thead", null, h("tr", null, h("th", { scope: "col", text: "Event" }), h("th", { scope: "col", text: "Received" }), h("th", { scope: "col", text: "Result" }), h("th", { scope: "col" }, h("span", { class: "visually-hidden", text: "Actions" })))),
      h(
        "tbody",
        null,
        rows.map((w) => {
          const replay = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, icon("arrow-counter-clockwise"), "Replay");
          replay.addEventListener("click", async () => {
            const ok = await confirmDialog({ title: "Replay this event?", body: `The site processes “${w.type}” again. Safe to repeat: a payment is never counted twice.`, confirm: "Replay" });
            if (!ok) return;
            await busy(replay, async () => {
              try {
                await admin("POST /api/admin/webhooks/:id/replay", { id: w.eventId });
                toast("Event processed again.");
                loadWebhooks();
                loadList();
              } catch (err) {
                const view = describeError(asApiError(err));
                toast(view.message, view.kind === "coming" ? "info" : "error");
              }
            });
          });
          return h(
            "tr",
            null,
            h("td", { class: "dt-main" }, h("span", { class: "dt-row-btn", text: w.type }), h("span", { class: "dt-sub mono", text: `${w.eventId}${w.mode === "test" ? " · test" : ""}` })),
            h("td", { dataset: { label: "Received" }, text: ago(w.receivedAt, now) }),
            h(
              "td",
              { dataset: { label: "Result" } },
              w.error ? h("span", { class: "wh-err", text: w.error }) : w.processedAt ? h("span", { class: "pill pill-live", text: "Done" }) : h("span", { class: "pill pill-wait", text: "Waiting" }),
            ),
            h("td", null, w.error || !w.processedAt ? replay : null),
          );
        }),
      ),
    ),
  );
}

function loadWebhooks(): void {
  const pending = $<HTMLInputElement>("[data-pending]")?.checked;
  void loadInto($("[data-webhooks]")!, () => admin("GET /api/admin/webhooks", {}, pending ? { pending: 1 } : {}), renderWebhooks, { what: "the Razorpay events", rows: 3 });
}

// ---------------------------------------------------------------- start

ready(() => {
  filters = readOrderFilters(location.search);
  const status = $<HTMLSelectElement>("[data-status]");
  const course = $<HTMLSelectElement>("[data-course]");
  const from = $<HTMLInputElement>("[data-from]");
  const to = $<HTMLInputElement>("[data-to]");
  if (status) status.value = filters.status ?? "";
  if (from) from.value = filters.from ?? "";
  if (to) to.value = filters.to ?? "";
  if (course) void fillCourseSelect(course, filters.course ?? null);

  $("[data-filters]")?.addEventListener("change", () => {
    filters = {
      status: (status?.value || undefined) as OrderStatus | undefined,
      course: course?.value ? Number(course.value) : undefined,
      from: from?.value || undefined,
      to: to?.value || undefined,
      page: undefined,
    };
    loadList();
  });
  $("[data-filters]")?.addEventListener("submit", (e) => e.preventDefault());
  $("[data-clear]")?.addEventListener("click", clearFilters);
  $("[data-prev]")?.addEventListener("click", () => {
    filters = { ...filters, page: Math.max(1, (filters.page ?? 1) - 1) };
    loadList();
  });
  $("[data-next]")?.addEventListener("click", () => {
    filters = { ...filters, page: (filters.page ?? 1) + 1 };
    loadList();
  });
  $("[data-pending]")?.addEventListener("change", loadWebhooks);

  loadList();
  loadWebhooks();
  const open = Number(new URLSearchParams(location.search).get("open"));
  if (Number.isInteger(open) && open > 0) void openOrder(open);
});
