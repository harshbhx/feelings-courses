/**
 * Coupons screen (DEMO): the results strip, the list with on/off switches, the form drawer, copy,
 * edit and delete. Data: src/lib/demo-store.ts (saving) and src/lib/demo-store-coupons.ts (extra
 * fields, uses, revenue and checks).
 */
import { deleteCoupon, fromYmd, getCourses, saveCoupon, ymd, type Course } from "../../../lib/demo-store";
import {
  PERCENT_MAX,
  PERCENT_MIN,
  checkCoupon,
  couponState,
  couponStatsById,
  discountLabel,
  getCouponList,
  nextReelCode,
  normaliseCode,
  priceWith,
  type CouponErrors,
  type CouponField,
  type CouponInput,
  type CouponPlus,
  type CouponState,
  type CouponStats,
  type DiscountKind,
} from "../../../lib/demo-store-coupons";
import { $, $$, fill, h, icon, ready } from "../client/dom";
import { dayMonth, fullDate, inr, num, plural } from "../client/format";
import { confirmDialog, reportSave, toast } from "../client/ui";

type Filter = "all" | "running" | "stopped";

const STATE_LABEL: Record<CouponState, string> = { on: "On", off: "Off", expired: "Expired", "used-up": "Used up" };
const FIELD_ORDER: CouponField[] = ["code", "value", "courseId", "expires", "limit"];
const NO_STATS: CouponStats = { uses: 0, revenue: 0, lastUsed: null };

let coupons: CouponPlus[] = [];
let courses: Course[] = [];
let stats = new Map<string, CouponStats>();
let today = ymd(new Date());
let filter: Filter = "all";

function refresh(): void {
  coupons = getCouponList();
  courses = getCourses();
  stats = couponStatsById(coupons, courses);
  today = ymd(new Date());
}

const statsOf = (c: CouponPlus) => stats.get(c.id) ?? NO_STATS;
const stateOf = (c: CouponPlus) => couponState(c, statsOf(c).uses, today);
const isRunning = (c: CouponPlus) => stateOf(c) === "on";
const courseTitle = (id: string | null) => (id ? (courses.find((c) => c.id === id)?.title ?? "A deleted course") : "All courses");

/** Whole days from today to a YYYY-MM-DD date (negative when it has passed). */
const daysUntil = (date: string) => Math.round((fromYmd(date).getTime() - fromYmd(today).getTime()) / 86400000);

// ── Results strip ────────────────────────────────────────────────────

function setText(key: string, text: string): void {
  const el = $(`[data-k="${key}"]`);
  if (el) el.textContent = text;
}

function topCoupon(): CouponPlus | null {
  let best: CouponPlus | null = null;
  for (const c of coupons) if (statsOf(c).revenue > 0 && (!best || statsOf(c).revenue > statsOf(best).revenue)) best = c;
  return best;
}

function renderResults(): void {
  const revenue = coupons.reduce((n, c) => n + statsOf(c).revenue, 0);
  const uses = coupons.reduce((n, c) => n + statsOf(c).uses, 0);
  const running = coupons.filter(isRunning).length;
  const top = topCoupon();

  setText("revenue", inr(revenue));
  setText("revenue-meta", uses ? `From ${plural(uses, "sale")} with a code` : "No sales with a code yet");
  setText("running", coupons.length ? `${num(running)} of ${num(coupons.length)}` : "0");
  const stopped = coupons.length - running;
  setText("running-meta", stopped ? `${num(stopped)} off, ended or used up` : coupons.length ? "Every code is on" : "No codes yet");
  setText("top", top ? top.code : "None yet");
  setText("top-meta", top ? `${inr(statsOf(top).revenue)} from ${plural(statsOf(top).uses, "sale")}` : "Share a code to see which sells");
}

// ── List ─────────────────────────────────────────────────────────────

function stat(label: string, value: Node | string, ...extra: (Node | null)[]): HTMLElement {
  return h("div", { class: "cpn-stat" }, h("dt", { class: "cell-label", text: label }), h("dd", null, value, ...extra));
}

