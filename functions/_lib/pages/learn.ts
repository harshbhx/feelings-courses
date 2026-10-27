/**
 * The course area once D1 is bound (W3), rendered live from D1:
 *
 *   /learn                          → /account (the list of the student's courses)
 *   /learn/<course>                 the course: progress, "continue", modules and lessons, certificate
 *   /learn/<course>/<lesson>        one lesson: video (W4's signed playback), notes, done tick, prev/next
 *   /learn/<course>/certificate     ask for the certificate, or correct the name on it
 *   /learn/logout                   sign out (pages/auth.ts)
 *
 * Not signed in: 302 to /signin?next=<path>. Signed in without access: the same "not in your
 * account" page for a course that doesn't exist and one the student doesn't have; an expired or
 * removed enrollment of their own says so, with a WhatsApp link.
 */
import type { LearnCourseResponse } from "../../../src/shared/api.ts";
import type { LearnLesson, PlayInfo } from "../../../src/shared/types.ts";
import { unixNow } from "../db/d1.ts";
import { ValidationError } from "../db/errors.ts";
import type { Env } from "../env.ts";
import { readForm } from "../http.ts";
import { claimCertificate, continueLesson, flatLessons, loadLearnCourse, saveProgress } from "../learn.ts";
import { playLesson } from "../play.ts";
import { readSession, requireEnrollment, type SessionRef } from "../session.ts";
import { NotImplementedError } from "../stub.ts";
import { getStudent } from "../students.ts";
import { handleLogout } from "./auth.ts";
import {
  batchLine,
  callout,
  formatClock,
  formatDate,
  formFromSameSite,
  html,
  icon,
  layout,
  loadBusiness,
  messagePage,
  page,
  pageRedirect,
  plural,
  progressLine,
  raw,
  whatsappHref,
  type Business,
  type Raw,
} from "./html.ts";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/**
 * The course-area path as segments after /learn, from a path already normalised by the gate.
 * A trailing ".html" (the static build's twin) is dropped. null for anything that can't be a page.
 */
export function learnSegments(path: string): string[] | null {
  const parts = path.replace(/\.html$/i, "").split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() !== "learn") return null;
  const rest = parts.slice(1).map((p) => p.toLowerCase());
  if (rest.length > 2 || !rest.every((p) => SLUG_RE.test(p))) return null;
  return rest;
}

function notInAccount(business: Business): Response {
  return page(
    messagePage(
      { title: "Course not found", business, signedIn: true },
      "This course isn't in your account",
      "If you bought it with a different phone number or email, sign in with that one.",
      { href: "/account", label: "My courses" },
      { icon: "magnifying-glass", tone: "info", secondary: { href: "/signin", label: "Sign in with other details" } },
    ),
    404,
  );
}

async function noAccess(env: Env, session: SessionRef, slug: string, business: Business, now: number): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT e.expires_at, e.revoked_at, c.title FROM enrollments e JOIN courses c ON c.id = e.course_id " +
      "WHERE e.student_id = ? AND c.slug = ? AND c.deleted_at IS NULL",
  )
    .bind(session.studentId, slug)
    .first<{ expires_at: number | null; revoked_at: number | null; title: string }>();
  if (!row) return notInAccount(business);
  const ended = row.revoked_at === null && row.expires_at !== null && row.expires_at <= now;
  const help = whatsappHref(business, `Hi Urmi, my access to "${row.title}" has ended. Can you help?`);
  return page(
    layout(
      { title: row.title, business, signedIn: true },
      html`<section class="card narrow state tone-warn">
  <span class="state-icon">${icon(ended ? "clock" : "lock-simple")}</span>
  <p class="eyebrow">${ended ? "Access ended" : "Access removed"}</p>
  <h1>${row.title}</h1>
  <p>${ended ? `Your access ended on ${formatDate(row.expires_at!)}. Access lasts one year from purchase.` : "Your access to this course has been removed."}</p>
  <p class="muted small">${ended ? "Your progress and certificate are kept. Message us to ask about joining again." : "If you think this is a mistake, message us and we'll look into it."}</p>
  <div class="btn-row">
    ${help ? html`<a class="btn" href="${help}" target="_blank" rel="noopener noreferrer">${icon("whatsapp")}Message us on WhatsApp</a>` : ""}
    <a class="btn btn-quiet" href="/account">Back to my courses</a>
  </div>
</section>`,
    ),
    403,
  );
}

