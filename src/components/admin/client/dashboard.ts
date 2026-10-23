/**
 * Dashboard: setup steps, site status, the period's numbers against the period before, revenue per
 * day (one series, so no legend; keyboard and pointer read each day; the numbers are in a table),
 * recent payments and the courses. Each part loads on its own, so one failure doesn't blank the page.
 */
import type { AdminCourse, AdminOrder, AdminSettings, PublishStatus } from "../../../shared/types";
import { admin, asApiError } from "./api";
import { courses as loadCourses } from "./course-options";
import { $, $$, fill, h, icon, ready, s } from "./dom";
import { notifyChanged } from "./events";
import { initials, num, plural } from "./format";
import { emptyBox, errorBox, loadInto } from "./states";
import { busy, toast } from "./ui";
import { STATUS_LABELS } from "../lib/course-form";
import { describeError } from "../lib/errors";
import { feeLabel, formatPaise, paiseShort } from "../lib/money";
import { ORDER_STATUS_LABELS } from "../lib/orders";
import { publishView, rebuildMessage } from "../lib/publish";
import { change, conversion, fillSeries, niceMax, splitPeriods, statsRange, sum, type DayPoint } from "../lib/stats";
import { ago, dayLabel, istDay, istLongDate, unixNow } from "../lib/time";

const now = unixNow();
const today = istDay(now);

function setText(key: string, ...parts: (string | Node)[]): void {
  const el = $(`[data-k="${key}"]`);
  if (el) fill(el, ...parts);
}

function delta(pct: number | null, label: string): (string | Node)[] {
  if (pct === null) return [label];
  if (pct === 0) return [`Same as ${label.replace(/^vs /, "")}`];
  const up = pct > 0;
  return [h("span", { class: up ? "delta" : "delta is-down" }, icon(up ? "trend-up" : "trend-down"), `${up ? "+" : "−"}${Math.abs(pct)}%`), label];
}

function header(): void {
  const hour = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", hour12: false }).format(new Date()));
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const title = $("[data-greeting]");
  if (title) title.textContent = `${greet}, ${title.dataset.name ?? ""}`;
  const d = $("[data-today]");
  if (d) d.textContent = istLongDate(now);
}

// ---------------------------------------------------------------- setup steps and site status

function setup(settings: AdminSettings | null, courses: AdminCourse[]): void {
  const card = $("[data-setup]");
  const list = $("[data-setup-list]");
  if (!card || !list || !settings) return;
  const published = courses.filter((c) => c.status === "published");
  const noDomain = published.filter((c) => c.domainStatus !== "active");
  const steps = [
    { done: courses.length > 0, label: "Create your first course", href: "/admin/courses?new=1" },
    { done: published.length > 0, label: "Publish a course", href: courses[0] ? `/admin/courses/edit?id=${courses[0].id}` : "/admin/courses" },
    {
      done: published.length > 0 && noDomain.length === 0,
      label: noDomain.length ? `Set up ${plural(noDomain.length, "course subdomain")} in Cloudflare` : "Course subdomains live",
      href: noDomain[0] ? `/admin/courses/edit?id=${noDomain[0].id}#sec-address` : "/admin/settings",
    },
    { done: Boolean(settings.business.name && settings.business.address), label: "Business details for receipts", href: "/admin/settings" },
    { done: settings.legalConfirmed, label: "Confirm the legal pages", href: "/admin/settings" },
    { done: settings.paymentMode === "live", label: settings.paymentMode === "test" ? "Payments in test mode: go live with Harsh" : "Payments set up", href: "/admin/settings#payments" },
  ];
  const left = steps.filter((s) => !s.done).length;
  if (!left) return;
  card.hidden = false;
  const sub = $("[data-setup-sub]");
  if (sub) sub.textContent = `${steps.length - left} of ${steps.length} done.`;
  fill(
    list,
    steps.map((s) =>
      h(
        "li",
        null,
        s.done
          ? h("span", { class: "setup-done" }, icon("check-circle"), s.label, h("span", { class: "visually-hidden", text: " (done)" }))
          : h("a", { href: s.href }, icon("circle"), s.label, icon("arrow-right")),
      ),
    ),
  );
}

