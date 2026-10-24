/**
 * The course editor (/admin/courses/edit?id=…). See the page's header comment for what it covers.
 * The course form saves only the fields that changed; the outline, batches and photos save on their
 * own. Leaving with unsaved changes (or an upload running) asks first.
 */
import type { AdminCourse, CourseFormat } from "../../../shared/types";
import { admin, asApiError, hostsReady, siteHosts } from "../client/api";
import { $, $$, fill, h, icon, ready, reducedMotion } from "../client/dom";
import { clearErrors, setErrors } from "../client/fields";
import { notifyChanged } from "../client/events";
import { errorBox, skeleton } from "../client/states";
import { busy, confirmDialog, copyText, toast } from "../client/ui";
import {
  FORMAT_LABELS,
  STATUS_LABELS,
  canPublish,
  changedFields,
  courseInput,
  formFromCourse,
  publishChecklist,
  stableJson,
  type CourseFormValues,
} from "../lib/course-form";
import { PAGES_DOMAINS_URL, domainSteps, domainView, probeText } from "../lib/domain";
import { describeError } from "../lib/errors";
import { feeLabel } from "../lib/money";
import { rebuildMessage } from "../lib/publish";
import { courseAddresses, courseSlugProblem, tidyCourseSlug } from "../lib/slug";
import { unixNow } from "../lib/time";
import { UPLOAD_RULES, imageUrl, keyName } from "../lib/upload";
import { batchDialog, renderBatches } from "./batches";
import { faqList, glimpseList, pointsList, type ListHandle } from "./lists";
import { initOutline, outlineDirty, refreshSaved } from "./outline";
import { anyUploading, uploadControl } from "./uploads";

let course: AdminCourse;
let lists: { outcomes: ListHandle<string>; forWho: ListHandle<string>; highlights: ListHandle<string>; faqs: ReturnType<typeof faqList>; glimpses: ReturnType<typeof glimpseList> };
/** Image keys are saved straight after upload, so they live here, not in an input. */
const images: { coverKey: string | null; ogImageKey: string | null } = { coverKey: null, ogImageKey: null };

const TEXT_FIELDS = [
  "title",
  "subtitle",
  "description",
  "teacher",
  "level",
  "language",
  "durationText",
  "slug",
  "certificateTitle",
  "seoTitle",
  "seoDescription",
] as const;
const MONEY_FIELDS = { pricePaise: "price", compareAtPaise: "compareAt", depositPaise: "deposit" } as const;

const control = <T extends HTMLElement = HTMLInputElement>(name: string) => $<T>(`[data-editor] [data-field="${name}"]`);

// ---------------------------------------------------------------- form values

function readForm(): CourseFormValues {
  const v = (name: string) => control<HTMLInputElement>(name)?.value ?? "";
  return {
    slug: v("slug"),
    title: v("title"),
    subtitle: v("subtitle"),
    description: v("description"),
    teacher: v("teacher"),
    format: ($<HTMLInputElement>("[data-format-choices] input:checked")?.value ?? course.format) as CourseFormat,
    price: v("pricePaise"),
    compareAt: v("compareAtPaise"),
    deposit: v("depositPaise"),
    accessDays: v("accessDays"),
    level: v("level"),
    language: v("language"),
    durationText: v("durationText"),
    certificateTitle: v("certificateTitle"),
    seoTitle: v("seoTitle"),
    seoDescription: v("seoDescription"),
    sortOrder: v("sortOrder"),
    isDemo: control<HTMLInputElement>("isDemo")?.checked ?? false,
    coverKey: images.coverKey,
    ogImageKey: images.ogImageKey,
    outcomes: lists.outcomes.get(),
    forWho: lists.forWho.get(),
    highlights: lists.highlights.get(),
    faqs: lists.faqs.get(),
    glimpses: lists.glimpses.get(),
  };
}

