/**
 * Students: the searchable list, "Add student", and the student drawer. Everything goes through
 * W5's admin API; one-time sign-in links and certificates are W3's (createAccessLink, issueCertificate
 * with the admin as the actor). A student is their email (they sign in with links sent to it); the
 * phone is a contact detail. "Edit details" corrects either.
 */
import { MAX_DEVICES_PER_STUDENT } from "../../../shared/constants";
import type { AdminStudent, AdminStudentRow, EnrollmentSummary, Unix } from "../../../shared/types";
import type { AdminStudentsQuery, Page } from "../../../shared/api";
import { admin, asApiError } from "./api";
import { courses, fillCourseSelect } from "./course-options";
import { $, fill, h, icon, ready } from "./dom";
import { field, input, select, setErrors } from "./fields";
import { initials } from "./format";
import { emptyBox, errorBox, loadInto, skeleton } from "./states";
import { busy, confirmDialog, copyText, formDialog, nextId, toast } from "./ui";
import { describeError } from "../lib/errors";
import { csvHref, hasFilters, pageInfo, readStudentFilters, toSearch } from "../lib/filters";
import { formatPaise } from "../lib/money";
import { ORDER_STATUS_LABELS } from "../lib/orders";
import { ACCESS_LABELS, accessState, deviceLabel, eraseConfirmed, looksLikeEmail, normalizePhone, prettyPhone, whatsappHref } from "../lib/students";
import { ago, istDate, istDateTime, istDayStart, unixNow } from "../lib/time";
import { batchDates } from "../lib/batches";

let filters: AdminStudentsQuery = {};

// ---------------------------------------------------------------- list

function rowFor(s: AdminStudentRow): HTMLElement {
  const name = s.erased ? "Erased student" : s.name || "No name";
  return h(
    "tr",
    null,
    h(
      "td",
      { class: "dt-main" },
      h(
        "div",
        { class: "stu-name" },
        h("span", { class: "avatar avatar-soft", "aria-hidden": "true", text: s.erased ? "–" : initials(s.name ?? "?") }),
        h(
          "button",
          { type: "button", class: `dt-row-btn${s.erased ? " stu-erased" : ""}`, onClick: () => void openStudent(s.id) },
          h("span", { text: name }),
          h("span", { class: "dt-sub", text: [s.phoneMasked, s.email].filter(Boolean).join(" · ") || "No contact" }),
        ),
      ),
    ),
    h("td", { class: "num", dataset: { label: "Courses" }, text: String(s.enrollments) }),
    h("td", { class: "num", dataset: { label: "Paid" }, text: formatPaise(s.paidPaise) }),
    h("td", { dataset: { label: "Last seen" }, text: s.lastSeenAt ? ago(s.lastSeenAt, unixNow()) : "Never" }),
    h("td", { dataset: { label: "Joined" }, text: istDate(s.createdAt) }),
  );
}

function renderList(data: Page<AdminStudentRow>): void {
  const region = $("[data-region]")!;
  const pager = $("[data-pager]")!;
  const info = pageInfo(data.page, data.pageSize, data.total);
  if (!data.items.length) {
    pager.hidden = true;
    fill(
      region,
      hasFilters(filters)
        ? emptyBox({
            icon: "magnifying-glass",
            title: "No one matches",
            text: "Try part of the name, the last digits of the phone, or another course.",
            action: h("button", { type: "button", class: "btn btn-secondary", onClick: clearFilters }, "Clear the search"),
          })
        : emptyBox({
            icon: "users-three",
            title: "No students yet",
            text: "Students appear here when they pay. You can also add someone who paid at the studio.",
            action: h("button", { type: "button", class: "btn btn-primary", onClick: addStudentDialog }, icon("plus"), "Add student"),
          }),
    );
    return;
  }
  fill(
    region,
    h(
      "table",
      { class: "dt" },
      h("caption", { class: "visually-hidden", text: `Students, ${info.label}` }),
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { scope: "col", text: "Student" }),
          h("th", { scope: "col", class: "num", text: "Courses" }),
          h("th", { scope: "col", class: "num", text: "Paid" }),
          h("th", { scope: "col", text: "Last seen" }),
          h("th", { scope: "col", text: "Joined" }),
        ),
      ),
      h("tbody", null, data.items.map(rowFor)),
    ),
  );
  pager.hidden = info.pages <= 1 && data.total <= data.pageSize;
  const label = $("[data-page-label]");
  if (label) label.textContent = info.label;
  const prev = $<HTMLButtonElement>("[data-prev]");
  const next = $<HTMLButtonElement>("[data-next]");
  if (prev) prev.disabled = !info.hasPrev;
  if (next) next.disabled = !info.hasNext;
}