function usesStat(c: CouponPlus, s: CouponStats): HTMLElement {
  if (c.limit === null) return stat("Uses", h("strong", { text: num(s.uses) }), h("span", { class: "cpn-sub", text: "No limit" }));
  const p = Math.min(100, Math.round((s.uses / c.limit) * 100));
  return stat(
    "Uses",
    h("strong", null, num(s.uses), h("small", { text: ` of ${num(c.limit)}` })),
    h("span", { class: `meter${s.uses >= c.limit ? " is-done" : ""}`, style: `--p: ${p}%`, "aria-hidden": "true" }, h("span")),
  );
}

function revenueStat(s: CouponStats): HTMLElement {
  const sub = s.lastUsed ? `Last sale ${dayMonth(new Date(s.lastUsed))}` : "No sales yet";
  return stat("Revenue", h("strong", { text: inr(s.revenue) }), h("span", { class: "cpn-sub", text: sub }));
}

function lastDayStat(c: CouponPlus): HTMLElement {
  if (!c.expires) return stat("Last day", h("strong", { text: "None" }), h("span", { class: "cpn-sub", text: "Never ends" }));
  const d = daysUntil(c.expires);
  const sub = d < 0 ? `Ended ${plural(-d, "day")} ago` : d === 0 ? "Ends today" : d === 1 ? "Ends tomorrow" : `In ${plural(d, "day")}`;
  return stat(
    "Last day",
    h("strong", { text: fullDate(fromYmd(c.expires)) }),
    h("span", { class: `cpn-sub${d >= 0 && d <= 7 ? " is-soon" : ""}`, text: sub }),
  );
}

function row(c: CouponPlus, topId: string | null): HTMLLIElement {
  const s = statsOf(c);
  const state = stateOf(c);
  const pill = h("span", { class: `pill cpn-state is-${state}${state === "on" ? " pill-live" : ""}`, text: STATE_LABEL[state] });

  const copy = h("button", { type: "button", class: "icon-btn cpn-copy", "aria-label": `Copy ${c.code}`, dataset: { fk: `copy-${c.id}` } }, icon("copy"));
  copy.addEventListener("click", () => copyCode(c.code));

  const toggle = h("input", {
    type: "checkbox",
    role: "switch",
    "aria-label": `Use ${c.code}`,
    checked: c.active,
    dataset: { fk: `toggle-${c.id}` },
  });
  toggle.addEventListener("change", () => setActive(c, toggle.checked));

  const edit = h(
    "button",
    { type: "button", class: "btn btn-ghost cpn-edit", "aria-label": `Edit ${c.code}`, dataset: { fk: `edit-${c.id}` } },
    icon("pencil-simple"),
    h("span", { text: "Edit" }),
  );
  edit.addEventListener("click", () => openForm(c, edit));

  const del = h(
    "button",
    { type: "button", class: "btn btn-ghost cpn-del", "aria-label": `Delete ${c.code}`, dataset: { fk: `delete-${c.id}` } },
    icon("trash"),
    h("span", { text: "Delete" }),
  );
  del.addEventListener("click", () => remove(c));

  return h(
    "li",
    { class: `cpn-row${state === "on" ? "" : " is-stopped"}`, dataset: { id: c.id } },
    h(
      "div",
      { class: "cpn-id" },
      h(
        "div",
        { class: "cpn-codeline" },
        h("span", { class: "cpn-code", text: c.code }),
        copy,
        topId === c.id ? h("span", { class: "cpn-top" }, icon("trend-up"), "Top seller") : null,
      ),
      h(
        "p",
        { class: "cpn-meta" },
        h("span", { class: "cpn-off", text: discountLabel(c) }),
        h("span", { class: "cpn-sep", "aria-hidden": "true", text: "·" }),
        h("span", { class: "cpn-course", text: courseTitle(c.courseId) }),
        pill,
      ),
    ),
    h("dl", { class: "cpn-stats" }, usesStat(c, s), revenueStat(s), lastDayStat(c)),
    h("div", { class: "cpn-toggle" }, h("label", { class: "switch" }, toggle, h("span", { class: "switch-track" }))),
    h("div", { class: "cpn-actions" }, edit, del),
  );
}

