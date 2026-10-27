/**
 * Batches of an in-person or hybrid course: list, add, edit, close or cancel, delete. Each change is
 * saved at once (POST/PUT/DELETE), then the list is read again.
 */
import type { AdminBatch, BatchStatus } from "../../../shared/types";
import { admin, asApiError } from "../client/api";
import { fill, h, icon } from "../client/dom";
import { field, input, select, setErrors, textarea } from "../client/fields";
import { confirmDialog, formDialog, toast } from "../client/ui";
import { notifyChanged } from "../client/events";
import { emptyBox } from "../client/states";
import { BATCH_STATUS_LABELS, batchDates, batchForm, batchInput, batchPrice, blankBatchForm, seatsLabel, type BatchFormValues } from "../lib/batches";
import { describeError } from "../lib/errors";

interface Ctx {
  courseId: number;
  courseFeeLabel: () => string;
  published: () => boolean;
  onChange: (batches: AdminBatch[]) => void;
}

function statusPill(s: BatchStatus): HTMLElement {
  return h("span", { class: s === "open" ? "pill pill-live" : s === "cancelled" ? "pill pill-bad" : "pill", text: BATCH_STATUS_LABELS[s] });
}

async function reload(ctx: Ctx): Promise<void> {
  try {
    const batches = await admin("GET /api/admin/courses/:id/batches", { id: ctx.courseId });
    ctx.onChange(batches);
  } catch (err) {
    toast(describeError(asApiError(err)).message, "error");
  }
}

export function renderBatches(root: HTMLElement, batches: AdminBatch[], ctx: Ctx): void {
  if (!batches.length) {
    fill(
      root,
      emptyBox({
        icon: "calendar-blank",
        title: "No batches yet",
        text: "Add the dates students can book. A batch can have a seat limit and its own fee.",
        action: h("button", { type: "button", class: "btn btn-secondary", onClick: () => batchDialog(null, ctx) }, icon("plus"), "Add batch"),
      }),
    );
    return;
  }
  fill(
    root,
    h(
      "ul",
      { class: "sub-list" },
      batches.map((b) =>
        h(
          "li",
          { class: "sub-item bt-item" },
          h(
            "div",
            { class: "bt-info" },
            h("span", { class: "bt-title", text: b.title }),
            h("span", { class: "bt-meta", text: [batchDates(b), b.scheduleText].filter(Boolean).join(" · ") }),
            h("span", { class: "bt-meta", text: `${seatsLabel(b)} · ${b.pricePaise === null ? `Course fee (${ctx.courseFeeLabel()})` : batchPrice(b)}` }),
          ),
          h(
            "div",
            { class: "btn-row" },
            statusPill(b.status),
            h("button", { type: "button", class: "btn btn-secondary btn-sm", "aria-label": `Edit ${b.title}`, onClick: () => batchDialog(b, ctx) }, icon("pencil-simple"), "Edit"),
            b.seatsTaken === 0
              ? h(
                  "button",
                  { type: "button", class: "icon-btn", "aria-label": `Delete ${b.title}`, onClick: () => void deleteBatch(b, ctx) },
                  icon("trash"),
                )
              : null,
          ),
        ),
      ),
    ),
  );
}

async function deleteBatch(b: AdminBatch, ctx: Ctx): Promise<void> {
  const ok = await confirmDialog({ title: `Delete “${b.title}”?`, body: "Nobody has booked it, so it can be deleted.", confirm: "Delete", danger: true });
  if (!ok) return;
  try {
    await admin("DELETE /api/admin/batches/:id", { id: b.id });
    toast("Batch deleted.");
    if (ctx.published()) notifyChanged();
    await reload(ctx);
  } catch (err) {
    toast(describeError(asApiError(err)).message, "error");
  }
}

export function batchDialog(batch: AdminBatch | null, ctx: Ctx): void {
  const v: BatchFormValues = batch ? batchForm(batch) : blankBatchForm();
  const title = input({ maxlength: 120, value: v.title, placeholder: "November weekend batch", dataset: { field: "title" } });
  const startsOn = input({ type: "date", value: v.startsOn, dataset: { field: "startsOn" } });
  const endsOn = input({ type: "date", value: v.endsOn, dataset: { field: "endsOn" } });
  const schedule = textarea({ rows: 2, maxlength: 300, placeholder: "Sat–Sun, 11 am to 4 pm", dataset: { field: "scheduleText" } });
  schedule.value = v.scheduleText;
  const price = input({ inputmode: "decimal", value: v.price, placeholder: "Course fee", dataset: { field: "pricePaise" } });
  const seats = input({ inputmode: "numeric", value: v.seats, placeholder: "No limit", dataset: { field: "seats" } });
  const status = select(
    (Object.keys(BATCH_STATUS_LABELS) as BatchStatus[]).map((s) => ({ value: s, label: BATCH_STATUS_LABELS[s] })),
    v.status,
    { dataset: { field: "status" } },
  );
  const grid = h(
    "div",
    { class: "form-grid cols-2" },
    field({ label: "Batch name", control: title, class: "span-all" }),
    field({ label: "Starts", control: startsOn }),
    field({ label: "Ends", control: endsOn, optional: true }),
    field({ label: "Timings", control: schedule, optional: true, class: "span-all" }),
    field({ label: "Fee for this batch", control: price, optional: true, affix: "₹", hint: `Empty: the course fee (${ctx.courseFeeLabel()}).` }),
    field({ label: "Seats", control: seats, optional: true, hint: batch ? `${batch.seatsTaken} booked so far.` : "Empty: no limit." }),
    field({ label: "Booking", control: status, class: "span-all", hint: "Closed: still listed for students who booked, but nobody new can book." }),
  );
  formDialog({
    title: batch ? "Edit batch" : "Add a batch",
    submit: batch ? "Save batch" : "Add batch",
    body: [grid],
    onSubmit: async (d) => {
      const r = batchInput(
        {
          title: title.value,
          startsOn: startsOn.value,
          endsOn: endsOn.value,
          scheduleText: schedule.value,
          price: price.value,
          seats: seats.value,
          status: status.value as BatchStatus,
        },
        batch?.seatsTaken ?? 0,
      );
      if (!r.ok) {
        setErrors(d.form, r.errors);
        return false;
      }
      try {
        if (batch) await admin("PUT /api/admin/batches/:id", { id: batch.id }, r.input);
        else await admin("POST /api/admin/courses/:id/batches", { id: ctx.courseId }, r.input);
        toast(batch ? "Batch saved." : "Batch added.");
        if (ctx.published()) notifyChanged();
        await reload(ctx);
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