function fillForm(c: AdminCourse): void {
  const v = formFromCourse(c);
  for (const name of TEXT_FIELDS) {
    const el = control<HTMLInputElement>(name);
    if (el) el.value = v[name];
  }
  for (const [api, key] of Object.entries(MONEY_FIELDS)) {
    const el = control<HTMLInputElement>(api);
    if (el) el.value = v[key];
  }
  const ad = control<HTMLInputElement>("accessDays");
  if (ad) ad.value = v.accessDays;
  const so = control<HTMLInputElement>("sortOrder");
  if (so) so.value = v.sortOrder;
  const demo = control<HTMLInputElement>("isDemo");
  if (demo) demo.checked = v.isDemo;
  images.coverKey = v.coverKey;
  images.ogImageKey = v.ogImageKey;
  lists.outcomes.set(v.outcomes);
  lists.forWho.set(v.forWho);
  lists.highlights.set(v.highlights);
  lists.faqs.set(v.faqs);
  lists.glimpses.set(v.glimpses);
  const choice = $<HTMLInputElement>(`[data-format-choices] input[value="${v.format}"]`);
  if (choice) choice.checked = true;
  updateCounters();
}

/** Unsaved changes in the course form (not the outline). */
function formDirty(): boolean {
  return stableJson(normalise(readForm())) !== stableJson(normalise(formFromCourse(course)));
}

/** Blank list rows and surrounding spaces don't count as changes. */
function normalise(v: CourseFormValues): CourseFormValues {
  const t = (s: string) => s.trim();
  return {
    ...v,
    ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, t(v[k])])),
    price: t(v.price),
    compareAt: t(v.compareAt),
    deposit: t(v.deposit),
    accessDays: t(v.accessDays),
    sortOrder: t(v.sortOrder) || "0",
    outcomes: v.outcomes.map(t).filter(Boolean),
    forWho: v.forWho.map(t).filter(Boolean),
    highlights: v.highlights.map(t).filter(Boolean),
    faqs: v.faqs.map((f) => ({ q: t(f.q), a: t(f.a) })).filter((f) => f.q || f.a),
    glimpses: v.glimpses.map((g) => ({ youtube: t(g.youtube), label: t(g.label) })).filter((g) => g.youtube || g.label),
  };
}

// ---------------------------------------------------------------- header, state line, counters

function updateState(): void {
  const el = $("[data-ed-state]");
  if (!el) return;
  const dirtyForm = formDirty();
  const dirtyOutline = outlineDirty();
  const parts: string[] = [STATUS_LABELS[course.status]];
  if (dirtyForm && dirtyOutline) parts.push("unsaved changes and lessons");
  else if (dirtyForm) parts.push("unsaved changes");
  else if (dirtyOutline) parts.push("lessons not saved");
  else parts.push("all saved");
  el.textContent = parts.join(" · ");
  el.classList.toggle("is-dirty", dirtyForm || dirtyOutline);
  for (const b of $$<HTMLButtonElement>("[data-save]")) {
    if (!b.hasAttribute("aria-busy")) b.textContent = dirtyForm ? "Save changes" : "Saved";
    b.classList.toggle("btn-primary", dirtyForm);
    b.classList.toggle("btn-secondary", !dirtyForm);
  }
}

function updateCounters(): void {
  for (const el of $$<HTMLInputElement | HTMLTextAreaElement>("[data-counter]")) {
    const out = $(`[data-count-for="${el.id}"]`);
    if (out) out.textContent = `${el.value.length}/${el.maxLength}`;
  }
}

function renderHeader(): void {
  const heading = $("[data-ed-heading]");
  if (heading) heading.textContent = course.title || "Untitled course";
  document.title = `${course.title || "Course"} · Course admin · Feelings Beauty Care`;
  const addr = courseAddresses(course.slug, siteHosts());
  const view = $<HTMLAnchorElement>("[data-view-link]");
  if (view) {
    view.href = course.domainStatus === "active" ? addr.subdomainUrl : addr.hubUrl;
    view.hidden = course.status !== "published";
    // Starts with the visible words, so voice control users can say what they see (WCAG 2.5.3).
    view.setAttribute("aria-label", "View on site (opens a new tab)");
  }
  const viewLabel = $("[data-view-label]");
  if (viewLabel) viewLabel.textContent = "View on site";
}

