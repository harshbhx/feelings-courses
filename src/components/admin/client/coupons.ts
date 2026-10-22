/** Coupons: list, on/off switch, the coupon drawer (create and edit), delete. */
import type { AdminCoupon, AdminCourse } from "../../../shared/types";
import { admin, asApiError } from "./api";
import { courses } from "./course-options";
import { $, $$, fill, h, icon, ready } from "./dom";
import { field, input, select, setErrors, switchRow } from "./fields";
import { emptyBox, loadInto } from "./states";
import { busy, confirmDialog, copyText, formDialog, nextId, toast } from "./ui";
import { COUPON_STATE_LABELS, blankCouponForm, couponChanges, couponForm, couponInput, couponState, discountLabel, usesLabel, type CouponFormValues } from "../lib/coupons";
import { describeError } from "../lib/errors";
import { istDateTime, unixNow } from "../lib/time";

type Filter = "all" | "active" | "stopped";

let list: AdminCoupon[] = [];
let courseList: AdminCourse[] = [];
let filter: Filter = "all";

const courseName = (id: number | null) => (id === null ? "Any course" : (courseList.find((c) => c.id === id)?.title ?? `Course ${id}`));

function when(c: AdminCoupon): string {
  const parts: string[] = [];
  if (c.startsAt) parts.push(`from ${istDateTime(c.startsAt)}`);
  if (c.expiresAt) parts.push(`until ${istDateTime(c.expiresAt)}`);
  return parts.length ? parts.join(" ") : "No end date";
}

function row(c: AdminCoupon): HTMLElement {
  const now = unixNow();
  const state = couponState(c, now);
  const toggleId = nextId("on");
  const toggle = h("input", { type: "checkbox", role: "switch", id: toggleId, checked: c.active, "aria-label": `${c.code} on` });
  toggle.addEventListener("change", async () => {
    toggle.disabled = true;
    try {
      const updated = await admin("PUT /api/admin/coupons/:id", { id: c.id }, { active: toggle.checked } as never);
      list = list.map((x) => (x.id === c.id ? updated : x));
      toast(updated.active ? `${c.code} is on.` : `${c.code} is off.`);
      render();
    } catch (err) {
      toggle.checked = !toggle.checked;
      toast(describeError(asApiError(err)).message, "error");
    } finally {
      toggle.disabled = false;
    }
  });
  return h(
    "tr",
    null,
    h(
      "td",
      { class: "dt-main" },
      h("span", { class: "cpn-code" }, icon("ticket"), c.code, h("button", { type: "button", class: "icon-btn", "aria-label": `Copy ${c.code}`, onClick: () => void copyText(c.code, `${c.code} copied`) }, icon("copy"))),
      h("span", { class: "dt-sub", text: `${discountLabel(c)} · ${courseName(c.courseId)}${c.allowFree ? " · enrolls free" : ""}` }),
    ),
    h("td", { dataset: { label: "Uses" }, class: "num", text: usesLabel(c) }),
    h("td", { dataset: { label: "Dates" }, text: when(c) }),
    h("td", { dataset: { label: "Status" } }, h("span", { class: state === "active" ? "pill pill-live" : state === "scheduled" ? "pill pill-wait" : "pill", text: COUPON_STATE_LABELS[state] })),
    h("td", null, h("span", { class: "cpn-on" }, h("label", { class: "switch" }, toggle, h("span", { class: "switch-track" })))),
    h(
      "td",
      { class: "cpn-actions" },
      h("button", { type: "button", class: "btn btn-secondary btn-sm", "aria-label": `Edit ${c.code}`, onClick: () => couponDrawer(c) }, icon("pencil-simple"), "Edit"),
      c.usedCount === 0 ? h("button", { type: "button", class: "icon-btn", "aria-label": `Delete ${c.code}`, onClick: (e: Event) => void remove(c, e.currentTarget as HTMLButtonElement) }, icon("trash")) : null,
    ),
  );
}