function syncUrl(): void {
  const open = new URLSearchParams(location.search).get("open");
  const search = toSearch({ ...filters, open: open ?? undefined });
  history.replaceState(null, "", `/admin/students${search}`);
  const exp = $<HTMLAnchorElement>("[data-export]");
  if (exp) exp.href = csvHref("/api/admin/students.csv", filters);
  const clear = $("[data-clear]");
  if (clear) clear.hidden = !hasFilters(filters);
}

function loadList(): void {
  syncUrl();
  void loadInto($("[data-region]")!, () => admin("GET /api/admin/students", {}, filters), renderList, { what: "the students", rows: 5 });
}

function clearFilters(): void {
  filters = {};
  const q = $<HTMLInputElement>("[data-q]");
  if (q) q.value = "";
  const c = $<HTMLSelectElement>("[data-course]");
  if (c) c.value = "";
  loadList();
}

// ---------------------------------------------------------------- add student

function addStudentDialog(): void {
  const name = input({ maxlength: 80, autocomplete: "off", dataset: { field: "name" } });
  const email = input({ type: "email", inputmode: "email", autocapitalize: "off", spellcheck: "false", dataset: { field: "email" } });
  const phone = input({ type: "tel", inputmode: "tel", placeholder: "98250 12345", dataset: { field: "phone" } });
  const course = select([{ value: "", label: "Don't give access yet" }], "", { dataset: { field: "courseId" } });
  void fillCourseSelect(course);
  formDialog({
    title: "Add a student",
    intro: "For someone who paid at the studio or by bank transfer. To give access now, pick the course.",
    submit: "Add student",
    body: [
      field({ label: "Name", control: name }),
      field({ label: "Email", control: email, hint: "They sign in with it: we email them a link." }),
      field({ label: "Mobile number", control: phone, optional: true, hint: "For WhatsApp. 10 digits, or an international number starting with +." }),
      field({ label: "Course access", control: course, hint: "Access lasts the course's access period (1 year by default)." }),
    ],
    onSubmit: async (d) => {
      const errors: Record<string, string> = {};
      if (!name.value.trim()) errors.name = "Write the student's name.";
      if (!looksLikeEmail(email.value)) errors.email = "Enter an email like name@example.com: they sign in with it.";
      const e164 = phone.value.trim() ? normalizePhone(phone.value) : null;
      if (phone.value.trim() && !e164) errors.phone = "Enter a 10-digit mobile number, or an international number starting with +.";
      if (Object.keys(errors).length) {
        setErrors(d.form, errors);
        return false;
      }
      try {
        const created = await admin("POST /api/admin/students", {}, {
          name: name.value.trim(),
          email: email.value.trim(),
          ...(e164 ? { phone: e164 } : {}),
          ...(course.value ? { courseId: Number(course.value) } : {}),
        });
        toast(`${created.name ?? "Student"} added.`);
        loadList();
        void openStudent(created.id);
        return true;
      } catch (err) {
        const e = asApiError(err);
        const unplaced = setErrors(d.form, e.fields);
        if (e.code === "student_exists") {
          const id = /\b(\d+)\b/.exec(e.message)?.[1];
          d.setMessage(e.message);
          if (id) {
            d.close();
            void openStudent(Number(id));
            toast("That student already exists: here they are.", "info");
          }
        } else if (!Object.keys(e.fields).length || Object.keys(unplaced).length) d.setMessage(describeError(e).message);
        return false;
      }
    },
  });
}

// ---------------------------------------------------------------- the student drawer

let drawer: HTMLDialogElement | null = null;

function closeDrawer(): void {
  drawer?.close();
}