// ---------------------------------------------------------------- format and fee

function renderFormat(): void {
  const root = $("[data-format-choices]");
  if (!root) return;
  fill(
    root,
    (Object.keys(FORMAT_LABELS) as CourseFormat[]).map((f) =>
      h(
        "label",
        { class: "choice" },
        h("input", {
          type: "radio",
          name: "format",
          value: f,
          checked: course.format === f,
          "aria-describedby": "f-format-err",
          dataset: { field: f === "online" ? "format" : null },
        }),
        h("strong", { text: FORMAT_LABELS[f].title }),
        h("span", { text: FORMAT_LABELS[f].hint }),
      ),
    ),
  );
  root.addEventListener("change", () => {
    syncFormat();
    onEdit();
  });
}

/** Shows what fits the chosen format: batches for in-person, lessons for recorded, both for hybrid. */
function syncFormat(): void {
  const format = readForm().format;
  const deposit = $("[data-deposit-wrap]");
  if (deposit) deposit.hidden = format === "online";
  const batches = $("#sec-batches");
  if (batches) batches.hidden = format === "online" && course.batches.length === 0;
  const outline = $("#sec-outline");
  const hasLessons = course.modules.some((m) => m.lessons.length);
  if (outline) outline.hidden = format === "in_person" && !hasLessons;
  for (const a of $$<HTMLAnchorElement>("[data-nav-for]")) {
    const target = document.getElementById(a.dataset.navFor!);
    a.hidden = Boolean(target?.hidden);
  }
}

// ---------------------------------------------------------------- web address

function renderAddress(probe?: string): void {
  const hosts = siteHosts();
  const addr = courseAddresses(course.slug, hosts);
  const view = domainView(course.domainStatus, course.slug, hosts);
  const apex = $("[data-slug-apex]");
  if (apex) apex.textContent = `.${hosts.apexDomain}`;
  const pill = $("[data-domain-pill]");
  if (pill) {
    pill.textContent = view.label;
    pill.className = `pill${view.tone === "live" ? " pill-live" : view.tone === "wait" ? " pill-wait" : ""}`;
  }
  const slug = control<HTMLInputElement>("slug");
  const hint = $("[data-slug-hint]");
  if (slug) {
    slug.readOnly = course.slugLocked;
    if (hint)
      hint.textContent = course.slugLocked
        ? "Locked: the subdomain is live, so its links keep working."
        : "Lowercase letters, digits and hyphens. Changing it needs a new subdomain in Cloudflare.";
  }
  const sub = $<HTMLAnchorElement>("[data-addr-sub]");
  if (sub) {
    sub.href = addr.subdomainUrl;
    sub.textContent = addr.host;
  }
  const hub = $<HTMLAnchorElement>("[data-addr-hub]");
  if (hub) {
    hub.href = addr.hubUrl;
    hub.textContent = addr.hubUrl.replace(/^https:\/\//, "");
  }
  const help = $("[data-domain-help]");
  if (help) help.textContent = view.help;
  const steps = $("[data-cf-steps]");
  if (steps) {
    fill(
      steps,
      domainSteps(course.slug, hosts).map((s) =>
        h(
          "li",
          null,
          h("strong", { text: s.title }),
          s.detail ? h("p", { text: s.detail }) : null,
          s.copy
            ? h(
                "div",
                { class: "copy-line" },
                h("code", { text: s.copy }),
                h("button", { type: "button", class: "icon-btn", "aria-label": `Copy ${s.copy}`, onClick: () => void copyText(s.copy!, "Address copied") }, icon("copy")),
              )
            : null,
        ),
      ),
    );
  }
  const cf = $<HTMLAnchorElement>("[data-cf-open]");
  if (cf) cf.href = PAGES_DOMAINS_URL;
  const details = $<HTMLDetailsElement>("[data-cf-help]");
  if (details && course.domainStatus !== "active" && !details.dataset.touched) details.open = course.status === "published";
  if (details && course.domainStatus === "active") details.hidden = true;
  const check = $<HTMLButtonElement>("[data-domain-check]");
  if (check) check.hidden = course.domainStatus === "active" && !probe;
  const probeEl = $("[data-domain-probe]");
  if (probeEl && probe !== undefined) probeEl.textContent = probe;
}

async function checkDomain(button: HTMLButtonElement): Promise<void> {
  if (formDirty() && readForm().slug.trim() !== course.slug) {
    toast("Save the new web address first, then check it.", "info");
    return;
  }
  await busy(button, async () => {
    try {
      const r = await admin("POST /api/admin/courses/:id/domain/check", { id: course.id });
      course = { ...course, domainStatus: r.status, slugLocked: r.status === "active" };
      renderAddress(probeText(r.probe, r.status));
      renderPublish();
      if (r.status === "active") toast(`${r.host} is live.`);
    } catch (err) {
      renderAddress(describeError(asApiError(err)).message);
    }
  });
}

// ---------------------------------------------------------------- photos

function renderImages(): void {
  for (const slot of $$("[data-image-slot]")) {
    const key = slot.dataset.imageSlot as "coverKey" | "ogImageKey";
    const label = slot.dataset.imageLabel ?? "Photo";
    const current = images[key];
    const note = h("p", { class: "field-error", role: "alert" });
    fill(
      slot,
      h("span", { class: "field-label", text: label }),
      h("div", { class: "img-preview" }, current ? h("img", { src: imageUrl(current), alt: `${label}: ${keyName(current)}`, loading: "lazy" }) : icon("image")),
      h("p", { class: "field-hint", text: `${slot.dataset.imageHint ?? ""} ${UPLOAD_RULES.image.hint}` }),
      h(
        "div",
        { class: "btn-row" },
        uploadControl({
          id: `image-${key}`,
          kind: "image",
          label: current ? "Replace photo" : "Upload photo",
          accept: UPLOAD_RULES.image.accept,
          onDone: (item) => saveImage(key, item.key),
          onError: (msg) => (note.textContent = msg),
        }),
        current ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: () => void saveImage(key, null) }, icon("trash"), "Remove") : null,
      ),
      note,
    );
  }
}