function emptyState(): HTMLLIElement {
  if (!coupons.length) {
    const make = h("button", { type: "button", class: "btn btn-secondary", dataset: { fk: "empty-new" } }, icon("plus"), "Make your first code");
    make.addEventListener("click", () => openForm(null, make));
    return h(
      "li",
      { class: "empty cpn-empty" },
      icon("ticket"),
      h("strong", { text: "No coupons yet" }),
      h("p", { text: "Make one code per reel, then watch which one sells." }),
      make,
    );
  }
  const all = h("button", { type: "button", class: "link-btn", dataset: { fk: "show-all" } }, "Show all codes");
  all.addEventListener("click", () => setFilter("all", "show-all"));
  return h(
    "li",
    { class: "empty cpn-empty" },
    icon("ticket"),
    h("strong", { text: filter === "running" ? "No codes running" : "No stopped codes" }),
    h("p", { text: filter === "running" ? "Switch a code on, or make a new one." : "Every code is on and working." }),
    all,
  );
}

function render(opts: { focus?: string; fresh?: string } = {}): void {
  renderResults();
  const list = $("[data-cpn-list]");
  if (!list) return;

  const running = coupons.filter(isRunning);
  const shown = filter === "all" ? coupons : filter === "running" ? running : coupons.filter((c) => !isRunning(c));
  const topId = topCoupon()?.id ?? null;

  fill(list, shown.length ? shown.map((c) => row(c, topId)) : emptyState());
  list.removeAttribute("aria-busy");

  const counts: Record<Filter, number> = { all: coupons.length, running: running.length, stopped: coupons.length - running.length };
  for (const el of $$("[data-n]")) el.textContent = num(counts[el.dataset.n as Filter] ?? 0);
  const count = $("[data-cpn-count]");
  if (count) {
    count.textContent =
      filter === "all" ? plural(coupons.length, "code") : `Showing ${num(shown.length)} of ${plural(coupons.length, "code")}`;
  }
  updateReelButton();

  if (opts.fresh) $(`.cpn-row[data-id="${CSS.escape(opts.fresh)}"]`)?.classList.add("is-fresh");
  if (opts.focus) $<HTMLElement>(`[data-fk="${CSS.escape(opts.focus)}"]`)?.focus();
}

function setFilter(next: Filter, focus?: string): void {
  filter = next;
  for (const b of $$<HTMLButtonElement>("[data-cpn-filter]")) b.setAttribute("aria-pressed", String(b.dataset.cpnFilter === next));
  render();
  if (focus) $<HTMLButtonElement>(`[data-cpn-filter="${next}"]`)?.focus();
}

function updateReelButton(): void {
  const label = $("[data-cpn-reel-label]");
  if (label) label.textContent = `Make ${nextReelCode(coupons)}`;
}

// ── Row actions ──────────────────────────────────────────────────────

async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code);
    toast(`${code} copied. Paste it in your caption.`, "success");
  } catch {
    toast(`Couldn't copy here. Press and hold ${code} to copy it.`, "error");
  }
}

function setActive(c: CouponPlus, active: boolean): void {
  const saved = reportSave(saveCoupon({ ...c, active }));
  refresh();
  render({ focus: `toggle-${c.id}` });
  const now = coupons.find((x) => x.id === c.id);
  if (!now) return;
  const state = stateOf(now);
  if (!active) toast(`${c.code} is off. Buyers can't use it now.`, saved ? "success" : "info");
  else if (state === "expired") toast(`${c.code} is on, but its last day has passed. Edit it to set a new date.`, "info", 6500);
  else if (state === "used-up") toast(`${c.code} is on, but it has reached its usage limit. Edit it to raise the limit.`, "info", 6500);
  else toast(`${c.code} is on. Buyers can use it at checkout.`, saved ? "success" : "info");
}

async function remove(c: CouponPlus, from?: "form"): Promise<void> {
  const s = statsOf(c);
  const ok = await confirmDialog({
    title: `Delete ${c.code}?`,
    body: s.uses
      ? `Buyers won't be able to use it. Its ${plural(s.uses, "past sale")} stay in Payments. In this demo, Settings can bring it back with "Reset demo data".`
      : `Buyers won't be able to use it. In this demo, Settings can bring it back with "Reset demo data".`,
    confirm: "Delete coupon",
    danger: true,
  });
  if (!ok) {
    (from === "form" ? $("[data-cpn-delete]", form.el!) : $(`[data-fk="delete-${CSS.escape(c.id)}"]`))?.focus();
    return;
  }

  // Focus goes to the next row (or the one before), so keyboard users keep their place.
  const order = $$<HTMLElement>(".cpn-row").map((el) => el.dataset.id ?? "");
  const i = order.indexOf(c.id);
  const neighbour = order[i + 1] ?? order[i - 1];

  reportSave(deleteCoupon(c.id));
  if (from === "form") closeForm(false);
  refresh();
  render({ focus: neighbour ? `edit-${neighbour}` : undefined });
  if (!neighbour) $<HTMLButtonElement>("[data-cpn-new]")?.focus();
  toast(`${c.code} deleted.`, "success");
}