// ---------------------------------------------------------------- pages

function tick(lesson: LearnLesson, isNext = false): Raw {
  if (lesson.progress?.completedAt) return html`<span class="tick done">${icon("check", "Done")}</span>`;
  return isNext ? html`<span class="tick next">${icon("play-fill")}</span>` : html`<span class="tick" aria-hidden="true"></span>`;
}

const minutesOf = (lessons: { minutes: number }[]) => lessons.reduce((sum, l) => sum + (l.minutes || 0), 0);

/** "Pick up at 3:12" when a lesson was left part way, else null. */
function resumeText(lesson: LearnLesson): string | null {
  const at = lesson.progress?.positionSeconds ?? 0;
  if (lesson.progress?.completedAt || at <= 5) return null;
  return `Pick up at ${formatClock(at)}`;
}

function coursePage(business: Business, course: LearnCourseResponse): Raw {
  const lessons = flatLessons(course);
  const done = lessons.filter((l) => l.progress?.completedAt).length;
  const next = continueLesson(course);
  const slug = course.course.slug;
  const e = course.enrollment;
  const nextIndex = next ? lessons.findIndex((l) => l.id === next.id) : -1;
  const resume = next ? resumeText(next) : null;
  const totalMinutes = minutesOf(lessons);
  return layout(
    { title: course.course.title, business, signedIn: true, wide: true },
    html`<div class="page-head">
  <p class="crumbs"><a href="/account">${icon("arrow-left")}My courses</a></p>
  <h1>${course.course.title}</h1>
  <ul class="meta">
    ${lessons.length ? html`<li>${icon("play-circle")}${plural(lessons.length, "lesson")}${totalMinutes ? `, ${totalMinutes} min` : ""}</li>` : ""}
    <li>${icon("clock")}${e.expiresAt ? `Access until ${formatDate(e.expiresAt)}` : "Access with no end date"}</li>
    ${course.course.certificateTitle ? html`<li>${icon("certificate")}Certificate on completion</li>` : ""}
  </ul>
</div>
${
  lessons.length
    ? html`<section class="resume${next ? "" : " is-done"}" aria-labelledby="resume-h">
  <div>
    <p class="eyebrow">${next ? (done ? `Up next · Lesson ${nextIndex + 1} of ${lessons.length}` : "Start here") : "Course complete"}</p>
    <h2 id="resume-h">${next ? next.title : "You've finished every lesson."}</h2>
    ${next ? html`<p>${next.module.title}${next.minutes ? ` · ${next.minutes} min` : ""}${resume ? ` · ${resume}` : ""}</p>` : html`<p>Watch any lesson again, as often as you like, while your access lasts.</p>`}
    ${progressLine(done, lessons.length)}
  </div>
  ${next ? html`<a class="btn" href="/learn/${slug}/${next.slug}">${icon("play-fill")}${done ? "Continue" : "Start"}: ${next.title}</a>` : ""}
</section>`
    : ""
}
${
  course.batch
    ? html`<section class="card" aria-labelledby="batch-h"><div class="cert-card"><span class="item-icon">${icon("calendar-blank")}</span><div>
  <h2 id="batch-h">Your batch</h2><p>${batchLine(course.batch)}</p>${course.batch.scheduleText ? html`<p class="muted">${course.batch.scheduleText}</p>` : ""}
</div></div></section>`
    : ""
}
${
  lessons.length
    ? course.modules.map((m, i) => {
        const moduleDone = m.lessons.filter((l) => l.progress?.completedAt).length;
        const moduleMinutes = minutesOf(m.lessons);
        return html`<section class="card module" aria-labelledby="module-${m.id}">
  <div class="module-head">
    <h2 id="module-${m.id}">Module ${i + 1}: ${m.title}</h2>
    <p>${moduleDone} of ${m.lessons.length} done${moduleMinutes ? ` · ${moduleMinutes} min` : ""}</p>
  </div>
  <ol class="lessons">
    ${m.lessons.map((l) => {
      const isNext = next?.id === l.id;
      return html`<li><a href="/learn/${slug}/${l.slug}"${isNext ? raw(` aria-current="step"`) : ""}>${tick(l, isNext)}<span class="lesson-title">${l.title}${isNext ? html`<span class="lesson-sub">${done ? "Up next" : "Start here"}</span>` : ""}</span><span class="lesson-min">${l.minutes ? `${l.minutes} min` : ""}</span></a></li>`;
    })}
  </ol>
</section>`;
      })
    : course.course.format === "in_person"
      ? html``
      : html`<section class="card state tone-info"><span class="state-icon">${icon("video-camera")}</span><p>The recorded lessons for this course will appear here.</p></section>`
}
${certificateCard(course)}`,
  );
}