async function saveImage(key: "coverKey" | "ogImageKey", value: string | null): Promise<void> {
  try {
    const updated = await admin("PUT /api/admin/courses/:id", { id: course.id }, { [key]: value } as never);
    course = { ...course, [key]: updated[key], updatedAt: updated.updatedAt };
    images[key] = updated[key];
    renderImages();
    renderPublish();
    updateState();
    toast(value ? "Photo saved." : "Photo removed.");
    if (course.status === "published") notifyChanged();
  } catch (err) {
    toast(describeError(asApiError(err)).message, "error");
  }
}

// ---------------------------------------------------------------- publish card

function renderPublish(): void {
  const pill = $("[data-status-pill]");
  if (pill) {
    pill.textContent = STATUS_LABELS[course.status];
    pill.className = course.status === "published" ? "pill pill-live" : course.status === "archived" ? "pill pill-plain" : "pill";
  }
  const items = publishChecklist(course);
  const list = $("[data-checklist]");
  if (list) {
    fill(
      list,
      items.map((i) =>
        h(
          "li",
          { class: i.done ? "is-done" : i.required ? "is-missing" : "" },
          h(
            "a",
            { href: `#${i.anchor}` },
            icon(i.done ? "check-circle" : i.required ? "warning-circle" : "circle"),
            h("span", null, i.label, !i.required && !i.done ? h("span", { class: "opt", text: " · recommended" }) : null),
            h("span", { class: "visually-hidden", text: i.done ? " (done)" : i.required ? " (needed to publish)" : " (recommended)" }),
          ),
        ),
      ),
    );
  }
  const help = $("[data-pub-help]");
  const publish = $<HTMLButtonElement>("[data-publish]");
  const unpublish = $<HTMLButtonElement>("[data-unpublish]");
  const ready = canPublish(items);
  if (help)
    help.textContent =
      course.status === "published"
        ? `On the site at ${feeLabel(course.pricePaise)}. Edits go live when you publish them.`
        : course.status === "archived"
          ? "Off the catalog. Students keep their access. Publish to bring it back."
          : ready
            ? "Ready to publish. It goes live in about 2 minutes."
            : "A draft only you can see. Finish the steps below to publish.";
  if (publish) {
    publish.textContent = course.status === "published" ? "Publish my edits" : course.status === "archived" ? "Publish again" : "Publish";
    publish.setAttribute("aria-disabled", String(!ready));
  }
  if (unpublish) unpublish.hidden = course.status !== "published";
  const archive = $<HTMLButtonElement>("[data-archive]");
  if (archive) archive.hidden = course.status === "archived";
  const del = $<HTMLButtonElement>("[data-delete]");
  if (del) del.hidden = course.status === "published" || course.enrollmentCount > 0;
}

