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
  // No right-click "Save video as…" (a speed bump, not protection: the links are signed and expire).
  video.addEventListener("contextmenu", (event) => event.preventDefault());
}