function certificateCard(course: LearnCourseResponse): Raw {
  if (!course.course.certificateTitle) return html``;
  const slug = course.course.slug;
  const cert = course.certificate;
  const wrap = (body: Raw) =>
    html`<section class="card" aria-labelledby="cert-h"><div class="cert-card"><span class="item-icon">${icon("certificate")}</span><div>${body}</div></div></section>`;
  if (cert && !cert.revokedAt) {
    return wrap(html`<h2 id="cert-h">Certificate</h2>
  <p>Issued to ${cert.nameOnCertificate} on ${formatDate(cert.issuedAt)}.</p>
  <div class="btn-row"><a class="btn" href="/verify/${cert.code}">View and print</a> <a class="link-arrow" href="/learn/${slug}/certificate">Correct the name</a></div>`);
  }
  if (cert?.revokedAt) return wrap(html`<h2 id="cert-h">Certificate</h2><p>This certificate was withdrawn. Message us on WhatsApp if you think that's a mistake.</p>`);
  return course.complete
    ? wrap(html`<h2 id="cert-h">Certificate</h2><p>You've finished the course. Well done!</p><p><a class="btn" href="/learn/${slug}/certificate">Get your certificate</a></p>`)
    : wrap(html`<h2 id="cert-h">Certificate</h2><p class="muted">Finish every lesson to get your certificate.</p>`);
}

/** The course outline beside the lesson (below it on phones, folded). */
function lessonOutline(course: LearnCourseResponse, current: number, done: number, total: number): Raw {
  const slug = course.course.slug;
  return html`<aside class="lesson-aside" aria-label="Course outline">
  <div class="card">
    <details class="outline" open>
      <summary>Course outline</summary>
      ${progressLine(done, total)}
      ${course.modules.map(
        (m) => html`<p class="module-name">${m.title}</p>
      <ol class="lessons">
        ${m.lessons.map(
          (l) =>
            html`<li><a href="/learn/${slug}/${l.slug}"${l.id === current ? raw(` aria-current="page"`) : ""}>${tick(l, l.id === current)}<span class="lesson-title">${l.title}</span><span class="lesson-min">${l.minutes ? `${l.minutes} min` : ""}</span></a></li>`,
        )}
      </ol>`,
      )}
    </details>
  </div>
</aside>`;
}

