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
  formatDate,
  formFromSameSite,
  html,
  layout,
  loadBusiness,
  messagePage,
  page,
  pageRedirect,
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
      html`<section class="card narrow">
  <h1>${row.title}</h1>
  <p>${ended ? `Your access ended on ${formatDate(row.expires_at!)}. Access lasts one year from purchase.` : "Your access to this course has been removed."}</p>
  ${help ? html`<p><a class="btn" href="${help}" target="_blank" rel="noopener noreferrer">Message us on WhatsApp</a></p>` : ""}
  <p><a href="/account">Back to my courses</a></p>
</section>`,
    ),
    403,
  );
}

// ---------------------------------------------------------------- pages

function tick(lesson: LearnLesson): Raw {
  return lesson.progress?.completedAt
    ? html`<span class="tick done" aria-label="Done">✓</span>`
    : html`<span class="tick" aria-hidden="true"></span>`;
}

function coursePage(business: Business, course: LearnCourseResponse): Raw {
  const lessons = flatLessons(course);
  const done = lessons.filter((l) => l.progress?.completedAt).length;
  const next = continueLesson(course);
  const slug = course.course.slug;
  const e = course.enrollment;
  return layout(
    { title: course.course.title, business, signedIn: true },
    html`<p class="crumbs"><a href="/account">My courses</a></p>
<h1>${course.course.title}</h1>
<p class="muted">${e.expiresAt ? `Access until ${formatDate(e.expiresAt)}` : "Access with no end date"}</p>
${
  course.batch
    ? html`<section class="card"><h2>Your batch</h2><p>${course.batch.title}, from ${course.batch.startsOn}${course.batch.endsOn ? ` to ${course.batch.endsOn}` : ""}</p>${course.batch.scheduleText ? html`<p class="muted">${course.batch.scheduleText}</p>` : ""}</section>`
    : ""
}
${
  lessons.length
    ? html`<section class="card">
  <p class="progress-line"><progress max="${lessons.length}" value="${done}">${done} of ${lessons.length}</progress>
  <span>${done} of ${lessons.length} lessons done</span></p>
  ${next ? html`<p><a class="btn" href="/learn/${slug}/${next.slug}">${done ? "Continue" : "Start"}: ${next.title}</a></p>` : html`<p>You've finished every lesson.</p>`}
</section>
${course.modules.map(
  (m, i) => html`<section class="card">
  <h2>Module ${i + 1}: ${m.title}</h2>
  <ol class="lessons">
    ${m.lessons.map(
      (l) => html`<li><a href="/learn/${slug}/${l.slug}">${tick(l)}<span class="lesson-title">${l.title}</span><span class="muted">${l.minutes ? `${l.minutes} min` : ""}</span></a></li>`,
    )}
  </ol>
</section>`,
)}`
    : course.course.format === "in_person"
      ? html``
      : html`<section class="card"><p>The recorded lessons for this course will appear here.</p></section>`
}
${certificateCard(course)}`,
  );
}

function certificateCard(course: LearnCourseResponse): Raw {
  if (!course.course.certificateTitle) return html``;
  const slug = course.course.slug;
  const cert = course.certificate;
  if (cert && !cert.revokedAt) {
    return html`<section class="card"><h2>Certificate</h2>
  <p>Issued to ${cert.nameOnCertificate} on ${formatDate(cert.issuedAt)}.</p>
  <p><a class="btn" href="/verify/${cert.code}">View and print</a> <a href="/learn/${slug}/certificate">Correct the name</a></p></section>`;
  }
  if (cert?.revokedAt) return html`<section class="card"><h2>Certificate</h2><p>This certificate was withdrawn. Message us on WhatsApp if you think that's a mistake.</p></section>`;
  return course.complete
    ? html`<section class="card"><h2>Certificate</h2><p>You've finished the course.</p><p><a class="btn" href="/learn/${slug}/certificate">Get your certificate</a></p></section>`
    : html`<section class="card"><h2>Certificate</h2><p class="muted">Finish every lesson to get your certificate.</p></section>`;
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
  const notes = (lesson.notes ?? "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return layout(
    { title: `${lesson.title} | ${course.course.title}`, business, signedIn: true, script: true },
    html`<p class="crumbs"><a href="/learn/${slug}">${course.course.title}</a> · Lesson ${index + 1} of ${lessons.length}</p>
<div class="player${lesson.vertical ? " vertical" : ""}">
${
  play
    ? html`<video controls playsinline preload="metadata" controlslist="nodownload" src="${play.src}"
    data-lesson-id="${lesson.id}" data-resume="${Math.max(play.resumeAt, 0)}">
    ${play.captions ? html`<track kind="captions" src="${play.captions}" srclang="en" label="Captions" default>` : ""}
  </video>
  <div class="watermark" aria-hidden="true">${play.watermark.name}${play.watermark.phoneMasked ? ` · ${play.watermark.phoneMasked}` : ""}</div>`
    : html`<div class="video-missing"><p>${lesson.hasVideo ? "The video can't be played right now. Please try again in a minute." : "This lesson's video is being prepared."}</p></div>`
}
</div>
<h1>${lesson.title}</h1>
<p class="muted">Module: ${lesson.module.title}${lesson.minutes ? ` · ${lesson.minutes} min` : ""}</p>
<form method="post" action="/learn/${slug}/${lesson.slug}" class="actions">
  <input type="hidden" name="action" value="${doneAt ? "undone" : "done"}">
  <button type="submit" class="btn${doneAt ? " btn-quiet" : ""}" aria-pressed="${doneAt ? "true" : "false"}">${doneAt ? "✓ Done (undo)" : "Mark as done"}</button>
</form>
${notes.length ? html`<section class="card notes"><h2>Notes</h2>${notes.map((p) => html`<p>${p}</p>`)}</section>` : ""}
<nav class="pager" aria-label="Previous and next lesson">
  ${prev ? html`<a href="/learn/${slug}/${prev.slug}" rel="prev">← ${prev.title}</a>` : html`<a href="/learn/${slug}">← Course home</a>`}
  ${next ? html`<a href="/learn/${slug}/${next.slug}" rel="next">${next.title} →</a>` : html`<a href="/learn/${slug}">Course home →</a>`}
</nav>`,
  );
}

function certificatePage(business: Business, course: LearnCourseResponse, defaultName: string, error: string | null): Raw {
  const cert = course.certificate;
  return layout(
    { title: `Certificate | ${course.course.title}`, business, signedIn: true },
    html`<p class="crumbs"><a href="/learn/${course.course.slug}">${course.course.title}</a></p>
<section class="card narrow">
  <h1>${cert ? "Correct the name on your certificate" : "Get your certificate"}</h1>
  <p>${course.course.certificateTitle}</p>
  ${error ? html`<p class="alert" role="alert">${error}</p>` : ""}
  <form method="post" action="/learn/${course.course.slug}/certificate" class="form">
    <label for="name">Name to print</label>
    <input id="name" name="name" type="text" autocomplete="name" required minlength="2" maxlength="80" value="${defaultName}">
    <p class="hint">Exactly as you want it on the certificate. Anyone with the certificate's link can see this name.</p>
    <button type="submit" class="btn">${cert ? "Save and view" : "Get certificate"}</button>
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

