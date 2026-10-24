/** Activity log: newest first, filtered by what changed, "Show older" pages with the id cursor. */
import type { AuditRecord } from "../../../shared/types";
import { admin, asApiError } from "./api";
import { $, fill, h, ready } from "./dom";
import { emptyBox, errorBox, skeleton } from "./states";
import { busy } from "./ui";
import { AUDIT_ENTITIES, auditDetails, auditHref, auditSentence } from "../lib/audit";
import { istDay, istLongDate, istTime } from "../lib/time";

const PAGE = 50;
let rows: AuditRecord[] = [];
let entity = "";
let done = false;

function render(): void {
  const region = $("[data-region]")!;
  if (!rows.length) {
    fill(region, emptyBox({ icon: "list-checks", title: "Nothing here yet", text: entity ? "No changes of this kind so far." : "Changes you make in the admin show up here." }));
    $("[data-more-wrap]")!.hidden = true;
    return;
  }
  const items: HTMLElement[] = [];
  let lastDay = "";
  for (const r of rows) {
    const day = istDay(r.createdAt);
    if (day !== lastDay) {
      items.push(h("li", { class: "act-day", text: istLongDate(r.createdAt) }));
      lastDay = day;
    }
    const href = auditHref(r);
    const details = auditDetails(r.data);
    items.push(
      h(
        "li",
        { class: "act" },
        h("span", { class: "act-what", text: auditSentence(r.action) }),
        h("time", { class: "act-when", datetime: new Date(r.createdAt * 1000).toISOString(), text: istTime(r.createdAt) }),
        details || href
          ? h("p", { class: "act-detail" }, details, details && href ? " · " : null, href ? h("a", { href, text: "Open" }) : null)
          : null,
      ),
    );
  }
  fill(region, h("ol", { class: "act-list" }, items));
  const wrap = $("[data-more-wrap]")!;
  wrap.hidden = false;
  const count = $("[data-count]");
  if (count) count.textContent = `${rows.length} shown${done ? " · that's all" : ""}`;
  const more = $<HTMLButtonElement>("[data-more]");
  if (more) more.hidden = done;
}

async function load(reset: boolean): Promise<void> {
  const region = $("[data-region]")!;
  if (reset) {
    rows = [];
    done = false;
    fill(region, skeleton(6));
  }
  try {
    const before = rows.length ? rows[rows.length - 1]!.id : undefined;
    const page = await admin("GET /api/admin/audit", {}, { ...(entity ? { entity } : {}), ...(before ? { before } : {}) });
    rows = [...rows, ...page];
    done = page.length < PAGE;
    render();
  } catch (err) {
    if (reset) fill(region, errorBox(err, { what: "the activity log", retry: () => void load(true) }));
    else fill($("[data-count]")!, asApiError(err).message);
  }
}

ready(() => {
  const select = $<HTMLSelectElement>("[data-entity]");
  if (select) {
    for (const e of AUDIT_ENTITIES) select.append(h("option", { value: e.value, text: e.label }));
    entity = new URLSearchParams(location.search).get("entity") ?? "";
    if (!AUDIT_ENTITIES.some((e) => e.value === entity)) entity = "";
    select.value = entity;
    select.addEventListener("change", () => {
      entity = select.value;
      history.replaceState(null, "", entity ? `/admin/activity?entity=${entity}` : "/admin/activity");
      void load(true);
    });
  }
  $("[data-more]")?.addEventListener("click", (e) => void busy(e.currentTarget as HTMLButtonElement, () => load(false)));
  void load(true);
});
