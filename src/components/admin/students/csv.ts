/**
 * "Export CSV" on the Students screen: builds the file in the browser from the rows on screen
 * (after search and filters) and downloads it. Only ever runs on a click; nothing is uploaded.
 */
import { maskPhone } from "../client/format";
import { ymd } from "../../../lib/demo-store";
import { PROGRESS_LABELS, STATUS_LABELS, type StudentRow } from "../../../lib/demo-store-students";

const COLUMNS: [string, (s: StudentRow) => string | number][] = [
  ["Name", (s) => s.name],
  ["City", (s) => s.city],
  ["Phone (masked)", (s) => maskPhone(s.phone)],
  ["Course", (s) => s.courseTitle],
  ["Progress (%)", (s) => s.progress],
  ["Lessons done", (s) => s.lessonsDone],
  ["Lessons in course", (s) => s.lessonsTotal],
  ["Stage", (s) => PROGRESS_LABELS[s.band]],
  ["Enrolled on", (s) => ymd(new Date(s.enrolledOn))],
  ["Last active", (s) => ymd(new Date(s.lastActive))],
  ["Payment id", (s) => s.paymentId],
  ["Amount (INR)", (s) => s.amount],
  ["Payment status", (s) => STATUS_LABELS[s.payments.find((p) => p.id === s.paymentId)?.status ?? "captured"]],
  ["Coupon", (s) => s.coupon ?? ""],
  ["Data", () => "Demo (example student)"],
];

/** One CSV field: quoted when needed, and never read as a formula by a spreadsheet. */
function field(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function studentsCsv(rows: StudentRow[]): string {
  const lines = [COLUMNS.map(([name]) => field(name)).join(",")];
  for (const s of rows) lines.push(COLUMNS.map(([, get]) => field(get(s))).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Downloads the rows as students-demo-YYYY-MM-DD.csv. Returns the file name. */
export function downloadStudentsCsv(rows: StudentRow[]): string {
  const name = `feelings-students-demo-${ymd(new Date())}.csv`;
  // A byte-order mark so Excel opens the file as UTF-8.
  const blob = new Blob(["﻿", studentsCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
}
