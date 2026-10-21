/**
 * The course area's one script (bundled by Astro, so CSP-safe; no inline handlers).
 *
 *  - Paints saved progress: row ticks and "Up next" (LessonList), "n of m done" counts, the ring
 *    and the outline bar (--progress), and the dashboard's "Continue where you left off" card.
 *  - Lesson pages: remembers the lesson as the last one opened, and runs "Mark as done".
 *  - Players: swaps the poster for a youtube-nocookie player on tap. Nothing loads before.
 *
 * It only reads storage and writes text and attributes; it never measures layout.
 */
import { nextLesson, onOtherTabChange, readProgress, setDone, setLast } from "./progress";

const $$ = <T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] => [
  ...root.querySelectorAll<T>(selector),
];

const rows = $$<HTMLAnchorElement>("a[data-lesson]");
const order = [...new Set(rows.map((row) => row.dataset.lesson!))];
const total = order.length;
const live = document.querySelector<HTMLElement>("[data-live]");
const page = document.querySelector<HTMLElement>("[data-lesson-page]");
const slug = page?.dataset.lessonPage ?? null;
const markButton = page?.querySelector<HTMLButtonElement>("[data-mark-done]") ?? null;

function announce(message: string): void {
  if (!live) return;
  // Clear first so the same message is read again.
  live.textContent = "";
  window.setTimeout(() => (live.textContent = message), 60);
}

function setText(selector: string, text: string, root: ParentNode = document): void {
  for (const el of $$(selector, root)) el.textContent = text;
}

function render(): number {
  const progress = readProgress();
  const done = new Set(progress.done.filter((s) => order.includes(s)));
  const upNext = nextLesson(order, progress);
  const count = done.size;

  for (const row of rows) {
    const rowSlug = row.dataset.lesson!;
    const state = done.has(rowSlug) ? "done" : rowSlug === upNext ? "next" : "todo";
    row.dataset.state = state;
    setText("[data-lesson-status]", state === "done" ? ", done" : state === "next" ? ", up next" : "", row);
  }

  for (const mod of $$("[data-module]")) {
    const inModule = $$("[data-lesson]", mod).map((row) => row.dataset.lesson!);
    setText("[data-module-done]", String(inModule.filter((s) => done.has(s)).length), mod);
  }

  setText("[data-progress-done]", String(count));
  setText("[data-progress-percent]", `${total ? Math.round((count / total) * 100) : 0}%`);
  for (const meter of $$("[data-progress-meter]")) {
    meter.style.setProperty("--progress", String(total ? count / total : 0));
  }

  renderContinue(progress.last !== null || count > 0, upNext);
  if (markButton && slug) renderMark(done.has(slug));
  return count;
}

/** The dashboard card: the next lesson, or the "finished" block. */
function renderContinue(started: boolean, upNext: string | null): void {
  const card = document.querySelector<HTMLElement>("[data-continue]");
  if (!card) return;
  const nextBlock = card.querySelector<HTMLElement>("[data-continue-next]");
  const finished = card.querySelector<HTMLElement>("[data-continue-finished]");
  if (nextBlock) nextBlock.hidden = upNext === null;
  if (finished) finished.hidden = upNext !== null;
  if (upNext === null) return;

  const row = rows.find((r) => r.dataset.lesson === upNext);
  if (!row) return;
  setText("[data-continue-label]", started ? "Continue where you left off" : "Start the course", card);
  setText("[data-continue-title]", row.dataset.title ?? "", card);
  setText("[data-continue-meta]", row.dataset.meta ?? "", card);
  setText("[data-continue-cta]", started ? `Continue lesson ${row.dataset.number}` : `Start lesson ${row.dataset.number}`, card);
  const link = card.querySelector<HTMLAnchorElement>("[data-continue-link]");
  if (link) link.href = row.getAttribute("href") ?? link.href;
}

/** "Mark as done" is the page's main action until the lesson is done; then "Next" takes over. */
function renderMark(isDone: boolean): void {
  if (!markButton) return;
  markButton.setAttribute("aria-pressed", String(isDone));
  setText("[data-mark-label]", isDone ? "Done" : "Mark as done", markButton);
  markButton.classList.toggle("btn-primary", !isDone);
  markButton.classList.toggle("btn-secondary", isDone);
  const next = page?.querySelector<HTMLElement>("[data-next]");
  next?.classList.toggle("btn-primary", isDone);
  next?.classList.toggle("btn-secondary", !isDone);
}

if (slug) setLast(slug);
render();

if (markButton && slug) {
  markButton.hidden = false;
  markButton.addEventListener("click", () => {
    const nowDone = markButton.getAttribute("aria-pressed") !== "true";
    setDone(slug, nowDone);
    const count = render();
    if (nowDone) {
      markButton.dataset.justDone = "";
      announce(`Lesson marked as done. ${count} of ${total} lessons done.`);
    } else {
      announce(`Lesson marked as not done. ${count} of ${total} lessons done.`);
    }
  });
  markButton.addEventListener("animationend", () => delete markButton.dataset.justDone);
}

// Other tabs, and pages restored from the back-forward cache, may show old ticks.
onOtherTabChange(render);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) render();
});

// The lesson outline starts open (so it is there without JavaScript); on phones and tablets it
// folds away under the lesson.
const outline = document.querySelector<HTMLDetailsElement>("[data-outline]");
if (outline && !window.matchMedia("(min-width: 64rem)").matches) outline.open = false;

// Players: the poster is a link to YouTube; a plain tap plays here instead, in privacy mode.
for (const player of $$("[data-player]")) {
  const poster = player.querySelector<HTMLAnchorElement>("[data-play]");
  const stage = player.querySelector<HTMLElement>("[data-stage]");
  const id = player.dataset.videoId;
  if (!poster || !stage || !id) continue;

  poster.addEventListener("click", (event) => {
    // Let "open in new tab" clicks through to YouTube.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const params = new URLSearchParams({ autoplay: "1", playsinline: "1", rel: "0" });
    const iframe = document.createElement("iframe");
    iframe.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params}`;
    iframe.title = player.dataset.videoTitle ?? "Lesson video";
    iframe.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    player.dataset.playing = "true";
    stage.replaceChildren(iframe);
    iframe.focus({ preventScroll: true });
    // An upright clip grows the stage: bring all of it into view, clear of the header and the
    // phone's bottom bar (the scroll paddings in global.css).
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    stage.scrollIntoView({ block: "nearest", behavior: still ? "auto" : "smooth" });
  });
}
