/**
 * The site's publish state (course pages are static and rebuilt by the deploy hook in ~2 minutes),
 * worded for the owner, and the answer to "Publish changes".
 */
import type { AdminRebuild } from "../../../shared/api.ts";
import type { PublishStatus, Unix } from "../../../shared/types.ts";
import { roughDuration } from "./time.ts";

export interface PublishView {
  label: string;
  tone: "live" | "wait" | "todo" | "off";
  detail: string;
  /** Show the "Publish changes" button. */
  action: boolean;
  /** Ask again in 20 s (a build is running). */
  poll: boolean;
}

export function publishView(s: PublishStatus): PublishView {
  switch (s.state) {
    case "up_to_date":
      return { label: "Site is up to date", tone: "live", detail: "Everything you saved is on the live site.", action: false, poll: false };
    case "building":
      return { label: "Updating the site…", tone: "wait", detail: "Your changes go live in about 2 minutes.", action: false, poll: true };
    case "queued":
      return {
        label: "Changes not live yet",
        tone: "todo",
        detail: "You saved changes to published courses or settings. Publish them to update the site.",
        action: true,
        poll: false,
      };
    default:
      return {
        label: "Site status unknown",
        tone: "off",
        detail: "The live site's version can't be read here (a preview or local copy). Publishing still works.",
        action: true,
        poll: false,
      };
  }
}

/** What happened after asking for a rebuild, as a toast. */
export function rebuildMessage(r: AdminRebuild, now: Unix): { text: string; tone: "success" | "info" | "error" } {
  if (r.queued) return { text: "Publishing. The site updates in about 2 minutes.", tone: "success" };
  switch (r.reason) {
    case "debounced": {
      const wait = Math.max(0, r.nextAllowedAt - now);
      return { text: `Saved. A site update was just started; the next one can start in ${roughDuration(wait)}.`, tone: "info" };
    }
    case "no_hook":
      return { text: "Saved. This copy has no deploy hook, so the live site picks it up on the next deploy.", tone: "info" };
    case "hook_failed":
      return { text: "Saved, but Cloudflare didn't accept the site update. Try “Publish changes” again.", tone: "error" };
    default:
      return { text: "Saved.", tone: "info" };
  }
}