// ── Form ─────────────────────────────────────────────────────────────

const form = {
  dialog: null as HTMLDialogElement | null,
  el: null as HTMLFormElement | null,
  editing: null as CouponPlus | null,
  opener: null as HTMLElement | null,
  tried: false,
};

const field = <T extends HTMLElement = HTMLInputElement>(name: CouponField) => $<T>(`[data-cpn-field="${name}"]`, form.el!)!;
const kindNow = (): DiscountKind => ($<HTMLInputElement>('[data-cpn-kind]:checked', form.el!)?.value === "flat" ? "flat" : "percent");

function readInput(): CouponInput {
  return {
    code: field("code").value,
    kind: kindNow(),
    value: field("value").value,
    courseId: field<HTMLSelectElement>("courseId").value,
    expires: field("expires").value,
    limit: field("limit").value,
    active: $<HTMLInputElement>("[data-cpn-active]", form.el!)!.checked,
  };
}

function checkNow() {
  const editing = form.editing;
  return checkCoupon(readInput(), {
    editing,
    coupons,
    courses,
    uses: editing ? statsOf(editing).uses : 0,
    today,
  });
}

function fillCourses(selected: string | null): void {
  const select = field<HTMLSelectElement>("courseId");
  const options = [h("option", { value: "", text: "All courses" })];
  for (const c of courses) {
    const label = `${c.title || "Untitled course"} (${c.price > 0 ? inr(c.price) : "free"}${c.status === "draft" ? ", draft" : ""})`;
    options.push(h("option", { value: c.id, text: label }));
  }
  if (selected && !courses.some((c) => c.id === selected)) options.push(h("option", { value: selected, text: "A deleted course" }));
  fill(select, options);
  select.value = selected ?? "";
}

function setKindUi(kind: DiscountKind): void {
  const wrap = $("[data-cpn-value-wrap]", form.el!)!;
  const affix = $("[data-cpn-affix]", form.el!)!;
  const input = field("value");
  const flat = kind === "flat";
  affix.textContent = flat ? "₹" : "%";
  affix.classList.toggle("affix-end", !flat);
  input.classList.toggle("pad-end", !flat);
  wrap.dataset.kind = kind;
  $("[data-cpn-value-label]", form.el!)!.textContent = flat ? "Rupees off" : "Percent off";
  $("[data-cpn-value-hint]", form.el!)!.textContent = flat
    ? "Whole rupees, below the course price."
    : `From ${PERCENT_MIN}% to ${PERCENT_MAX}%.`;
}

/** The "Buyers pay" box: the discounted price of the course the code works on. */
function renderPreview(): void {
  const priceEl = $("[data-cpn-preview-price]", form.el!)!;
  const forEl = $("[data-cpn-preview-for]", form.el!)!;
  const input = readInput();
  const course =
    courses.find((c) => c.id === input.courseId) ?? courses.find((c) => c.main) ?? courses[0] ?? { title: "Your course", price: 0 };
  const raw = input.value.replace(/[\s,₹%]/g, "");
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const valid = input.kind === "percent" ? n >= PERCENT_MIN && n <= PERCENT_MAX : n >= 1 && n < course.price;

  priceEl.classList.toggle("is-empty", !valid);
  if (!valid || !course.price) {
    fill(
      priceEl,
      input.kind === "percent"
        ? `Enter ${PERCENT_MIN}% to ${PERCENT_MAX}% to see the price.`
        : `Enter rupees off, under ${inr(course.price)}, to see the price.`,
    );
  } else {
    const after = priceWith({ kind: input.kind, percent: n, amount: n }, course.price);
    fill(
      priceEl,
      h("strong", { text: inr(after) }),
      h("span", { class: "visually-hidden", text: " instead of " }),
      h("s", { text: inr(course.price) }),
      h("span", { class: "cpn-preview-off", text: `You give ${inr(course.price - after)}` }),
    );
  }
  forEl.textContent = input.courseId ? course.title : `${course.title}, and the same off every other course`;
}