function render(): void {
  const region = $("[data-region]")!;
  const now = unixNow();
  const running = list.filter((c) => couponState(c, now) === "active" || couponState(c, now) === "scheduled");
  const counts: Record<Filter, number> = { all: list.length, active: running.length, stopped: list.length - running.length };
  for (const k of Object.keys(counts) as Filter[]) {
    const el = $(`[data-n="${k}"]`);
    if (el) el.textContent = `(${counts[k]})`;
  }
  const shown = filter === "all" ? list : filter === "active" ? running : list.filter((c) => !running.includes(c));
  if (!list.length) {
    fill(
      region,
      emptyBox({
        icon: "ticket",
        title: "No coupons yet",
        text: "Make a code like REEL15 for a reel's caption, or one per collaborator.",
        action: h("button", { type: "button", class: "btn btn-primary", onClick: () => couponDrawer(null) }, icon("plus"), "New coupon"),
      }),
    );
    return;
  }
  if (!shown.length) {
    fill(region, emptyBox({ icon: "ticket", title: filter === "active" ? "No codes running" : "No stopped codes" }));
    return;
  }
  fill(
    region,
    h(
      "table",
      { class: "dt" },
      h("caption", { class: "visually-hidden", text: "Coupons" }),
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { scope: "col", text: "Code" }),
          h("th", { scope: "col", class: "num", text: "Uses" }),
          h("th", { scope: "col", text: "Dates (India time)" }),
          h("th", { scope: "col", text: "Status" }),
          h("th", { scope: "col", text: "On" }),
          h("th", { scope: "col" }, h("span", { class: "visually-hidden", text: "Actions" })),
        ),
      ),
      h("tbody", null, shown.map(row)),
    ),
  );
}

async function remove(c: AdminCoupon, button: HTMLButtonElement): Promise<void> {
  const ok = await confirmDialog({ title: `Delete ${c.code}?`, body: "Nobody has used it, so it can be deleted. People who saved the code can't use it any more.", confirm: "Delete", danger: true });
  if (!ok) return;
  await busy(button, async () => {
    try {
      await admin("DELETE /api/admin/coupons/:id", { id: c.id });
      list = list.filter((x) => x.id !== c.id);
      toast(`${c.code} deleted.`);
      render();
    } catch (err) {
      toast(describeError(asApiError(err)).message, "error");
    }
  });
}

