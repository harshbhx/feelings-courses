/** Runs on every admin page: the Demo data badge, leaving the demo, the storage notice. */
import { signOut, storageIsBlocked } from "../../../lib/demo-store";
import { $, $$, ready } from "./dom";
import { toast } from "./ui";

ready(() => {
  $("[data-demo-badge]")?.addEventListener("click", () => {
    toast(
      "Demo data: every number, student and payment here is an example, saved only in this browser. Reset it any time in Settings.",
      "info",
      6500,
    );
  });

  for (const button of $$("[data-signout]")) {
    button.addEventListener("click", () => {
      signOut();
      location.href = "/admin";
    });
  }

  if (storageIsBlocked()) $("[data-storage-notice]")?.removeAttribute("hidden");
});
