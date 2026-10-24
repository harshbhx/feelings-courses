// Lesson pages (functions/_lib/pages/learn.ts): resumes the video where the student left it and
// saves their place with PUT /api/learn/progress (every 15 s while playing, on pause, when the
// tab is hidden). Watching to the end marks the lesson done. Without this file the page still
// works: the "Mark as done" button is a plain form.
const video = document.querySelector("video[data-lesson-id]");

if (video instanceof HTMLVideoElement) {
  const lessonId = Number(video.dataset.lessonId);
  const resume = Number(video.dataset.resume) || 0;
  let lastSent = -1;
  let completedSent = false;
  let timer = 0;

  // The player shows a quiet loading mark until the first frame is ready.
  const player = video.closest(".player");
  const ready = () => player?.classList.add("ready");
  if (video.readyState >= 2) ready();
  else video.addEventListener("loadeddata", ready, { once: true });

  video.addEventListener(
    "loadedmetadata",
    () => {
      if (resume > 5 && (!Number.isFinite(video.duration) || resume < video.duration - 5)) video.currentTime = resume;
    },
    { once: true },
  );

  const send = (completed) => {
    const position = Math.floor(video.currentTime || 0);
    if (!completed && Math.abs(position - lastSent) < 5) return;
    lastSent = position;
    const body = { lessonId, positionSeconds: position };
    if (completed) body.completed = true;
    fetch("/api/learn/progress", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      keepalive: true,
    })
      .then((response) => {
        if (completed && response.ok) markDoneButton();
      })
      .catch(() => {
        // Offline or signed out: the next save (or the button) catches up.
      });
  };

  const markDoneButton = () => {
    const form = document.querySelector("form.actions");
    const input = form?.querySelector('input[name="action"]');
    const button = form?.querySelector("button");
    if (!(input instanceof HTMLInputElement) || !(button instanceof HTMLButtonElement)) return;
    input.value = "undone";
    button.textContent = "✓ Done (undo)";
    button.setAttribute("aria-pressed", "true");
    button.classList.add("btn-quiet");
    // The next lesson is one tap away once this one is done.
    const nextLink = document.querySelector("[data-next-lesson]");
    if (nextLink instanceof HTMLElement) nextLink.hidden = false;
  };

  video.addEventListener("play", () => {
    clearInterval(timer);
    timer = setInterval(() => send(false), 15_000);
  });
  video.addEventListener("pause", () => {
    clearInterval(timer);
    send(false);
  });
  video.addEventListener("ended", () => {
    clearInterval(timer);
    if (!completedSent) {
      completedSent = true;
      send(true);
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") send(false);
  });
  // Signed links last at most 2 hours (W4). When the link has expired (a page left open, a seek
  // after a long pause) the video errors: ask the play API for fresh links once and carry on from
  // the same place. A refund or a signed-out device answers 401/404, and the error stays.
  let refreshing = false;
  video.addEventListener("error", () => {
    const course = video.dataset.course;
    const expires = Number(video.dataset.expires) || 0;
    if (refreshing || !course || Date.now() / 1000 < expires - 60) return;
    refreshing = true;
    const at = video.currentTime || 0;
    const wasPlaying = !video.paused;
    fetch(`/api/learn/${encodeURIComponent(course)}/lessons/${lessonId}/play`, { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((info) => {
        if (!info || typeof info.src !== "string" || !info.src.startsWith("/media/")) return;
        video.dataset.expires = String(info.expiresAt);
        const track = video.querySelector("track");
        if (track && typeof info.captions === "string") track.src = info.captions;
        video.src = info.src;
        video.addEventListener(
          "loadedmetadata",
          () => {
            video.currentTime = at;
            if (wasPlaying) video.play().catch(() => {});
          },
          { once: true },
        );
        video.load();
      })
      .catch(() => {})
      .finally(() => {
        refreshing = false;
      });
  });

  // No right-click "Save video as…" (a speed bump, not protection: the links are signed and expire).
  video.addEventListener("contextmenu", (event) => event.preventDefault());
}