async function site(): Promise<void> {
  const state = $("[data-site-state]");
  const detail = $("[data-site-detail]");
  const action = $("[data-site-action]");
  if (!state || !detail || !action) return;
  let status: PublishStatus;
  try {
    status = await admin("GET /api/admin/publish/status");
  } catch (err) {
    state.textContent = "Status unavailable";
    detail.textContent = describeError(asApiError(err)).message;
    return;
  }
  const view = publishView(status);
  state.textContent = view.label;
  detail.textContent = view.detail;
  if (!view.action) {
    action.replaceChildren();
    if (view.poll) window.setTimeout(() => void site(), 20_000);
    return;
  }
  const button = h("button", { type: "button", class: "btn btn-primary" }, "Publish changes");
  button.addEventListener("click", () =>
    void busy(button, async () => {
      try {
        const r = await admin("POST /api/admin/publish");
        const msg = rebuildMessage(r.rebuild, unixNow());
        toast(msg.text, msg.tone);
        notifyChanged();
        await site();
      } catch (err) {
        toast(describeError(asApiError(err)).message, "error");
      }
    }),
  );
  fill(action, button);
}

// ---------------------------------------------------------------- numbers and chart

let days = 30;
let series: DayPoint[] = [];

function kpis(points: DayPoint[], split: string): void {
  const [before, current] = splitPeriods(points, split);
  const a = sum(current);
  const b = sum(before);
  const label = `vs the ${days} days before`;
  setText("revenue", formatPaise(a.revenuePaise - a.refundsPaise));
  setText("revenue-meta", ...delta(change(a.revenuePaise - a.refundsPaise, b.revenuePaise - b.refundsPaise), label), a.refundsPaise ? ` · ${formatPaise(a.refundsPaise)} refunded` : "");
  setText("orders", num(a.paidOrders));
  setText("orders-meta", ...delta(change(a.paidOrders, b.paidOrders), label));
  const rate = conversion(a);
  setText("rate", rate === null ? "—" : `${rate}%`);
  setText("rate-meta", `${num(a.checkoutsStarted)} started checkout → ${num(a.paidOrders)} paid`);
  setText("views", num(a.views));
  setText("views-meta", ...delta(change(a.views, b.views), label));
  $("[data-kpis]")?.removeAttribute("aria-busy");
}

