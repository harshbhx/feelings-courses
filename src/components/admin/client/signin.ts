/**
 * The sign-in page. Already signed in: go on at once. Otherwise POST /api/admin/login and go to
 * `next` (an admin page only). Wrong password, too many tries, the daily lock and "not set up yet"
 * each get their own message; while rate limited the button stays off until the wait is over.
 */
import { call, ApiError } from "../../../lib/api-client";
import { $, icon, ready } from "./dom";
import { describeError, safeNext } from "../lib/errors";
import { roughDuration } from "../lib/time";

ready(() => {
  const form = $<HTMLFormElement>("[data-signin]");
  const password = $<HTMLInputElement>("[data-password]");
  const err = $("[data-password-err]");
  const alertBox = $("[data-signin-alert]");
  const submit = $<HTMLButtonElement>("[data-submit]");
  const toggle = $<HTMLButtonElement>("[data-toggle]");
  if (!form || !password || !err || !alertBox || !submit) return;

  const params = new URLSearchParams(location.search);
  const next = safeNext(params.get("next"));

  const say = (text: string, info = false) => {
    alertBox.textContent = text;
    alertBox.classList.toggle("is-info", info);
    alertBox.hidden = !text;
  };
  const fieldError = (text: string) => {
    err.replaceChildren(...(text ? [icon("warning-circle"), text] : []));
    if (text) password.setAttribute("aria-invalid", "true");
    else password.removeAttribute("aria-invalid");
  };

  if (params.get("signed_out")) say("You're signed out.", true);
  else if (params.get("next")) say("Sign in to carry on where you were.", true);

  // Already signed in (a bookmark to /admin, or the back button): go on.
  call("GET /api/admin/me")
    .then(() => location.replace(next))
    .catch((e) => {
      if (e instanceof ApiError && (e.status === 503 || e.code === "platform_not_configured")) {
        say(describeError(e).message);
      }
    });
  password.focus();

  toggle?.addEventListener("click", () => {
    const show = password.type === "password";
    password.type = show ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(show));
    toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
    password.focus();
  });

  let lockedUntil = 0;
  let timer = 0;
  const lockFor = (seconds: number) => {
    lockedUntil = Date.now() + seconds * 1000;
    submit.disabled = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      submit.disabled = false;
      say("You can try again now.", true);
    }, seconds * 1000);
  };

  password.addEventListener("input", () => fieldError(""));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.getAttribute("aria-busy") || Date.now() < lockedUntil) return;
    const value = password.value;
    if (!value) {
      fieldError("Enter the admin password.");
      password.focus();
      return;
    }
    say("");
    fieldError("");
    submit.setAttribute("aria-busy", "true");
    submit.classList.add("is-busy");
    submit.disabled = true;
    try {
      await call("POST /api/admin/login", {}, { password: value });
      location.replace(next);
      return;
    } catch (e) {
      const apiErr = e instanceof ApiError ? e : new ApiError(0, {});
      if (apiErr.code === "wrong_password") {
        fieldError("That password isn't right. Check capitals and spaces.");
        password.select();
      } else if (apiErr.status === 429) {
        const wait = apiErr.retryAfter ?? 900;
        say(
          apiErr.code === "admin_locked"
            ? `Too many wrong passwords today, so sign-in is locked for everyone for ${roughDuration(wait)}. Devices already signed in keep working.`
            : `Too many tries. Wait ${roughDuration(wait)}, then try again.`,
        );
        lockFor(wait);
      } else {
        say(describeError(apiErr).message);
      }
    } finally {
      submit.removeAttribute("aria-busy");
      submit.classList.remove("is-busy");
      if (Date.now() >= lockedUntil) submit.disabled = false;
    }
  });
});