async function statusAction(action: "publish" | "unpublish" | "archive", button: HTMLButtonElement): Promise<void> {
  if (action === "publish") {
    if (formDirty() || outlineDirty()) {
      toast("Save your changes first, then publish.", "info");
      return;
    }
    if (!canPublish(publishChecklist(course))) {
      const missing = publishChecklist(course).find((i) => i.required && !i.done);
      toast(`Not ready yet: ${missing?.label.toLowerCase() ?? "finish the checklist"}.`, "info");
      if (missing) document.getElementById(missing.anchor)?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth" });
      return;
    }
  }
  if (action === "unpublish") {
    const ok = await confirmDialog({
      title: "Take this course off the site?",
      body: "It becomes a draft: nobody new can buy it. Students who bought it keep their access.",
      confirm: "Take it off",
      danger: true,
    });
    if (!ok) return;
  }
  if (action === "archive") {
    const ok = await confirmDialog({
      title: "Archive this course?",
      body: "It leaves the catalog and can't be bought. Students keep their access. You can publish it again later.",
      confirm: "Archive",
    });
    if (!ok) return;
  }
  await busy(button, async () => {
    try {
      const key =
        action === "publish"
          ? "POST /api/admin/courses/:id/publish"
          : action === "unpublish"
            ? "POST /api/admin/courses/:id/unpublish"
            : "POST /api/admin/courses/:id/archive";
      const r = await admin(key, { id: course.id });
      course = r.course;
      refreshSaved(course);
      renderAll(false);
      const note = $("[data-pub-note]");
      const msg = rebuildMessage(r.rebuild, unixNow());
      if (note) note.textContent = msg.text;
      toast(action === "publish" ? msg.text : action === "unpublish" ? "Taken off the site. It's a draft now." : "Archived.", msg.tone);
      notifyChanged();
    } catch (err) {
      const e = asApiError(err);
      if (Object.keys(e.fields).length) {
        const first = Object.values(e.fields)[0]!;
        toast(`Can't publish yet: ${first}`, "error");
      } else toast(describeError(e).message, "error");
    }
  });
  renderPublish();
}

async function deleteCourse(button: HTMLButtonElement): Promise<void> {
  const ok = await confirmDialog({
    title: `Delete “${course.title}”?`,
    body: "The course is removed from the admin and its web address is freed. This can't be undone.",
    confirm: "Delete course",
    danger: true,
  });
  if (!ok) return;
  await busy(button, async () => {
    try {
      await admin("DELETE /api/admin/courses/:id", { id: course.id });
      leaving = true;
      location.assign("/admin/courses");
    } catch (err) {
      toast(describeError(asApiError(err)).message, "error");
    }
  });
}

// ---------------------------------------------------------------- saving the form

function showSummary(errors: Record<string, string>): void {
  const box = $("[data-summary]");
  const list = $("[data-summary-list]");
  if (!box || !list) return;
  const entries = Object.entries(errors);
  if (!entries.length) {
    box.hidden = true;
    return;
  }
  fill(
    list,
    entries.map(([name, message]) => {
      const target = control(name);
      return h("li", null, target?.id ? h("a", { href: `#${target.id}`, text: message }) : h("span", { text: message }));
    }),
  );
  const title = $("[data-summary-title]");
  if (title) title.textContent = entries.length === 1 ? "Fix this first" : `Fix these ${entries.length} things first`;
  box.hidden = false;
}

