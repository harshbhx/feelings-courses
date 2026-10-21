/**
 * Lesson progress, kept in this browser only: localStorage `fbc-progress`.
 *
 *   { "v": 1, "done": ["know-your-skin-type", …], "last": "prep-and-priming" }
 *
 * `done` holds lesson slugs (src/data/lessons.ts) and `last` the lesson opened most recently, for
 * "Continue where you left off". Storage can be missing or blocked (private windows, strict
 * settings): every read and write is guarded, and the page then keeps ticks for the visit only.
 */

export const STORAGE_KEY = "fbc-progress";

export interface Progress {
  done: string[];
  last: string | null;
}

const empty = (): Progress => ({ done: [], last: null });
let memory: Progress = empty();

function clean(value: unknown): Progress {
  if (!value || typeof value !== "object") return empty();
  const { done, last } = value as { done?: unknown; last?: unknown };
  return {
    done: Array.isArray(done) ? [...new Set(done.filter((s): s is string => typeof s === "string"))] : [],
    last: typeof last === "string" ? last : null,
  };
}

export function readProgress(): Progress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) memory = clean(JSON.parse(raw));
  } catch {
    // Blocked or broken storage: keep what this visit knows.
  }
  return { done: [...memory.done], last: memory.last };
}

function save(progress: Progress): void {
  memory = progress;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...progress }));
  } catch {
    // Not saved beyond this visit; the page still shows it.
  }
}

export function setDone(slug: string, done: boolean): Progress {
  const progress = readProgress();
  const set = new Set(progress.done);
  if (done) set.add(slug);
  else set.delete(slug);
  progress.done = [...set];
  save(progress);
  return progress;
}

export function setLast(slug: string): void {
  const progress = readProgress();
  if (progress.last === slug) return;
  progress.last = slug;
  save(progress);
}

/** Calls back when another tab changes the progress. */
export function onOtherTabChange(callback: () => void): void {
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) callback();
  });
}

/**
 * The lesson to continue with: the last one opened if it isn't done, else the first lesson not
 * done after it, else the first not done at all. null when every lesson is done.
 */
export function nextLesson(order: string[], progress: Progress): string | null {
  const done = new Set(progress.done);
  const last = progress.last !== null ? order.indexOf(progress.last) : -1;
  if (last !== -1 && !done.has(order[last]!)) return order[last]!;
  const after = order.slice(last + 1).find((slug) => !done.has(slug));
  return after ?? order.find((slug) => !done.has(slug)) ?? null;
}