function showErrors(errors: CouponErrors, only?: Set<CouponField>): void {
  for (const name of FIELD_ORDER) {
    if (only && !only.has(name)) continue;
    const message = errors[name];
    const input = field(name);
    const out = $(`[data-cpn-error="${name}"]`, form.el!)!;
    if (message) {
      input.setAttribute("aria-invalid", "true");
      fill(out, icon("warning-circle"), h("span", { text: message }));
    } else {
      input.removeAttribute("aria-invalid");
      out.replaceChildren();
    }
  }
}

function showSummary(errors: CouponErrors): void {
  const summary = $<HTMLElement>("[data-cpn-summary]", form.el!)!;
  const names = FIELD_ORDER.filter((n) => errors[n]);
  if (!names.length) {
    summary.hidden = true;
    return;
  }
  $("[data-cpn-summary-title]", form.el!)!.textContent = names.length === 1 ? "Check this to save" : `Check these ${names.length} things to save`;
  const items = names.map((name) => {
    const link = h("a", { href: `#${field(name).id}`, text: errors[name] });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      field(name).focus();
    });
    return h("li", null, link);
  });
  fill($("[data-cpn-summary-list]", form.el!)!, items);
  summary.hidden = false;
  summary.focus();
}

/** After a failed save, fields that had an error re-check as they change, so fixed ones clear. */
function recheck(): void {
  if (!form.tried) return;
  const had = new Set(FIELD_ORDER.filter((n) => field(n).getAttribute("aria-invalid") === "true"));
  if (!had.size) return;
  showErrors(checkNow().errors, had);
  if (!FIELD_ORDER.some((n) => field(n).getAttribute("aria-invalid") === "true")) $<HTMLElement>("[data-cpn-summary]", form.el!)!.hidden = true;
}

function openForm(c: CouponPlus | null, opener: HTMLElement | null, code = ""): void {
  if (!form.dialog || !form.el) return;
  refresh();
  form.editing = c;
  form.opener = opener;
  form.tried = false;
  form.el.reset();
  showErrors({});
  $<HTMLElement>("[data-cpn-summary]", form.el)!.hidden = true;

  const uses = c ? statsOf(c).uses : 0;
  $("[data-cpn-form-title]", form.el)!.textContent = c ? `Edit ${c.code}` : "New coupon";
  $("[data-cpn-form-sub]", form.el)!.textContent = c
    ? `${plural(uses, "sale")} so far · demo data`
    : "Demo: saved in this browser only.";

  const codeInput = field("code");
  codeInput.value = c?.code ?? code;
  codeInput.readOnly = Boolean(c && uses > 0);
  $("[data-cpn-code-hint]", form.el)!.textContent =
    c && uses > 0
      ? `Used ${plural(uses, "time")}, so the code stays the same. Make a new coupon for a new code.`
      : "Capital letters and numbers, 3 to 15 characters. Buyers type it at checkout.";
  codeInput.placeholder = c ? "" : "e.g. INSTA10";

  const suggestion = nextReelCode(coupons);
  $<HTMLElement>("[data-cpn-suggest-wrap]", form.el)!.hidden = Boolean(c) || codeInput.value === suggestion;
  $("[data-cpn-suggest]", form.el)!.textContent = `Use ${suggestion}`;

  const kind: DiscountKind = c?.kind ?? "percent";
  for (const r of $$<HTMLInputElement>("[data-cpn-kind]", form.el)) r.checked = r.value === kind;
  setKindUi(kind);
  field("value").value = c ? String(c.kind === "flat" ? c.amount : c.percent) : "";
  fillCourses(c?.courseId ?? null);
  const expires = field("expires");
  expires.value = c?.expires ?? "";
  expires.min = c?.expires && c.expires < today ? c.expires : today;
  field("limit").value = c?.limit !== null && c?.limit !== undefined ? String(c.limit) : "";
  $<HTMLInputElement>("[data-cpn-active]", form.el)!.checked = c ? c.active : true;
  $<HTMLButtonElement>("[data-cpn-delete]", form.el)!.hidden = !c;
  $("[data-cpn-save]", form.el)!.textContent = c ? "Save changes" : "Save coupon";
  renderPreview();

  $("[data-cpn-form-body]", form.el)!.scrollTop = 0;
  form.dialog.showModal();
  (c ? field("value") : codeInput).focus();
}