function chart(points: DayPoint[]): void {
  const box = $("[data-chart]");
  const tip = $("[data-tip]");
  const live = $("[data-chart-live]");
  if (!box || !tip) return;
  series = points;
  box.querySelector(".state")?.remove();
  const total = points.reduce((n, d) => n + d.revenuePaise, 0);
  const paid = points.reduce((n, d) => n + d.paidOrders, 0);
  const best = points.reduce((a, b) => (b.revenuePaise > a.revenuePaise ? b : a), points[0]!);
  const title = $("[data-chart-title]");
  if (title) title.textContent = `Revenue per day, last ${days} days`;
  const totalEl = $("[data-chart-total]");
  if (totalEl) totalEl.textContent = formatPaise(total);
  const sub = $("[data-chart-sub]");
  if (sub) sub.textContent = `${plural(paid, "paid order")} · India time`;

  const rows = $("[data-chart-rows]");
  if (rows)
    fill(
      rows,
      [...points].reverse().map((d) => h("tr", null, h("td", { text: dayLabel(d.day) }), h("td", { text: num(d.views) }), h("td", { text: num(d.checkoutsStarted) }), h("td", { text: num(d.paidOrders) }), h("td", { text: formatPaise(d.revenuePaise) }))),
    );

  let active = -1;
  let width = 0;
  let geometry: { x: number; w: number; y: number }[] = [];
  const height = 208;
  const pad = { top: 12, right: 4, bottom: 26, left: 48 };

  const show = (i: number, fromKeyboard = false) => {
    active = i;
    box.querySelectorAll<SVGPathElement>(".bar").forEach((b) => b.classList.toggle("is-on", Number(b.dataset.i) === i));
    if (i < 0 || !geometry[i]) {
      tip.hidden = true;
      return;
    }
    const d = series[i]!;
    const g = geometry[i]!;
    const label = d.day === today ? `Today, ${dayLabel(d.day, false)}` : dayLabel(d.day);
    fill(tip, h("strong", { text: formatPaise(d.revenuePaise) }), h("span", { text: `${plural(d.paidOrders, "paid order")} · ${num(d.views)} views` }), h("span", { text: label }));
    const cx = g.x + g.w / 2;
    const shift = cx < 80 ? "-12%" : cx > width - 80 ? "-88%" : "-50%";
    tip.style.setProperty("--tip-x", `${cx}px`);
    tip.style.setProperty("--tip-y", `${Math.min(g.y, height - pad.bottom - 4)}px`);
    tip.style.setProperty("--tip-shift", shift);
    tip.hidden = false;
    if (fromKeyboard && live) live.textContent = `${label}: ${formatPaise(d.revenuePaise)}, ${plural(d.paidOrders, "paid order")}, ${num(d.views)} views.`;
  };

  const draw = () => {
    if (width < 120) return;
    const max = niceMax(Math.max(...series.map((d) => d.revenuePaise)));
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const band = plotW / series.length;
    const barW = Math.max(2, Math.min(22, band - 2));
    const yOf = (v: number) => pad.top + plotH - (v / max) * plotH;
    const svg = s(
      "svg",
      { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": "chart-svg-title chart-svg-desc" },
      s("title", { id: "chart-svg-title", text: `Revenue per day for the last ${days} days` }),
      s("desc", {
        id: "chart-svg-desc",
        text: total
          ? `Total ${formatPaise(total)} from ${plural(paid, "paid order")}. Best day: ${dayLabel(best.day)}, ${formatPaise(best.revenuePaise)}. The numbers are in the table below the chart.`
          : "No revenue in this period yet.",
      }),
    );
    const grid = s("g", { class: "grid" });
    const axis = s("g", { class: "axis", "aria-hidden": "true" });
    for (let t = 0; t <= 3; t++) {
      const v = (max / 3) * t;
      const y = Math.round(yOf(v)) + 0.5;
      grid.appendChild(s("line", { x1: pad.left, x2: width - pad.right, y1: y, y2: y }));
      axis.appendChild(s("text", { x: pad.left - 8, y: y + 4, "text-anchor": "end", text: paiseShort(v) }));
    }
    const bars = s("g", { "aria-hidden": "true" });
    const hits = s("g", { "aria-hidden": "true" });
    geometry = series.map((d, i) => {
      const x = pad.left + band * i + (band - barW) / 2;
      const y = yOf(d.revenuePaise);
      const base = pad.top + plotH;
      if (d.revenuePaise > 0) {
        const r = Math.min(4, barW / 2, base - y);
        const path = `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${base}Z`;
        bars.appendChild(s("path", { d: path, class: "bar", dataset: { i } }));
      }
      hits.appendChild(s("rect", { x: pad.left + band * i, y: pad.top, width: band, height: plotH, class: "hit", dataset: { i } }));
      return { x, w: barW, y };
    });
    const step = days <= 7 ? 1 : days <= 30 ? 7 : 21;
    for (let i = series.length - 1; i >= 0; i -= step) {
      const g = geometry[i]!;
      const isLast = i === series.length - 1;
      const label = isLast ? "Today" : dayLabel(series[i]!.day, false);
      axis.appendChild(s("text", { x: isLast ? Math.min(width - pad.right, g.x + g.w) : g.x + g.w / 2, y: height - 6, "text-anchor": isLast ? "end" : "middle", text: label }));
    }
    svg.append(grid, bars, axis, hits);
    box.querySelector("svg")?.remove();
    box.insertBefore(svg, tip);
    if (active >= 0) show(active);
  };

  // Width from a ResizeObserver: no layout read at script start (CLAUDE.md rule 5).
  const ro = new ResizeObserver((entries) => {
    const w = Math.round(entries[0]!.contentRect.width);
    if (w !== width) {
      width = w;
      draw();
    }
  });
  if (!box.dataset.wired) {
    box.dataset.wired = "1";
    box.addEventListener("pointermove", (event) => {
      const target = event.target as Element;
      const i = target instanceof SVGRectElement && target.classList.contains("hit") ? Number(target.dataset.i) : -1;
      if (i >= 0 && i !== active) show(i);
    });
    box.addEventListener("pointerleave", () => show(-1));
    box.addEventListener("focus", () => show(active >= 0 ? active : series.length - 1, true));
    box.addEventListener("blur", () => show(-1));
    box.addEventListener("keydown", (event) => {
      const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -999, End: 999 };
      if (!(event.key in map)) return;
      event.preventDefault();
      show(Math.max(0, Math.min(series.length - 1, (active < 0 ? series.length - 1 : active) + map[event.key]!)), true);
    });
  }
  (box as HTMLElement & { _ro?: ResizeObserver })._ro?.disconnect();
  (box as HTMLElement & { _ro?: ResizeObserver })._ro = ro;
  ro.observe(box);
}