async function save(button: HTMLButtonElement | null): Promise<void> {
  const root = $("[data-editor]")!;
  // Drop blank rows first, so list positions match what is sent.
  const values = normalise(readForm());
  lists.outcomes.set(values.outcomes);
  lists.forWho.set(values.forWho);
  lists.highlights.set(values.highlights);
  lists.faqs.set(values.faqs);
  lists.glimpses.set(values.glimpses);
  const r = courseInput(values);
  if (!r.ok) {
    const unplaced = setErrors(root, r.errors);
    showSummary({ ...r.errors });
    if (Object.keys(unplaced).length === Object.keys(r.errors).length) $("[data-summary]")?.focus();
    return;
  }
  const diff = changedFields(course, r.input);
  if (!Object.keys(diff).length) {
    clearErrors(root);
    showSummary({});
    toast("Nothing new to save.", "info", 2500);
    return;
  }
  if (diff.slug !== undefined && course.domainStatus !== "none") {
    const ok = await confirmDialog({
      title: "Change the web address?",
      body: `The new address needs its own subdomain in Cloudflare. ${courseAddresses(course.slug, siteHosts()).host} stops being this course's address.`,
      confirm: "Change it",
    });
    if (!ok) return;
  }
  const run = async () => {
    try {
      const updated = await admin("PUT /api/admin/courses/:id", { id: course.id }, diff as never);
      const wasPublished = course.status === "published";
      course = updated;
      clearErrors(root);
      showSummary({});
      fillForm(course);
      renderAll(false);
      toast(wasPublished ? "Saved. Publish changes to update the site." : "Saved.");
      if (wasPublished) notifyChanged();
    } catch (err) {
      const e = asApiError(err);
      const fields = { ...e.fields };
      if (e.code === "slug_taken" || e.code === "slug_locked") fields.slug = e.message;
      if (Object.keys(fields).length) {
        setErrors(root, fields);
        showSummary(fields);
      } else toast(describeError(e).message, "error");
    }
  };
  if (button) await busy(button, run);
  else await run();
  updateState();
}

// ---------------------------------------------------------------- wiring

let leaving = false;

function onEdit(): void {
  updateState();
}

function renderAll(withForm = true): void {
  if (withForm) fillForm(course);
  renderHeader();
  renderAddress();
  renderImages();
  renderPublish();
  renderBatchesNow();
  syncFormat();
  updateState();
}

function renderBatchesNow(): void {
  const root = $("[data-batches]");
  if (!root) return;
  renderBatches(root, course.batches, batchCtx);
}

const batchCtx = {
  courseId: 0,
  courseFeeLabel: () => feeLabel(course.pricePaise),
  published: () => course.status === "published",
  onChange: (batches: AdminCourse["batches"]) => {
    course = { ...course, batches };
    renderBatchesNow();
    renderPublish();
    syncFormat();
  },
};