function lessonPage(
  business: Business,
  course: LearnCourseResponse,
  lesson: ReturnType<typeof flatLessons>[number],
  play: PlayInfo | null,
): Raw {
  const lessons = flatLessons(course);
  const index = lessons.findIndex((l) => l.id === lesson.id);
  const prev = lessons[index - 1] ?? null;
  const next = lessons[index + 1] ?? null;
  const slug = course.course.slug;
  const doneAt = lesson.progress?.completedAt ?? null;
  const done = lessons.filter((l) => l.progress?.completedAt).length;
  const notes = (lesson.notes ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const resumeAt = play ? Math.max(play.resumeAt, 0) : 0;
  return layout(
    { title: `${lesson.title} | ${course.course.title}`, business, signedIn: true, script: true, wide: true },
    html`<p class="crumbs"><a href="/learn/${slug}">${icon("arrow-left")}${course.course.title}</a><span aria-hidden="true">·</span><span>Lesson ${index + 1} of ${lessons.length}</span></p>
<div class="lesson-layout">
<div class="lesson-main">
<div class="player${lesson.vertical ? " vertical" : ""}">
${
  play
    ? html`<span class="player-wait" aria-hidden="true">${icon("play-circle")}</span>
  <video controls playsinline preload="metadata" controlslist="nodownload" src="${play.src}"
    data-lesson-id="${lesson.id}" data-course="${slug}" data-expires="${play.expiresAt}" data-resume="${resumeAt}" aria-label="Video: ${lesson.title}">
    ${play.captions ? html`<track kind="captions" src="${play.captions}" srclang="en" label="Captions" default>` : ""}
  </video>
  <div class="watermark" aria-hidden="true">${play.watermark.name}${play.watermark.phoneMasked ? ` · ${play.watermark.phoneMasked}` : ""}</div>`
    : html`<div class="video-missing">${icon(lesson.hasVideo ? "warning-circle" : "clock")}<p>${lesson.hasVideo ? "The video can't be played right now. Please try again in a minute." : "This lesson's video is being prepared."}</p>${lesson.hasVideo ? html`<a class="btn btn-quiet btn-sm" href="/learn/${slug}/${lesson.slug}">Try again</a>` : ""}</div>`
}
</div>
${play && resumeAt > 5 && !doneAt ? html`<p class="resume-note">${icon("clock")}Picking up where you left off, at ${formatClock(resumeAt)}.</p>` : ""}
<div class="lesson-head">
  <p class="eyebrow">Module: ${lesson.module.title}</p>
  <h1>${lesson.title}</h1>
  <ul class="meta">${lesson.minutes ? html`<li>${icon("clock")}${lesson.minutes} min</li>` : ""}${doneAt ? html`<li>${icon("check-circle")}Done</li>` : ""}</ul>
</div>
<div class="actions">
  <form method="post" action="/learn/${slug}/${lesson.slug}" class="actions">
    <input type="hidden" name="action" value="${doneAt ? "undone" : "done"}">
    <button type="submit" class="btn${doneAt ? " btn-quiet" : ""}" aria-pressed="${doneAt ? "true" : "false"}">${doneAt ? "✓ Done (undo)" : next ? "Mark as done and go on" : "Mark as done"}</button>
  </form>
  ${next ? html`<a class="btn btn-quiet" href="/learn/${slug}/${next.slug}" data-next-lesson${doneAt ? "" : raw(" hidden")}>Next lesson${icon("arrow-right")}</a>` : ""}
</div>
${notes.length ? html`<section class="card notes" aria-labelledby="notes-h"><h2 id="notes-h">Notes</h2>${notes.map((p) => html`<p>${p}</p>`)}</section>` : ""}
<nav class="pager" aria-label="Previous and next lesson">
  ${
    prev
      ? html`<a href="/learn/${slug}/${prev.slug}" rel="prev">${icon("arrow-left")}<span><span class="pager-label">Previous</span><span class="pager-title">${prev.title}</span></span></a>`
      : html`<a href="/learn/${slug}">${icon("arrow-left")}<span><span class="pager-label">Back to</span><span class="pager-title">Course home</span></span></a>`
  }
  ${
    next
      ? html`<a href="/learn/${slug}/${next.slug}" rel="next"><span><span class="pager-label">Up next</span><span class="pager-title">${next.title}</span></span>${icon("arrow-right")}</a>`
      : html`<a class="pager-next" href="/learn/${slug}"><span><span class="pager-label">Last lesson</span><span class="pager-title">Course home${course.course.certificateTitle ? " and certificate" : ""}</span></span>${icon("arrow-right")}</a>`
  }
</nav>
</div>
${lessonOutline(course, lesson.id, done, lessons.length)}
</div>`,
  );
}

function certificatePage(business: Business, course: LearnCourseResponse, defaultName: string, error: string | null): Raw {
  const cert = course.certificate;
  return layout(
    { title: `Certificate | ${course.course.title}`, business, signedIn: true },
    html`<p class="crumbs"><a href="/learn/${course.course.slug}">${icon("arrow-left")}${course.course.title}</a></p>
<section class="card narrow">
  <span class="state-icon">${icon("certificate")}</span>
  <h1>${cert ? "Correct the name on your certificate" : "Get your certificate"}</h1>
  <p>${course.course.certificateTitle}</p>
  ${error ? callout("alert", error, "name-error") : ""}
  <form method="post" action="/learn/${course.course.slug}/certificate" class="form">
    <label for="name">Name to print</label>
    <input id="name" name="name" type="text" autocomplete="name" required minlength="2" maxlength="80" value="${defaultName}" aria-describedby="name-hint${error ? " name-error" : ""}"${error ? raw(` aria-invalid="true"`) : ""}>
    <p class="hint" id="name-hint">Exactly as you want it on the certificate. Anyone with the certificate's link can see this name.</p>
    <button type="submit" class="btn">${icon("seal-check")}${cert ? "Save and view" : "Get certificate"}</button>
  </form>
</section>`,
  );
}

// ---------------------------------------------------------------- the router

async function safePlay(env: Env, request: Request, slug: string, lessonId: number, now: number): Promise<PlayInfo | null> {
  try {
    const enrollment = await requireEnrollment(env, request, slug, now);
    return enrollment ? await playLesson(env, enrollment, lessonId) : null;
  } catch (err) {
    if (!(err instanceof NotImplementedError)) console.error(`learn: play failed: ${err instanceof Error ? err.message : "unknown error"}`);
    return null;
  }
}

/** Serves a /learn page from D1. `path` is the normalised path (the gate's view of the request). */
export async function handleLearnPage(request: Request, env: Env, path: string, now = unixNow()): Promise<Response> {
  const segments = learnSegments(path);
  if (segments?.[0] === "logout" && segments.length === 1) return handleLogout(request, env, now);

  const business = await loadBusiness(env.DB);
  const session = await readSession(env, request, now);
  if (!session) {
    const next = segments && segments.length ? `/learn/${segments.join("/")}` : "/account";
    return pageRedirect(`/signin?next=${encodeURIComponent(next)}`, [], 302);
  }
  if (!segments) return notInAccount(business);
  if (segments.length === 0) return pageRedirect("/account", [], 302);

  const method = request.method;
  if (!["GET", "HEAD", "POST"].includes(method)) {
    return page(messagePage({ title: "Not allowed", business }, "Not allowed", "This page can't be used that way."), 405);
  }
  if (method === "POST" && !formFromSameSite(request)) {
    return page(messagePage({ title: "Please try again", business, signedIn: true }, "Please try again", "That form came from another site, so nothing was changed."), 403);
  }

  const [slug, sub] = segments as [string, string | undefined];
  const course = await loadLearnCourse(env, session.studentId, slug, now);
  if (!course) return noAccess(env, session, slug, business, now);

  if (sub === undefined) {
    if (method === "POST") return pageRedirect(`/learn/${slug}`);
    return page(coursePage(business, course), 200, [], method);
  }

  if (sub === "certificate") {
    if (!course.course.certificateTitle) return notInAccount(business);
    const student = await getStudent(env.DB, session.studentId);
    const defaultName = course.certificate?.nameOnCertificate ?? student?.name ?? "";
    if (method === "POST") {
      const form = (await readForm(request)) ?? new URLSearchParams();
      const name = form.get("name") ?? "";
      let message: string;
      try {
        const result = await claimCertificate(env, session.studentId, slug, name, now);
        if (result.ok) return pageRedirect(`/verify/${result.certificate.code}`);
        message =
          result.reason === "course_incomplete"
            ? "Finish every lesson to get your certificate."
            : result.reason === "revoked"
              ? "This certificate can't be changed. Message us on WhatsApp."
              : "This course has no certificate.";
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        message = "Enter the name to print: 2 to 80 characters.";
      }
      return page(certificatePage(business, course, name.slice(0, 80), message), 400);
    }
    if (course.certificate?.revokedAt) return pageRedirect(`/learn/${slug}`, [], 302);
    if (!course.complete && !course.certificate) {
      return page(
        messagePage({ title: "Certificate", business, signedIn: true }, "Almost there", "Finish every lesson to get your certificate.", {
          href: `/learn/${slug}`,
          label: "Back to the course",
        }),
        200,
        [],
        method,
      );
    }
    return page(certificatePage(business, course, defaultName, null), 200, [], method);
  }

  const lesson = flatLessons(course).find((l) => l.slug === sub);
  if (!lesson) return notInAccount(business);

  if (method === "POST") {
    const form = (await readForm(request)) ?? new URLSearchParams();
    const action = form.get("action");
    if (action === "done" || action === "undone") {
      await saveProgress(
        env,
        session.studentId,
        { lessonId: lesson.id, positionSeconds: lesson.progress?.positionSeconds ?? 0, completed: action === "done" },
        now,
      );
      if (action === "done") {
        const lessons = flatLessons(course);
        const next = lessons[lessons.findIndex((l) => l.id === lesson.id) + 1];
        return pageRedirect(next ? `/learn/${slug}/${next.slug}` : `/learn/${slug}`);
      }
    }
    return pageRedirect(`/learn/${slug}/${lesson.slug}`);
  }

  const play = lesson.hasVideo ? await safePlay(env, request, slug, lesson.id, now) : null;
  return page(lessonPage(business, course, lesson, play), 200, [], method);
}