async function numbers(): Promise<void> {
  const range = statsRange(today, days);
  $("[data-kpis]")?.setAttribute("aria-busy", "true");
  try {
    const stats = await admin("GET /api/admin/stats", {}, { from: range.from, to: range.to });
    const points = fillSeries(stats.series, range.from, range.to);
    kpis(points, range.split);
    chart(splitPeriods(points, range.split)[1]);
  } catch (err) {
    $("[data-kpis]")?.removeAttribute("aria-busy");
    for (const k of ["revenue", "orders", "rate", "views"]) setText(k, "—");
    setText("revenue-meta", describeError(asApiError(err)).message);
    const box = $("[data-chart]");
    if (box) fill(box, errorBox(err, { what: "the numbers", retry: () => void numbers() }), h("div", { class: "chart-tip", dataset: { tip: "" }, hidden: true }));
  }
}

// ---------------------------------------------------------------- recent payments and courses

function recent(orders: AdminOrder[]): void {
  const root = $("[data-recent]")!;
  if (!orders.length) {
    fill(root, h("li", null, emptyBox({ icon: "receipt", title: "No payments yet", text: "They show here the moment someone pays." })));
    return;
  }
  fill(
    root,
    orders.slice(0, 6).map((o) =>
      h(
        "li",
        null,
        h(
          "a",
          { class: `recent-row${o.status === "failed" ? " is-failed" : ""}`, href: `/admin/payments?open=${o.id}` },
          h("span", { class: "avatar avatar-soft", "aria-hidden": "true", text: initials(o.studentName ?? "?") }),
          h("span", { class: "who" }, h("strong", { text: o.studentName ?? "Erased student" }), h("span", { text: `${o.courseTitle} · ${ago(o.paidAt ?? o.createdAt, now)}` })),
          h("span", { class: "amt" }, h("strong", { text: formatPaise(o.amountPaise) }), h("span", { text: `${ORDER_STATUS_LABELS[o.status]}${o.mode === "test" ? " · test" : ""}` })),
        ),
      ),
    ),
  );
}

function courseList(list: AdminCourse[]): void {
  const root = $("[data-courses]")!;
  if (!list.length) {
    fill(root, h("li", null, emptyBox({ icon: "book-open-text", title: "No courses yet", action: h("a", { class: "btn btn-primary", href: "/admin/courses?new=1" }, icon("plus"), "New course") })));
    return;
  }
  const sorted = [...list].filter((c) => c.status !== "archived").sort((a, b) => b.enrollmentCount - a.enrollmentCount).slice(0, 5);
  fill(
    root,
    sorted.map((c) =>
      h(
        "li",
        null,
        h(
          "a",
          { href: `/admin/courses/edit?id=${c.id}` },
          h("span", { class: "t" }, h("strong", { text: c.title }), h("span", { text: `${feeLabel(c.pricePaise)} · ${plural(c.enrollmentCount, "student")}` })),
          h("span", { class: c.status === "published" ? "pill pill-live" : "pill", text: STATUS_LABELS[c.status] }),
        ),
      ),
    ),
  );
}

ready(() => {
  header();
  for (const b of $$<HTMLButtonElement>("[data-range]")) {
    b.addEventListener("click", () => {
      days = Number(b.dataset.range);
      for (const x of $$("[data-range]")) x.setAttribute("aria-pressed", String(x === b));
      void numbers();
    });
  }
  void numbers();
  void site();
  void loadInto($("[data-recent]")!, () => admin("GET /api/admin/orders", {}, {}), (p) => recent(p.items), { what: "recent payments", rows: 3 });
  const coursesP = loadCourses();
  void loadInto($("[data-courses]")!, () => coursesP, courseList, { what: "your courses", rows: 3 });
  Promise.all([admin("GET /api/admin/settings").catch(() => null), coursesP.catch(() => [] as AdminCourse[])])
    .then(([settings, list]) => setup(settings, list))
    // The numbers below the setup card are painted once it is known whether the card shows, so
    // they don't jump down when it appears (dashboard.astro, data-await-setup).
    .finally(() => document.documentElement.classList.add("setup-known"));
  document.addEventListener("admin:published", () => void site());
});
