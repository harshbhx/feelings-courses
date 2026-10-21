/** Dashboard: KPI cards, the 30-day sales chart, recent payments, progress and courses. Demo data. */
import { fromYmd, getActivity, getCourses, lessonTotal, studentCounts, type Day, type Payment } from "../../../lib/demo-store";
import { $, fill, h, icon, ready, s } from "./dom";
import { ago, change, dayMonth, fullDate, initials, inr, inrShort, longDate, num, plural } from "./format";
import { coverImage } from "./covers";

const now = new Date();
const { days, payments, students } = getActivity(now);
const paid = payments.filter((p) => p.status === "paid");

function inMonth(p: Payment, year: number, month: number, upToDay: number): boolean {
  const d = new Date(p.at);
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() <= upToDay;
}

function setText(key: string, ...parts: (string | Node)[]): void {
  const el = $(`[data-k="${key}"]`);
  if (el) fill(el, ...parts);
}

function delta(pct: number | null, label: string): (string | Node)[] {
  if (pct === null) return [label];
  if (pct === 0) return [`Same as ${label.replace(/^vs /, "")}`];
  const up = pct >= 0;
  return [h("span", { class: up ? "delta" : "delta is-down" }, icon(up ? "trend-up" : "trend-down"), `${up ? "+" : "−"}${Math.abs(pct)}%`), label];
}

function header(): void {
  const hour = now.getHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const title = $("[data-greeting]");
  if (title) title.textContent = `${greet}, ${title.dataset.name ?? ""}`;
  const today = $("[data-today]");
  if (today) today.textContent = longDate(now);
}