function setOpenParam(id: number | null): void {
  const p = new URLSearchParams(location.search);
  if (id === null) p.delete("open");
  else p.set("open", String(id));
  const s = p.toString();
  history.replaceState(null, "", `/admin/students${s ? `?${s}` : ""}`);
}

async function openStudent(id: number): Promise<void> {
  if (!drawer) {
    const titleId = nextId("stu");
    drawer = h(
      "dialog",
      { class: "drawer", "aria-labelledby": titleId },
      h(
        "div",
        { class: "drawer-head" },
        h("h2", { class: "dlg-title drawer-title", id: titleId, text: "Student" }),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Close", onClick: closeDrawer }, icon("close")),
      ),
      h("div", { class: "drawer-body", dataset: { drawerBody: "" } }),
    );
    drawer.addEventListener("close", () => {
      setOpenParam(null);
      drawer?.remove();
      drawer = null;
    });
    drawer.addEventListener("click", (e) => {
      if (e.target === drawer) closeDrawer();
    });
    document.body.append(drawer);
    drawer.showModal();
  }
  setOpenParam(id);
  const body = drawer.querySelector<HTMLElement>("[data-drawer-body]")!;
  fill(body, skeleton(4));
  try {
    const s = await admin("GET /api/admin/students/:id", { id });
    renderStudent(s);
  } catch (err) {
    fill(body, errorBox(err, { what: "this student", retry: () => void openStudent(id) }));
  }
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "drawer-section" }, h("h3", { class: "section-title", text: title }), ...children);
}

function enrollmentItem(s: AdminStudent, e: EnrollmentSummary, now: Unix): HTMLElement {
  const state = accessState(e, now);
  const pct = e.totalLessons ? Math.round((e.completedLessons / e.totalLessons) * 100) : 0;
  const end = e.revokedAt ? `Ended ${istDate(e.revokedAt)}` : e.expiresAt ? `${e.expiresAt > now ? "Until" : "Ended"} ${istDate(e.expiresAt)}` : "No end date";
  return h(
    "li",
    { class: "sub-item" },
    h(
      "div",
      { class: "sub-item-head" },
      h(
        "div",
        { class: "enr-head" },
        h("span", { class: "enr-title", text: e.courseTitle }),
        h(
          "span",
          { class: "enr-meta", text: [e.batch ? `${e.batch.title}, ${batchDates(e.batch)}` : null, `From ${istDate(e.startsAt)}`, end, e.source === "manual" ? "Added by hand" : e.source === "coupon_free" ? "Free coupon" : null, e.mode === "test" ? "Test payment" : null].filter(Boolean).join(" · ") },
        ),
      ),
      h("span", { class: state === "active" ? "pill pill-live" : "pill", text: ACCESS_LABELS[state] }),
    ),
    e.totalLessons
      ? h(
          "div",
          { class: "stack-sm" },
          h("span", { class: "meter" + (pct === 100 ? " is-done" : ""), style: `--p: ${pct}%`, role: "img", "aria-label": `${pct}% of lessons done` }, h("span")),
          h("span", { class: "enr-meta", text: `${e.completedLessons} of ${e.totalLessons} lessons done${e.completedAt ? ` · finished ${istDate(e.completedAt)}` : ""}` }),
        )
      : null,
    state === "active"
      ? h(
          "div",
          { class: "btn-row" },
          h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: (ev: Event) => void revoke(s, e, ev.currentTarget as HTMLButtonElement) }, icon("x-circle"), "End access"),
        )
      : null,
  );
}

async function revoke(s: AdminStudent, e: EnrollmentSummary, button: HTMLButtonElement): Promise<void> {
  const ok = await confirmDialog({
    title: `End access to “${e.courseTitle}”?`,
    body: `${s.name ?? "The student"} can no longer watch its lessons${e.batch ? " and their batch seat is freed" : ""}. You can give access again later.`,
    confirm: "End access",
    danger: true,
  });
  if (!ok) return;
  await busy(button, async () => {
    try {
      await admin("DELETE /api/admin/enrollments/:id", { id: e.id });
      toast("Access ended.");
      await refresh(s.id);
    } catch (err) {
      toast(describeError(asApiError(err)).message, "error");
    }
  });
}