function wire(): void {
  const root = $("[data-editor]")!;
  root.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (t.matches("[data-counter]")) updateCounters();
    if (t.closest("#sec-outline, #sec-batches, [role=dialog], dialog")) return;
    if (t.getAttribute("aria-invalid") === "true") {
      t.removeAttribute("aria-invalid");
      const errId = t.getAttribute("aria-describedby")?.split(" ").find((id) => id.endsWith("-err"));
      if (errId) document.getElementById(errId)?.replaceChildren();
    }
    onEdit();
  });
  root.addEventListener("change", (e) => {
    if ((e.target as HTMLElement).matches("[data-field=isDemo]")) onEdit();
  });
  const slug = control<HTMLInputElement>("slug");
  slug?.addEventListener("input", () => {
    if (slug.readOnly) return;
    const at = slug.selectionStart ?? slug.value.length;
    const tidy = tidyCourseSlug(slug.value);
    if (tidy !== slug.value) {
      slug.value = tidy;
      slug.setSelectionRange(Math.min(at, tidy.length), Math.min(at, tidy.length));
    }
    const hint = $("[data-slug-hint]");
    const problem = courseSlugProblem(tidy);
    if (hint && !course.slugLocked) hint.textContent = problem ?? `New address: ${courseAddresses(tidy, siteHosts()).host}`;
  });
  $<HTMLFormElement>("[data-form]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
    void save(submitter);
  });
  // Ctrl/Cmd+S saves.
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      void save($<HTMLButtonElement>("[data-save]"));
    }
  });
  $("[data-domain-check]")?.addEventListener("click", (e) => void checkDomain(e.currentTarget as HTMLButtonElement));
  $("[data-cf-help]")?.addEventListener("toggle", (e) => ((e.currentTarget as HTMLElement).dataset.touched = "1"));
  $("[data-publish]")?.addEventListener("click", (e) => void statusAction("publish", e.currentTarget as HTMLButtonElement));
  $("[data-unpublish]")?.addEventListener("click", (e) => void statusAction("unpublish", e.currentTarget as HTMLButtonElement));
  $("[data-archive]")?.addEventListener("click", (e) => void statusAction("archive", e.currentTarget as HTMLButtonElement));
  $("[data-delete]")?.addEventListener("click", (e) => void deleteCourse(e.currentTarget as HTMLButtonElement));
  $("[data-add-batch]")?.addEventListener("click", () => batchDialog(null, batchCtx));
  window.addEventListener("beforeunload", (e) => {
    if (leaving) return;
    if (formDirty() || outlineDirty() || anyUploading()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  // The shell's "Publish changes" chip published the whole site: our course is up to date too.
  document.addEventListener("admin:published", () => {
    const note = $("[data-pub-note]");
    if (note) note.textContent = "Publishing. The site updates in about 2 minutes.";
  });
}

ready(() => {
  const loading = $("[data-loading]");
  const editor = $("[data-editor]");
  if (!loading || !editor) return;
  const id = Number(new URLSearchParams(location.search).get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    location.replace("/admin/courses?new=1");
    return;
  }

  const load = async () => {
    fill(loading, skeleton(4, "block"), h("p", { class: "visually-hidden", text: "Loading the course…" }));
    loading.setAttribute("aria-busy", "true");
    try {
      [course] = await Promise.all([admin("GET /api/admin/courses/:id", { id }), hostsReady()]);
    } catch (err) {
      loading.removeAttribute("aria-busy");
      const e = asApiError(err);
      fill(
        loading,
        h(
          "div",
          { class: "card" },
          errorBox(err, { what: "this course", retry: () => void load() }),
          e.status === 404 ? h("p", { class: "state" }, h("a", { class: "btn btn-secondary", href: "/admin/courses" }, icon("arrow-left"), "Back to courses")) : null,
        ),
      );
      return;
    }
    loading.removeAttribute("aria-busy");
    loading.replaceChildren();
    batchCtx.courseId = course.id;
    lists = {
      outcomes: pointsList($("[data-list=outcomes]")!, onEdit),
      forWho: pointsList($("[data-list=forWho]")!, onEdit),
      highlights: pointsList($("[data-list=highlights]")!, onEdit),
      faqs: faqList($("[data-faqs]")!, onEdit),
      glimpses: glimpseList($("[data-glimpses]")!, onEdit),
    };
    renderFormat();
    initOutline(course, {
      course: () => course,
      onSaved: (updated) => {
        course = updated;
        renderPublish();
        syncFormat();
        updateState();
      },
      onDirty: updateState,
    });
    renderAll();
    wire();
    editor.hidden = false;
    if (new URLSearchParams(location.search).get("new")) {
      toast("Draft created. Add the fee and the lessons or batches, then publish.", "info", 6000);
      history.replaceState(null, "", `/admin/courses/edit?id=${course.id}`);
    }
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  };
  void load();
});
