/**
 * List filters kept in the address bar (so a reload, the back button or a shared link shows the same
 * list), paging wording, and the CSV export links. Only known values are read back: anything else in
 * the query string is ignored.
 */
import type { AdminOrdersQuery, AdminStudentsQuery } from "../../../shared/api.ts";
import type { OrderStatus } from "../../../shared/types.ts";
import { ORDER_STATUSES } from "./orders.ts";
import { isIsoDate } from "./time.ts";

const positiveInt = (v: string | null): number | undefined => (v && /^[1-9]\d{0,8}$/.test(v) ? Number(v) : undefined);

export function readStudentFilters(search: string): AdminStudentsQuery {
  const p = new URLSearchParams(search);
  const q = (p.get("q") ?? "").trim().slice(0, 100);
  return { q: q || undefined, course: positiveInt(p.get("course")), page: positiveInt(p.get("page")) };
}

export function readOrderFilters(search: string): AdminOrdersQuery {
  const p = new URLSearchParams(search);
  const status = p.get("status");
  const from = p.get("from");
  const to = p.get("to");
  return {
    status: status && (ORDER_STATUSES as readonly string[]).includes(status) ? (status as OrderStatus) : undefined,
    course: positiveInt(p.get("course")),
    from: isIsoDate(from) ? from : undefined,
    to: isIsoDate(to) ? to : undefined,
    page: positiveInt(p.get("page")),
  };
}

/** "?q=priya&course=2" (no empty values, page 1 left out), or "" when nothing is set. */
export function toSearch(filters: object): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v === undefined || v === null || v === "") continue;
    if (k === "page" && Number(v) <= 1) continue;
    p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The CSV download for the same filters (no paging). */
export function csvHref(path: "/api/admin/students.csv" | "/api/admin/orders.csv", filters: object): string {
  const { page: _page, ...rest } = filters as { page?: number };
  return path + toSearch(rest);
}

export interface PageInfo {
  page: number;
  pages: number;
  hasPrev: boolean;
  hasNext: boolean;
  /** "26–50 of 112" */
  label: string;
}

export function pageInfo(page: number, pageSize: number, total: number): PageInfo {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const p = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (p - 1) * pageSize + 1;
  const to = Math.min(total, p * pageSize);
  const n = (x: number) => x.toLocaleString("en-IN");
  return { page: p, pages, hasPrev: p > 1, hasNext: p < pages, label: total === 0 ? "None" : `${n(from)}–${n(to)} of ${n(total)}` };
}

/** True when any filter (other than the page) is set. */
export function hasFilters(filters: object): boolean {
  return Object.entries(filters).some(([k, v]) => k !== "page" && v !== undefined && v !== "");
}
