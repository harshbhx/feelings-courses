/**
 * Runs on every signed-in admin page:
 * - checks the session (GET /api/admin/me); a dead session goes to the sign-in page;
 * - the payment-mode badge in the top bar ("Test mode", "Payments not set up");
 * - the "Publish changes" chip when saved changes aren't on the live site yet. Screens fire
 *   `admin:changed` on document after a save, and the chip checks again;
 * - Sign out.
 */
import { admin, asApiError } from "./api";
import { $, $$, ready } from "./dom";
import { CHANGED_EVENT } from "./events";
import { busy, toast } from "./ui";
import { describeError } from "../lib/errors";
import { publishView, rebuildMessage } from "../lib/publish";
import { unixNow } from "../lib/time";

async function session(): Promise<void> {
  const badge = $("[data-mode-badge]");
  try {
    const me = await admin("GET /api/admin/me");
    document.documentElement.dataset.payment = me.paymentMode;
    if (!badge) return;
    const label = badge.querySelector("[data-mode-label]");
    if (me.paymentMode === "test") {
      if (label) label.textContent = "Test mode";
      badge.dataset.tone = "test";
      badge.hidden = false;
    } else if (me.paymentMode === "not_configured") {
      if (label) label.textContent = "Payments off";
      badge.dataset.tone = "off";
      badge.hidden = false;
    } else badge.hidden = true;
  } catch (err) {
    const view = describeError(asApiError(err));
    if (view.kind === "setup") {
      const note = $("[data-setup-notice]");
      if (note) note.hidden = false;
    }
  }
}

let polling = 0;

async function publishChip(): Promise<void> {
  const chip = $<HTMLButtonElement>("[data-publish-chip]");
  if (!chip) return;
  window.clearTimeout(polling);
  try {
    const status = await admin("GET /api/admin/publish/status");
    const view = publishView(status);
    chip.hidden = !(status.state === "queued" || status.state === "building");
    chip.dataset.state = status.state;
    const label = chip.querySelector("[data-chip-label]");
    if (label) label.textContent = status.state === "building" ? "Updating site…" : "Publish changes";
    chip.disabled = status.state === "building";
    chip.title = view.detail;
    if (view.poll) polling = window.setTimeout(() => void publishChip(), 20_000);
  } catch {
    chip.hidden = true;
  }
}

ready(() => {
  // The sign-in page has no shell: no session check there (it would loop back to itself).
  if (!document.querySelector(".shell")) return;
  void session();
  void publishChip();
  document.addEventListener(CHANGED_EVENT, () => void publishChip());

  $<HTMLButtonElement>("[data-publish-chip]")?.addEventListener("click", async (event) => {
    const chip = event.currentTarget as HTMLButtonElement;
    await busy(chip, async () => {
      try {
        const res = await admin("POST /api/admin/publish");
        const msg = rebuildMessage(res.rebuild, unixNow());
        toast(msg.text, msg.tone);
        document.dispatchEvent(new CustomEvent("admin:published", { detail: res }));
      } catch (err) {
        toast(describeError(asApiError(err)).message, "error");
      }
    });
    void publishChip();
  });

  for (const button of $$<HTMLButtonElement>("[data-signout]")) {
    button.addEventListener("click", async () => {
      await busy(button, async () => {
        try {
          await admin("POST /api/admin/logout");
        } catch {
          /* signed out either way: the cookie is cleared or already dead */
        }
      });
      location.assign("/admin?signed_out=1");
    });
  }
});