function kpis(): void {
  const y = now.getFullYear();
  const m = now.getMonth();
  const dayOfMonth = now.getDate();
  const prev = new Date(y, m - 1, 1);
  const thisMonth = paid.filter((p) => inMonth(p, y, m, dayOfMonth));
  const lastMonth = paid.filter((p) => inMonth(p, prev.getFullYear(), prev.getMonth(), dayOfMonth));
  const revenue = thisMonth.reduce((s, p) => s + p.amount, 0);
  // "vs 1–21 Sep": the same days of last month (clamped to its length).
  const prevEnd = Math.min(dayOfMonth, new Date(y, m, 0).getDate());
  const prevLabel = `vs ${prevEnd === 1 ? "" : "1–"}${prevEnd} ${prev.toLocaleDateString("en-IN", { month: "short" })}`;
  const lastRevenue = lastMonth.reduce((s, p) => s + p.amount, 0);

  setText("revenue", inr(revenue));
  setText("revenue-meta", ...delta(change(revenue, lastRevenue), prevLabel));

  const todayCount = thisMonth.filter((p) => new Date(p.at).getDate() === dayOfMonth).length;
  setText("enrollments", num(thisMonth.length), todayCount ? h("span", { class: "kpi-today", text: `+${todayCount} today` }) : "");
  setText(
    "enrollments-meta",
    ...delta(change(thisMonth.length, lastMonth.length), prevLabel),
  );

  const monthDays = days.filter((d) => {
    const date = fromYmd(d.date);
    return date.getFullYear() === y && date.getMonth() === m;
  });
  const visitors = monthDays.reduce((s, d) => s + d.visitors, 0);
  const rate = visitors ? (thisMonth.length / visitors) * 100 : 0;
  setText("rate", `${rate.toFixed(1)}%`);
  setText("rate-meta", `${num(visitors)} visitors → ${num(thisMonth.length)} enrolled`);

  const counts = new Map<string, number>();
  for (const p of thisMonth) if (p.coupon) counts.set(p.coupon, (counts.get(p.coupon) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top) {
    setText("coupon", top[0]);
    setText("coupon-meta", `Used ${plural(top[1], "time")} this month`);
  } else {
    setText("coupon", "None yet");
    setText("coupon-meta", "No coupon used this month");
  }
}

// ── Chart ────────────────────────────────────────────────────────────

const last30: Day[] = days.slice(-30);

function chart(): void {
  const box = $("[data-chart]");
  const tip = $("[data-tip]");
  const live = $("[data-chart-live]");
  if (!box || !tip) return;

  const total = last30.reduce((s, d) => s + d.revenue, 0);
  const enrolled = last30.reduce((s, d) => s + d.enrollments, 0);
  const best = last30.reduce((a, b) => (b.revenue > a.revenue ? b : a), last30[0]);
  const totalEl = $("[data-chart-total]");
  if (totalEl) totalEl.textContent = inr(total);
  const sub = $("[data-chart-sub]");
  if (sub) sub.textContent = `${plural(enrolled, "enrollment")} · demo data`;

  // Table view: every value, newest first.
  const rows = $("[data-chart-rows]");
  if (rows) {
    fill(
      rows,
      [...last30].reverse().map((d) =>
        h("tr", null, h("td", { text: fullDate(fromYmd(d.date)) }), h("td", { text: num(d.visitors) }), h("td", { text: num(d.enrollments) }), h("td", { text: inr(d.revenue) })),
      ),
    );
  }

  let active = -1;
  let width = 0;
  let geometry: { x: number; w: number; y: number; band: number }[] = [];
  const height = 208;
  const pad = { top: 12, right: 4, bottom: 26, left: 44 };

  const niceMax = (max: number) => {
    if (max <= 0) return 1000;
    const steps = [1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];
    for (const step of steps) if (max <= step * 3) return step * 3;
    return Math.ceil(max / 50000) * 50000;
  };

  const show = (i: number, fromKeyboard = false) => {
    active = i;
    const bars = box.querySelectorAll<SVGPathElement>(".bar");
    bars.forEach((b) => b.classList.toggle("is-on", Number(b.dataset.i) === i));
    if (i < 0 || !geometry[i]) {
      tip.hidden = true;
      return;
    }
    const d = last30[i];
    const g = geometry[i];
    const date = fromYmd(d.date);
    const label = i === last30.length - 1 ? `Today, ${dayMonth(date)}` : date.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
    fill(tip, h("strong", { text: inr(d.revenue) }), h("span", { text: `${plural(d.enrollments, "enrollment")} · ${num(d.visitors)} visitors` }), h("span", { text: label }));
    const cx = g.x + g.w / 2;
    // Keep the tip inside the card at the edges.
    const shift = cx < 80 ? "-12%" : cx > width - 80 ? "-88%" : "-50%";
    tip.style.setProperty("--tip-x", `${cx}px`);
    tip.style.setProperty("--tip-y", `${Math.min(g.y, height - pad.bottom - 4)}px`);
    tip.style.setProperty("--tip-shift", shift);
    tip.hidden = false;
    if (fromKeyboard && live) live.textContent = `${label}: ${inr(d.revenue)}, ${plural(d.enrollments, "enrollment")}, ${num(d.visitors)} visitors.`;
  };

  const draw = () => {
    if (width < 120) return;
    const max = niceMax(Math.max(...last30.map((d) => d.revenue)));
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const band = plotW / last30.length;
    const barW = Math.max(3, Math.min(22, band - 2));
    const yOf = (v: number) => pad.top + plotH - (v / max) * plotH;

    const titleId = "chart-svg-title";
    const descId = "chart-svg-desc";
    const svg = s(
      "svg",
      { width, height, viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": `${titleId} ${descId}` },
      s("title", { id: titleId, text: "Daily sales for the last 30 days (demo data)" }),
      s("desc", {
        id: descId,
        text: `Total ${inr(total)} from ${plural(enrolled, "enrollment")}. Best day: ${fullDate(fromYmd(best.date))}, ${inr(best.revenue)}. The numbers are in the table below the chart.`,
      }),
    );

    // Gridlines and y labels: 0, a third, two thirds, max.
    const grid = s("g", { class: "grid" });
    const axis = s("g", { class: "axis", "aria-hidden": "true" });
    for (let t = 0; t <= 3; t++) {
      const v = (max / 3) * t;
      const y = Math.round(yOf(v)) + 0.5;
      grid.appendChild(s("line", { x1: pad.left, x2: width - pad.right, y1: y, y2: y }));
      axis.appendChild(s("text", { x: pad.left - 8, y: y + 4, "text-anchor": "end", text: inrShort(v) }));
    }

    // Columns: rounded top, square at the baseline.
    const bars = s("g", { "aria-hidden": "true" });
    const hits = s("g", { "aria-hidden": "true" });
    geometry = last30.map((d, i) => {
      const x = pad.left + band * i + (band - barW) / 2;
      const y = yOf(d.revenue);
      const base = pad.top + plotH;
      if (d.revenue > 0) {
        const r = Math.min(4, barW / 2, base - y);
        const path = `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + barW - r}Q${x + barW},${y} ${x + barW},${y + r}V${base}Z`;
        bars.appendChild(s("path", { d: path, class: `bar${i === last30.length - 1 ? " is-today" : ""}`, dataset: { i } }));
      }
      const hit = s("rect", { x: pad.left + band * i, y: pad.top, width: band, height: plotH, class: "hit", dataset: { i } });
      hits.appendChild(hit);
      return { x, w: barW, y, band };
    });

    // X labels: every 7th day back from today, so "Today" is always labelled.
    for (let i = last30.length - 1; i >= 0; i -= 7) {
      const g = geometry[i];
      const label = i === last30.length - 1 ? "Today" : dayMonth(fromYmd(last30[i].date));
      const anchor = i === last30.length - 1 ? "end" : "middle";
      const x = i === last30.length - 1 ? Math.min(width - pad.right, g.x + g.w) : g.x + g.w / 2;
      axis.appendChild(s("text", { x, y: height - 6, "text-anchor": anchor, text: label }));
    }

    svg.append(grid, bars, axis, hits);
    box.querySelector("svg")?.remove();
    box.insertBefore(svg, tip);
    if (active >= 0) show(active);
  };

  // Width from a ResizeObserver: no layout read at script start.
  const ro = new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (w !== width) {
      width = w;
      draw();
    }
  });
  ro.observe(box);

  box.addEventListener("pointermove", (event) => {
    const target = event.target as Element;
    const i = target instanceof SVGRectElement && target.classList.contains("hit") ? Number(target.dataset.i) : -1;
    if (i >= 0 && i !== active) show(i);
  });
  box.addEventListener("pointerleave", () => show(-1));
  box.addEventListener("focus", () => show(active >= 0 ? active : last30.length - 1, true));
  box.addEventListener("blur", () => show(-1));
  box.addEventListener("keydown", (event) => {
    const map: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, Home: -999, End: 999 };
    if (!(event.key in map)) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(last30.length - 1, (active < 0 ? last30.length - 1 : active) + map[event.key]));
    show(next, true);
  });
}

