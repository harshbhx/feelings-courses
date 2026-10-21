/**
 * Settings screen (DEMO): notification switches, copying the site address, the live-payments note
 * and "Reset demo data".
 */
import { resetDemo } from "../../../lib/demo-store";
import { ensureExtraSeeds } from "../../../lib/demo-store-coupons";
import { $, $$, ready } from "../client/dom";
import { plural } from "../client/format";
import { confirmDialog, demoNote, reportSave, toast } from "../client/ui";
import { NOTIFY, clearDemoKeys, defaultPrefs, demoKeys, loadPrefs, savePrefs, type Prefs } from "./prefs";

function applyPrefs(prefs: Prefs): void {
  for (const input of $$<HTMLInputElement>("[data-set-notify]")) {
    const key = input.dataset.setNotify ?? "";
    if (key in prefs) input.checked = prefs[key];
  }
}

function renderCount(): void {
  const el = $("[data-set-reset-count]");
  if (!el) return;
  const { local, session } = demoKeys();
  const n = local.length + session.length;
  el.textContent = n ? `${plural(n, "saved item")} on this browser.` : "Nothing saved on this browser yet.";
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("Address copied.", "success");
  } catch {
    toast("Couldn't copy here. Press and hold the address to copy it.", "error");
  }
}

async function reset(button: HTMLButtonElement): Promise<void> {
  const { local, session } = demoKeys();
  const n = local.length + session.length;
  const ok = await confirmDialog({
    title: "Reset all demo data?",
    body: `Courses, coupons, notification choices and every other change in this admin demo go back to the example data${
      n ? ` (${plural(n, "saved item")} on this browser)` : ""
    }. You can't undo this. You stay signed in.`,
    confirm: "Reset demo data",
    danger: true,
  });
  button.focus();
  if (!ok) return;

  const cleared = clearDemoKeys();
  const saved = reportSave(resetDemo());
  ensureExtraSeeds();
  applyPrefs(defaultPrefs());
  renderCount();
  if (saved) toast(cleared ? "Demo data reset. Everything is back to the example." : "Demo data reset. It was already the example.", "success");
}

ready(() => {
  applyPrefs(loadPrefs());
  renderCount();

  for (const input of $$<HTMLInputElement>("[data-set-notify]")) {
    input.addEventListener("change", () => {
      const prefs = loadPrefs();
      const key = input.dataset.setNotify ?? "";
      prefs[key] = input.checked;
      const stored = savePrefs(prefs);
      renderCount();
      const title = NOTIFY.find((n) => n.key === key)?.title ?? "Notification";
      if (stored) toast(`${title}: ${input.checked ? "on" : "off"}. Demo: nothing is sent.`, "success", 3200);
      else toast("This browser is blocking storage, so this choice lasts only until you leave the page.", "error", 6000);
    });
  }

  for (const button of $$<HTMLButtonElement>("[data-set-copy]")) {
    button.addEventListener("click", () => copy(button.dataset.setCopy ?? ""));
  }

  $("[data-set-live]")?.addEventListener("click", () => demoNote("Switching to live payments"));

  const resetButton = $<HTMLButtonElement>("[data-set-reset]");
  resetButton?.addEventListener("click", () => reset(resetButton));
});
