/**
 * The student drawer: a native modal <dialog> (.drawer), a bottom sheet on phones and a side panel
 * from 768px. Escape, the close button and a tap on the backdrop close it; focus goes back to the
 * row that opened it. Shows the course progress, every lesson (done or not) and the payments.
 */
import { $, fill, h, icon } from "../client/dom";
import { ago, fullDate, initials, inr, maskPhone, plural } from "../client/format";
import { lessonStates, PROGRESS_LABELS, type StudentRow } from "../../../lib/demo-store-students";
import { methodText, refundButton, refundNotice, statusPill, txnDate } from "../payments/txn-ui";

let opener: HTMLElement | null = null;
let onClose: (() => void) | null = null;
let wired = false;

function dialog(): HTMLDialogElement | null {
  return $<HTMLDialogElement>("[data-student-drawer]");
}

function wire(dlg: HTMLDialogElement): void {
  if (wired) return;
  wired = true;

  dlg.addEventListener("close", () => {
    const back = opener;
    opener = null;
    onClose?.();
    // Native dialogs usually return focus by themselves; make sure, for the row's button.
    if (back && back.isConnected) back.focus({ preventScroll: false });
  });

  // A click on the backdrop (outside the panel) closes. Measured on the click, not before.
  dlg.addEventListener("click", (event) => {
    if (event.target !== dlg) return;
    const box = dlg.getBoundingClientRect();
    const { clientX: x, clientY: y } = event;
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) dlg.close();
  });

  dlg.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (target?.closest("[data-drawer-close]")) dlg.close();
    else if (target?.closest("[data-refund]")) refundNotice();
  });
}

function section(id: string, title: string, ...children: (Node | null)[]): HTMLElement {
  return h("section", { class: "stu-d-section", "aria-labelledby": id }, h("h3", { id, class: "stu-d-h", text: title }), ...children);
}

function fact(label: string, value: string | Node): HTMLElement {
  return h("div", { class: "stu-d-fact" }, h("dt", { text: label }), h("dd", null, value));
}

function courseSection(s: StudentRow): HTMLElement {
  const meter = h("span", { class: `meter stu-d-meter${s.progress >= 100 ? " is-done" : ""}`, "aria-hidden": "true" }, h("span"));
  meter.style.setProperty("--p", `${s.progress}%`);
  return section(
    "stu-d-course",
    "Course",
    h(
      "div",
      { class: "stu-d-course" },
      h("p", { class: "stu-d-course-title", text: s.courseTitle }),
      h(
        "p",
        { class: "stu-d-progress" },
        h("strong", { class: "num", text: `${s.progress}%` }),
        h("span", { text: `${s.lessonsDone} of ${plural(s.lessonsTotal, "lesson")} done · ${PROGRESS_LABELS[s.band]}` }),
      ),
      meter,
      h(
        "dl",
        { class: "stu-d-facts" },
        fact("Enrolled", fullDate(new Date(s.enrolledOn))),
        fact("Last active", s.lessonsDone ? ago(new Date(s.lastActive)) : "Hasn’t started yet"),
        fact("City", s.city),
        fact("Phone", h("span", { class: "num", text: maskPhone(s.phone) })),
      ),
    ),
  );
}

function lessonsSection(s: StudentRow): HTMLElement {
  const modules = lessonStates(s);
  return section(
    "stu-d-lessons",
    "Lessons",
    h(
      "ol",
      { class: "stu-d-modules" },
      modules.map((m, mi) =>
        h(
          "li",
          { class: "stu-d-module" },
          h(
            "p",
            { class: "stu-d-module-head" },
            h("span", { text: `${mi + 1}. ${m.title}` }),
            h("span", { class: "stu-d-module-count num", text: `${m.done}/${m.lessons.length}` }),
          ),
          h(
            "ul",
            { class: "stu-d-lessons" },
            m.lessons.map((l) =>
              h(
                "li",
                { class: l.done ? "is-done" : undefined },
                icon(l.done ? "check-circle" : "circle", "icon stu-d-tick"),
                h("span", { class: "stu-d-lesson" }, l.title, h("span", { class: "visually-hidden", text: l.done ? ", done" : ", not done yet" })),
                h("span", { class: "stu-d-min num", text: `${l.minutes} min` }),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function paymentsSection(s: StudentRow): HTMLElement {
  const list = s.payments.length
    ? h(
        "ul",
        { class: "stu-d-pays" },
        s.payments.map((p) =>
          h(
            "li",
            { class: "stu-d-pay" },
            h(
              "div",
              { class: "stu-d-pay-top" },
              h("strong", { class: "num stu-d-amt", text: inr(p.amount) }),
              statusPill(p.status),
            ),
            h("p", { class: "stu-d-pay-meta", text: `${methodText(p)} · ${txnDate(p.at)}` }),
            h(
              "p",
              { class: "stu-d-pay-meta" },
              h("span", { class: "txn-id", text: p.id }),
              p.coupon ? ` · Coupon ${p.coupon}` : null,
              p.refundedAt ? ` · Refunded ${fullDate(new Date(p.refundedAt))}` : null,
            ),
            h(
              "div",
              { class: "stu-d-pay-actions" },
              p.status === "captured" ? refundButton(p) : null,
              h(
                "a",
                { class: "link-btn", href: `/admin/payments?q=${encodeURIComponent(p.id)}` },
                "See in payments",
                icon("arrow-right"),
              ),
            ),
          ),
        ),
      )
    : h("p", { class: "muted", text: "No payments for this student." });
  return section("stu-d-payments", "Payments", list);
}

/** Opens the drawer for a student. `closed` runs when it closes. */
export function openStudent(s: StudentRow, from: HTMLElement | null, closed?: () => void): void {
  const dlg = dialog();
  if (!dlg) return;
  wire(dlg);
  if (dlg.open) dlg.close();

  const head = $("[data-drawer-head]", dlg);
  const body = $("[data-drawer-body]", dlg);
  if (!head || !body) return;

  fill(
    head,
    h("span", { class: "avatar stu-d-av", "aria-hidden": "true", text: initials(s.name) }),
    h(
      "div",
      { class: "stu-d-who" },
      h("h2", { id: "stu-d-name", class: "stu-d-name", text: s.name }),
      h(
        "p",
        { class: "stu-d-sub" },
        `Student since ${fullDate(new Date(s.enrolledOn))}`,
        s.refunded ? h("span", { class: "stu-tag", text: "Refunded" }) : null,
      ),
    ),
    h("button", { type: "button", class: "icon-btn stu-d-close", "aria-label": "Close", "data-drawer-close": "" }, icon("close")),
  );

  fill(
    body,
    courseSection(s),
    lessonsSection(s),
    paymentsSection(s),
    h("p", { class: "demo-note stu-d-note" }, icon("info"), "Example student (demo data). Phone numbers are masked."),
  );

  opener = from;
  onClose = closed ?? null;
  dlg.scrollTop = 0;
  dlg.showModal();
  ($<HTMLButtonElement>("[data-drawer-close]", dlg) ?? dlg).focus();
}