// ── Recent payments ──────────────────────────────────────────────────

function recent(): void {
  const list = $("[data-recent]");
  if (!list) return;
  fill(
    list,
    payments.slice(0, 6).map((p) =>
      h(
        "li",
        { class: p.status === "failed" ? "is-failed" : undefined },
        h("span", { class: "avatar avatar-soft", "aria-hidden": "true", text: initials(p.studentName) }),
        h("span", { class: "who" }, h("strong", { text: p.studentName }), h("span", { text: `${p.method} · ${ago(new Date(p.at), now)}` })),
        h(
          "span",
          { class: "amt" },
          h("strong", { text: inr(p.amount) }),
          h("span", { text: p.status === "failed" ? "Failed" : p.coupon ? `Paid · ${p.coupon}` : "Paid" }),
        ),
      ),
    ),
  );
}

// ── Progress split ───────────────────────────────────────────────────

function progress(): void {
  const done = students.filter((s) => s.progress >= 100).length;
  const started = students.filter((s) => s.progress > 0 && s.progress < 100).length;
  const notYet = students.length - done - started;
  const parts = [
    { label: "Finished the course", n: done, c: "var(--accent)" },
    { label: "Watching", n: started, c: "var(--maroon-800)" },
    { label: "Not started yet", n: notYet, c: "var(--rose-200)" },
  ];
  const sub = $("[data-progress-sub]");
  if (sub) sub.textContent = `${plural(students.length, "student")} so far · demo data`;
  const bar = $("[data-split]");
  if (bar) {
    fill(
      bar,
      parts.filter((p) => p.n > 0).map((p) => {
        const el = h("span");
        el.style.setProperty("--n", String(p.n));
        el.style.setProperty("--c", p.c);
        return el;
      }),
    );
  }
  const legend = $("[data-split-legend]");
  if (legend) {
    fill(
      legend,
      parts.map((p) => {
        const key = h("span", { class: "key", "aria-hidden": "true" });
        key.style.setProperty("--c", p.c);
        const pct = students.length ? Math.round((p.n / students.length) * 100) : 0;
        return h("li", null, key, h("span", { text: p.label }), h("b", { text: `${num(p.n)} · ${pct}%` }));
      }),
    );
  }
}

// ── Courses ──────────────────────────────────────────────────────────

function courses(): void {
  const list = $("[data-courses]");
  if (!list) return;
  const counts = studentCounts(students);
  fill(
    list,
    getCourses().map((c) => {
      const img = coverImage(c.cover, c.title);
      return h(
        "li",
        null,
        h(
          "a",
          { href: `/admin/courses/edit?id=${encodeURIComponent(c.id)}` },
          h("img", { src: img.src, alt: "", width: 44, height: 54, loading: "lazy", decoding: "async" }),
          h("span", { class: "t" }, h("strong", { text: c.title || "Untitled course" }), h("span", { text: `${plural(lessonTotal(c), "lesson")} · ${plural(counts.get(c.id) ?? 0, "student")}` })),
          h("span", { class: c.status === "published" ? "pill pill-live" : "pill", text: c.status === "published" ? "Published" : "Draft" }),
        ),
      );
    }),
  );
}

ready(() => {
  header();
  kpis();
  chart();
  recent();
  progress();
  courses();
});