function couponDrawer(saved: AdminCoupon | null): void {
  const v: CouponFormValues = saved ? couponForm(saved) : blankCouponForm();
  const code = input({ value: v.code, maxlength: 32, autocapitalize: "characters", spellcheck: "false", placeholder: "REEL15", dataset: { field: "code" } });
  if (saved && saved.usedCount > 0) code.readOnly = true;
  code.addEventListener("input", () => {
    const at = code.selectionStart;
    code.value = code.value.toUpperCase().replace(/\s+/g, "");
    if (at !== null) code.setSelectionRange(at, at);
  });
  const kindName = nextId("kind");
  const kind = h(
    "fieldset",
    { class: "field" },
    h("legend", { class: "field-label", text: "Discount" }),
    h(
      "div",
      { class: "choice-grid cols-2" },
      h("label", { class: "choice" }, h("input", { type: "radio", name: kindName, value: "percent", checked: v.kind === "percent" }), h("strong", { text: "Percent off" }), h("span", { text: "e.g. 15% off" })),
      h("label", { class: "choice" }, h("input", { type: "radio", name: kindName, value: "amount", checked: v.kind === "amount" }), h("strong", { text: "Rupees off" }), h("span", { text: "e.g. ₹500 off" })),
    ),
  );
  const value = input({ value: v.value, inputmode: "decimal", dataset: { field: "percentOff" } });
  const valueField = field({ label: "How much", control: value });
  const syncKind = () => {
    const k = kind.querySelector<HTMLInputElement>("input:checked")?.value;
    value.dataset.field = k === "percent" ? "percentOff" : "amountOffPaise";
    value.placeholder = k === "percent" ? "15" : "500";
    const label = valueField.querySelector(".field-label");
    if (label) label.textContent = k === "percent" ? "Percent off (1 to 100)" : "Rupees off";
    syncFree();
  };
  const courseSelect = select([{ value: "", label: "Any course" }, ...courseList.filter((c) => c.status !== "archived" || String(c.id) === v.courseId).map((c) => ({ value: String(c.id), label: c.title }))], v.courseId, { dataset: { field: "courseId" } });
  const maxUses = input({ value: v.maxUses, inputmode: "numeric", placeholder: "No limit", dataset: { field: "maxUses" } });
  const startsAt = input({ type: "datetime-local", value: v.startsAt, dataset: { field: "startsAt" } });
  const expiresAt = input({ type: "datetime-local", value: v.expiresAt, dataset: { field: "expiresAt" } });
  const active = switchRow({ label: "On", hint: "Off: the code is refused at checkout.", checked: v.active, name: "active" });
  const free = switchRow({ label: "Let a 100% code enroll without paying", hint: "Off: checkout always charges at least ₹1, so a payment proves the phone number.", checked: v.allowFree, name: "allowFree" });
  const freeWrap = h("div", null, free.row);
  const syncFree = () => {
    freeWrap.hidden = !(kind.querySelector<HTMLInputElement>("input:checked")?.value === "percent" && value.value.trim().replace(/%$/, "") === "100");
  };
  kind.addEventListener("change", syncKind);
  value.addEventListener("input", syncFree);
  syncKind();

  formDialog({
    title: saved ? `Edit ${saved.code}` : "New coupon",
    drawer: true,
    submit: saved ? "Save coupon" : "Create coupon",
    body: [
      field({ label: "Code", control: code, hint: saved && saved.usedCount > 0 ? "Used already, so the code can't change." : "Letters, digits, - and _. Customers type it at checkout." }),
      kind,
      valueField,
      field({ label: "Course", control: courseSelect }),
      field({ label: "Limit", control: maxUses, optional: true, hint: saved ? `Used ${saved.usedCount} times so far.` : "How many times it can be used in total." }),
      h("div", { class: "form-grid cols-2" }, field({ label: "Starts", control: startsAt, optional: true, hint: "India time." }), field({ label: "Ends", control: expiresAt, optional: true, hint: "India time." })),
      active.row,
      freeWrap,
    ],
    onSubmit: async (d) => {
      const values: CouponFormValues = {
        code: code.value,
        kind: (kind.querySelector<HTMLInputElement>("input:checked")?.value ?? "percent") as CouponFormValues["kind"],
        value: value.value,
        courseId: courseSelect.value,
        maxUses: maxUses.value,
        startsAt: startsAt.value,
        expiresAt: expiresAt.value,
        active: active.input.checked,
        allowFree: free.input.checked,
      };
      const r = couponInput(values, saved ?? undefined);
      if (!r.ok) {
        setErrors(d.form, r.errors);
        return false;
      }
      try {
        if (saved) {
          const changes = couponChanges(saved, r.input);
          if (!Object.keys(changes).length) return true;
          const updated = await admin("PUT /api/admin/coupons/:id", { id: saved.id }, changes as never);
          list = list.map((x) => (x.id === saved.id ? updated : x));
          toast(`${updated.code} saved.`);
        } else {
          const created = await admin("POST /api/admin/coupons", {}, r.input);
          list = [created, ...list];
          toast(`${created.code} created.`);
        }
        render();
        return true;
      } catch (err) {
        const e = asApiError(err);
        const fields = { ...e.fields };
        if (e.code === "code_taken" || e.code === "coupon_used") fields.code = e.message;
        const unplaced = setErrors(d.form, fields);
        if (!Object.keys(fields).length || Object.keys(unplaced).length) d.setMessage(describeError(e).message);
        return false;
      }
    },
  });
}

ready(() => {
  for (const b of $$<HTMLButtonElement>("[data-filter]")) {
    b.addEventListener("click", () => {
      filter = b.dataset.filter as Filter;
      for (const x of $$("[data-filter]")) x.setAttribute("aria-pressed", String(x === b));
      render();
    });
  }
  $("[data-new]")?.addEventListener("click", () => couponDrawer(null));
  void loadInto(
    $("[data-region]")!,
    async () => {
      const [coupons, cs] = await Promise.all([admin("GET /api/admin/coupons"), courses().catch(() => [] as AdminCourse[])]);
      return { coupons, cs };
    },
    ({ coupons, cs }) => {
      list = coupons;
      courseList = cs;
      render();
    },
    { what: "your coupons", rows: 4 },
  );
});
