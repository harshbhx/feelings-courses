/** The course list for filters and pickers, loaded once per page. */
import type { AdminCourse } from "../../../shared/types";
import { admin } from "./api";
import { h } from "./dom";

let cached: Promise<AdminCourse[]> | null = null;

export function courses(): Promise<AdminCourse[]> {
  cached ??= admin("GET /api/admin/courses").catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

/** Adds every course (archived last) to a <select>, keeping its first option ("All courses"). */
export async function fillCourseSelect(select: HTMLSelectElement, selected?: number | string | null): Promise<AdminCourse[]> {
  try {
    const list = await courses();
    const sorted = [...list].sort((a, b) => Number(a.status === "archived") - Number(b.status === "archived"));
    for (const c of sorted) {
      select.append(h("option", { value: String(c.id), text: c.status === "archived" ? `${c.title} (archived)` : c.title }));
    }
    if (selected !== undefined && selected !== null) select.value = String(selected);
    return list;
  } catch {
    return [];
  }
}

export async function courseTitle(id: number): Promise<string> {
  try {
    return (await courses()).find((c) => c.id === id)?.title ?? `Course ${id}`;
  } catch {
    return `Course ${id}`;
  }
}