function closeForm(restoreFocus = true): void {
  if (!form.dialog?.open) return;
  const opener = form.opener;
  form.dialog.close();
  if (restoreFocus && opener?.isConnected) opener.focus();
}

function submit(): void {
  form.tried = true;
  const { errors, coupon } = checkNow();
  showErrors(errors);
  if (!coupon) {
    showSummary(errors);
    return;
  }
  const isNew = !form.editing;
  const saved = reportSave(saveCoupon(coupon));
  closeForm(false);
  refresh();
  if (filter !== "all" && !coupons.filter((c) => (filter === "running" ? isRunning(c) : !isRunning(c))).some((c) => c.id === coupon.id)) {
    setFilter("all");
  }
  render({ focus: `edit-${coupon.id}`, fresh: coupon.id });
  if (saved) {
    toast(isNew ? `${coupon.code} is ready. Share it in a caption or with a creator.` : `${coupon.code} saved.`, "success");
  }
}

function setUpForm(): void {
  form.dialog = $<HTMLDialogElement>("[data-cpn-drawer]");
  form.el = $<HTMLFormElement>("[data-cpn-form]");
  const el = form.el;
  if (!form.dialog || !el) return;

  el.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  $("[data-cpn-close]", el)?.addEventListener("click", () => closeForm());
  $("[data-cpn-cancel]", el)?.addEventListener("click", () => closeForm());
  $("[data-cpn-delete]", el)?.addEventListener("click", () => {
    if (form.editing) void remove(form.editing, "form");
  });
  // Escape closes the native dialog; give focus back to what opened it.
  form.dialog.addEventListener("close", () => {
    const opener = form.opener;
    form.opener = null;
    if (opener?.isConnected && !form.dialog?.contains(document.activeElement) && document.activeElement === document.body) opener.focus();
  });
  // A tap on the dimmed page closes it.
  form.dialog.addEventListener("click", (event) => {
    if (event.target === form.dialog) closeForm();
  });

  // Codes are capitals: what's typed becomes upper case where the caret is.
  const code = field("code");
  code.addEventListener("input", () => {
    const upper = code.value.toUpperCase();
    if (upper !== code.value) {
      const start = code.selectionStart;
      const end = code.selectionEnd;
      code.value = upper;
      if (start !== null && end !== null) code.setSelectionRange(start, end);
    }
    const wrap = $<HTMLElement>("[data-cpn-suggest-wrap]", el)!;
    if (!form.editing) wrap.hidden = normaliseCode(code.value) === nextReelCode(coupons);
    recheck();
  });
  $("[data-cpn-suggest]", el)?.addEventListener("click", () => {
    code.value = nextReelCode(coupons);
    $<HTMLElement>("[data-cpn-suggest-wrap]", el)!.hidden = true;
    recheck();
    code.focus();
  });

  for (const radio of $$<HTMLInputElement>("[data-cpn-kind]", el)) {
    radio.addEventListener("change", () => {
      setKindUi(kindNow());
      renderPreview();
      recheck();
    });
  }
  for (const name of ["value", "courseId", "expires", "limit"] as const) {
    const input = field(name);
    const handler = () => {
      if (name === "value" || name === "courseId") renderPreview();
      recheck();
    };
    input.addEventListener("input", handler);
    input.addEventListener("change", handler);
  }
}

// ── Start ────────────────────────────────────────────────────────────

ready(() => {
  refresh();
  setUpForm();
  render();

  const newButton = $<HTMLButtonElement>("[data-cpn-new]");
  newButton?.addEventListener("click", () => openForm(null, newButton));
  const reelButton = $<HTMLButtonElement>("[data-cpn-reel]");
  reelButton?.addEventListener("click", () => openForm(null, reelButton, nextReelCode(coupons)));

  for (const b of $$<HTMLButtonElement>("[data-cpn-filter]")) {
    b.addEventListener("click", () => setFilter((b.dataset.cpnFilter as Filter) ?? "all"));
  }
});