async function refresh(id: number): Promise<void> {
  try {
    renderStudent(await admin("GET /api/admin/students/:id", { id }));
  } catch (err) {
    toast(describeError(asApiError(err)).message, "error");
  }
  loadList();
}

function grantDialog(s: AdminStudent): void {
  const course = select([{ value: "", label: "Choose a course" }], "", { dataset: { field: "courseId" } });
  const batch = select([{ value: "", label: "No batch" }], "", { dataset: { field: "batchId" } });
  const batchWrap = h("div", { hidden: true }, field({ label: "Batch", control: batch, hint: "Takes a seat in the batch." }));
  const expiryName = nextId("exp");
  const custom = input({ type: "date", dataset: { field: "expiresAt" } });
  const expiry = h(
    "fieldset",
    { class: "field" },
    h("legend", { class: "field-label", text: "Access until" }),
    h(
      "div",
      { class: "choice-grid" },
      h("label", { class: "choice" }, h("input", { type: "radio", name: expiryName, value: "default", checked: true }), h("strong", { text: "The course's usual period" }), h("span", { text: "1 year unless the course says otherwise." })),
      h("label", { class: "choice" }, h("input", { type: "radio", name: expiryName, value: "never" }), h("strong", { text: "No end date" })),
      h("label", { class: "choice" }, h("input", { type: "radio", name: expiryName, value: "date" }), h("strong", { text: "Until a date" })),
    ),
  );
  const customWrap = h("div", { hidden: true }, field({ label: "Last day of access", control: custom }));
  expiry.addEventListener("change", () => {
    customWrap.hidden = expiry.querySelector<HTMLInputElement>("input:checked")?.value !== "date";
  });
  void fillCourseSelect(course);
  course.addEventListener("change", async () => {
    batch.replaceChildren(h("option", { value: "", text: "No batch" }));
    const c = (await courses()).find((x) => String(x.id) === course.value);
    const open = (c?.batches ?? []).filter((b) => b.status !== "cancelled");
    for (const b of open) batch.append(h("option", { value: String(b.id), text: `${b.title} (${batchDates(b)})${b.seats !== null && b.seatsTaken >= b.seats ? " · full" : ""}` }));
    batchWrap.hidden = !open.length;
  });
  formDialog({
    title: "Give access",
    intro: `${s.name ?? "This student"} gets the course straight away, without a payment.`,
    submit: "Give access",
    body: [field({ label: "Course", control: course }), batchWrap, expiry, customWrap],
    onSubmit: async (d) => {
      if (!course.value) {
        setErrors(d.form, { courseId: "Choose a course." });
        return false;
      }
      const mode = expiry.querySelector<HTMLInputElement>("input:checked")?.value;
      let expiresAt: Unix | null | undefined;
      if (mode === "never") expiresAt = null;
      if (mode === "date") {
        const start = istDayStart(custom.value);
        if (start === null || start + 86400 <= unixNow()) {
          setErrors(d.form, { expiresAt: "Choose a date from today on." });
          return false;
        }
        expiresAt = start + 86400 - 1; // the end of that day, India time
      }
      try {
        await admin("POST /api/admin/students/:id/enrollments", { id: s.id }, {
          courseId: Number(course.value),
          ...(batch.value ? { batchId: Number(batch.value) } : {}),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        });
        toast("Access given.");
        await refresh(s.id);
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

async function accessLink(s: AdminStudent, out: HTMLElement, button: HTMLButtonElement): Promise<void> {
  await busy(button, async () => {
    try {
      const r = await admin("POST /api/admin/students/:id/access-link", { id: s.id });
      const sent = r.emailed
        ? `Emailed to ${r.email}. It works once, until ${istDateTime(r.expiresAt)}.`
        : r.email
          ? `Couldn't email it just now. It works once, until ${istDateTime(r.expiresAt)}: share it on WhatsApp instead.`
          : `No email on file: add one with "Edit details". The link works once, until ${istDateTime(r.expiresAt)}: share it on WhatsApp.`;
      fill(
        out,
        h("p", { class: "field-hint", text: sent }),
        h(
          "div",
          { class: "btn-row" },
          h("a", { class: "btn btn-secondary btn-sm", href: r.whatsappUrl, target: "_blank", rel: "noopener" }, icon("whatsapp"), "Share on WhatsApp"),
          h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: () => void copyText(r.url, "Link copied") }, icon("copy"), "Copy link"),
        ),
      );
      if (r.emailed) toast("Sign-in link emailed.");
    } catch (err) {
      fill(out, h("p", { class: "field-hint", text: describeError(asApiError(err)).message }));
    }
  });
}

/** Correct the name, the email (how they sign in) or the phone. */
function editDetailsDialog(s: AdminStudent): void {
  const name = input({ value: s.name ?? "", maxlength: 80, autocomplete: "off", dataset: { field: "name" } });
  const email = input({ type: "email", inputmode: "email", value: s.email ?? "", autocapitalize: "off", spellcheck: "false", dataset: { field: "email" } });
  const phone = input({ type: "tel", inputmode: "tel", value: s.phone ?? "", placeholder: "98250 12345", dataset: { field: "phone" } });
  formDialog({
    title: "Edit details",
    intro: "A new email ends the sign-in links already sent. Devices stay signed in: sign them out too if the old email wasn't theirs.",
    submit: "Save",
    body: [
      field({ label: "Name", control: name }),
      field({ label: "Email", control: email, hint: "They sign in with it." }),
      field({ label: "Mobile number", control: phone, optional: true }),
    ],
    onSubmit: async (d) => {
      const errors: Record<string, string> = {};
      if (!name.value.trim()) errors.name = "Write the student's name.";
      if (!looksLikeEmail(email.value)) errors.email = "Enter an email like name@example.com.";
      const e164 = phone.value.trim() ? normalizePhone(phone.value) : null;
      if (phone.value.trim() && !e164) errors.phone = "Enter a 10-digit mobile number, or an international number starting with +.";
      if (Object.keys(errors).length) {
        setErrors(d.form, errors);
        return false;
      }
      try {
        await admin("PUT /api/admin/students/:id", { id: s.id }, { name: name.value.trim(), email: email.value.trim(), phone: e164 });
        toast("Details saved.");
        await refresh(s.id);
        loadList();
        return true;
      } catch (err) {
        const e = asApiError(err);
        const unplaced = setErrors(d.form, e.fields);
        if (!Object.keys(e.fields).length || Object.keys(unplaced).length) d.setMessage(describeError(e).message);
        return false;
      }
    },
  });
}

function certificateDialog(s: AdminStudent): void {
  const options = s.enrollments.map((e) => ({ value: String(e.courseId), label: e.courseTitle }));
  const course = select(options, options[0]?.value ?? "", { dataset: { field: "courseId" } });
  const name = input({ value: s.name ?? "", maxlength: 80, dataset: { field: "name" } });
  formDialog({
    title: "Issue a certificate",
    intro: "Issue or re-issue a certificate, for example to correct the spelling of a name.",
    submit: "Issue certificate",
    body: [field({ label: "Course", control: course }), field({ label: "Name on the certificate", control: name, hint: "Exactly as it should be printed." })],
    onSubmit: async (d) => {
      const n = name.value.trim();
      if (n.length < 2 || n.length > 80) {
        setErrors(d.form, { name: "Write the name, 2 to 80 characters." });
        return false;
      }
      try {
        await admin("POST /api/admin/students/:id/certificate", { id: s.id }, { courseId: Number(course.value), name: n });
        toast("Certificate issued.");
        await refresh(s.id);
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

function eraseDialog(s: AdminStudent): void {
  const typed = input({ autocomplete: "off", dataset: { field: "confirm" } });
  const expected = s.name ?? "erase";
  formDialog({
    title: "Erase this student's personal data?",
    intro: `This removes ${s.name ?? "their"} name, phone, email and devices, and ends their access. Payment records and invoice numbers stay (business records). It can't be undone.`,
    submit: "Erase for good",
    danger: true,
    body: [field({ label: `Type “${expected}” to confirm`, control: typed })],
    onSubmit: async (d) => {
      if (!eraseConfirmed(typed.value, s.name)) {
        setErrors(d.form, { confirm: `Type “${expected}” exactly.` });
        return false;
      }
      try {
        await admin("POST /api/admin/students/:id/erase", { id: s.id }, { confirm: true });
        toast("Personal data erased.");
        await refresh(s.id);
        return true;
      } catch (err) {
        d.setMessage(describeError(asApiError(err)).message);
        return false;
      }
    },
  });
}

function renderStudent(s: AdminStudent): void {
  if (!drawer) return;
  const title = drawer.querySelector(".drawer-title");
  if (title) title.textContent = s.erasedAt ? "Erased student" : s.name || "Student";
  const body = drawer.querySelector<HTMLElement>("[data-drawer-body]")!;
  const now = unixNow();
  const wa = whatsappHref(s.phone);
  const linkOut = h("div", { class: "stack-sm", "aria-live": "polite" });

  const contact = section(
    "Contact",
    s.erasedAt ? h("p", { class: "notice" }, icon("info"), h("span", { text: `Personal data erased on ${istDate(s.erasedAt)}. Payment records are kept.` })) : null,
    h(
      "dl",
      { class: "kv" },
      h("dt", { text: "Email (sign-in)" }),
      h("dd", { text: s.email ?? "None: add one so they can sign in" }),
      h("dt", { text: "Phone" }),
      h("dd", { text: prettyPhone(s.phone) }),
      h("dt", { text: "Joined" }),
      h("dd", { text: istDate(s.createdAt) }),
    ),
    !s.erasedAt
      ? h(
          "div",
          { class: "contact-actions" },
          wa ? h("a", { class: "btn btn-secondary btn-sm", href: wa, target: "_blank", rel: "noopener" }, icon("whatsapp"), "WhatsApp") : null,
          s.phone ? h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: () => void copyText(s.phone!, "Phone copied") }, icon("copy"), "Copy phone") : null,
          h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: () => editDetailsDialog(s) }, icon("pencil-simple"), "Edit details"),
        )
      : null,
  );

  const access = section(
    "Courses",
    s.enrollments.length ? h("ul", { class: "sub-list" }, s.enrollments.map((e) => enrollmentItem(s, e, now))) : h("p", { class: "field-hint", text: "No course access yet." }),
    !s.erasedAt ? h("div", null, h("button", { type: "button", class: "btn btn-secondary btn-sm", onClick: () => grantDialog(s) }, icon("plus"), "Give access")) : null,
  );

  const payments = section(
    "Payments",
    s.orders.length
      ? h(
          "ul",
          { class: "sub-list" },
          s.orders.map((o) =>
            h(
              "li",
              { class: "sub-item" },
              h(
                "a",
                { class: "sub-item-head", href: `/admin/payments?open=${o.id}` },
                h("span", { class: "enr-head" }, h("span", { class: "enr-title", text: `${formatPaise(o.amountPaise)} · ${o.courseTitle}` }), h("span", { class: "enr-meta", text: `${istDateTime(o.createdAt)}${o.invoiceNo ? ` · ${o.invoiceNo}` : ""}${o.mode === "test" ? " · test" : ""}` })),
                h("span", { class: o.status === "paid" ? "pill pill-live" : "pill", text: ORDER_STATUS_LABELS[o.status] }),
              ),
            ),
          ),
        )
      : h("p", { class: "field-hint", text: "No payments." }),
  );

  const devices = section(
    "Signed-in devices",
    s.sessions.length
      ? h(
          "ul",
          { class: "sub-list" },
          s.sessions.map((d) => h("li", { class: "sub-item" }, h("span", { class: "enr-title" }, icon("device-mobile"), " ", deviceLabel(d.userAgent)), h("span", { class: "enr-meta", text: `Last used ${ago(d.lastSeenAt, now)} · signed in ${istDate(d.createdAt)}` }))),
        )
      : h("p", { class: "field-hint", text: "Not signed in anywhere." }),
    h("p", { class: "field-hint", text: `Up to ${MAX_DEVICES_PER_STUDENT} devices. Signing in on another signs out the oldest.` }),
    !s.erasedAt
      ? h(
          "div",
          { class: "btn-row" },
          s.sessions.length
            ? h(
                "button",
                {
                  type: "button",
                  class: "btn btn-ghost btn-sm",
                  onClick: async (ev: Event) => {
                    const ok = await confirmDialog({ title: "Sign out every device?", body: "They'll need a new sign-in link (we email one when they ask) to get back in.", confirm: "Sign out all" });
                    if (!ok) return;
                    await busy(ev.currentTarget as HTMLButtonElement, async () => {
                      try {
                        await admin("POST /api/admin/students/:id/signout-all", { id: s.id });
                        toast("Signed out everywhere.");
                        await refresh(s.id);
                      } catch (err) {
                        toast(describeError(asApiError(err)).message, "error");
                      }
                    });
                  },
                },
                icon("sign-out"),
                "Sign out all devices",
              )
            : null,
          h(
            "button",
            { type: "button", class: "btn btn-secondary btn-sm", onClick: (ev: Event) => void accessLink(s, linkOut, ev.currentTarget as HTMLButtonElement) },
            icon("link-simple"),
            "Email a sign-in link",
          ),
        )
      : null,
    linkOut,
  );

  const certs = section(
    "Certificates",
    s.certificates.length
      ? h(
          "ul",
          { class: "sub-list" },
          s.certificates.map((c) =>
            h(
              "li",
              { class: "sub-item" },
              h("span", { class: "enr-title", text: `${c.courseTitle}: ${c.nameOnCertificate}` }),
              h("span", { class: "enr-meta", text: `${c.revokedAt ? "Withdrawn" : "Issued"} ${istDate(c.revokedAt ?? c.issuedAt)} · code ${c.code}` }),
              c.revokedAt ? null : h("a", { class: "link-btn", href: c.verifyUrl, target: "_blank", rel: "noopener" }, "Check page", icon("arrow-square-out")),
            ),
          ),
        )
      : h("p", { class: "field-hint", text: "None yet. Students get one when they finish all the lessons." }),
    !s.erasedAt && s.enrollments.length ? h("div", null, h("button", { type: "button", class: "btn btn-ghost btn-sm", onClick: () => certificateDialog(s) }, icon("certificate"), "Issue a certificate")) : null,
  );

  const danger = !s.erasedAt
    ? section(
        "Personal data",
        h(
          "div",
          { class: "danger-box" },
          h("p", { class: "field-hint", text: "If a student asks to be forgotten (DPDP), erase their personal data. Payment records stay." }),
          h("div", null, h("button", { type: "button", class: "btn btn-danger btn-sm", onClick: () => eraseDialog(s) }, icon("trash"), "Erase personal data")),
        ),
      )
    : null;

  fill(body, contact, access, payments, devices, certs, danger);
}

// ---------------------------------------------------------------- start

ready(() => {
  filters = readStudentFilters(location.search);
  const q = $<HTMLInputElement>("[data-q]");
  const course = $<HTMLSelectElement>("[data-course]");
  if (q) q.value = filters.q ?? "";
  if (course) void fillCourseSelect(course, filters.course ?? null);

  let timer = 0;
  q?.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      filters = { ...filters, q: q.value.trim() || undefined, page: undefined };
      loadList();
    }, 300);
  });
  $("[data-filters]")?.addEventListener("submit", (e) => {
    e.preventDefault();
    window.clearTimeout(timer);
    filters = { ...filters, q: q?.value.trim() || undefined, page: undefined };
    loadList();
  });
  course?.addEventListener("change", () => {
    filters = { ...filters, course: course.value ? Number(course.value) : undefined, page: undefined };
    loadList();
  });
  $("[data-clear]")?.addEventListener("click", clearFilters);
  $("[data-prev]")?.addEventListener("click", () => {
    filters = { ...filters, page: Math.max(1, (filters.page ?? 1) - 1) };
    loadList();
  });
  $("[data-next]")?.addEventListener("click", () => {
    filters = { ...filters, page: (filters.page ?? 1) + 1 };
    loadList();
  });
  $("[data-add]")?.addEventListener("click", addStudentDialog);

  loadList();
  const open = Number(new URLSearchParams(location.search).get("open"));
  if (Number.isInteger(open) && open > 0) void openStudent(open);
  if (new URLSearchParams(location.search).get("add")) addStudentDialog();
});
