/**
 * CSV for the admin's exports (students, payments). Opens cleanly in Excel and Google Sheets:
 * UTF-8 with a byte-order mark (names in Gujarati and Hindi survive), CRLF line ends, and every
 * field that needs it quoted.
 *
 * Formula injection: a cell starting with = + - @ (or a tab / carriage return) would run as a
 * formula in a spreadsheet. Student names and emails are typed by buyers, so such cells get a
 * leading apostrophe. Plain numbers (including negative ones) are left alone.
 */

export type CsvCell = string | number | null | undefined;

const NUMBER_RE = /^-?[0-9]+(\.[0-9]+)?$/;

export function csvCell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "number" ? String(value) : value;
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text) && !NUMBER_RE.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [header.map(csvCell).join(","), ...rows.map((row) => row.map(csvCell).join(","))];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Rupees with two decimals, for a spreadsheet column ("2999.00"). */
export function rupees(paise: number | null): string {
  if (paise === null) return "";
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** A CSV download response (no-store, attachment). `name` is a fixed file name written in code. */
export function csvResponse(name: string, csv: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
