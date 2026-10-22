/**
 * The activity log: each audit_log action as a sentence, and a link to what it was about.
 * Unknown actions (added later by another part of the platform) still read sensibly.
 */
import type { AuditRecord } from "../../../shared/types.ts";

const SENTENCES: Record<string, string> = {
  "admin.login": "Signed in to the admin",
  "admin.login_failed": "Wrong admin password tried",
  "admin.logout": "Signed out of the admin",
  "admin.password_change": "Changed the admin password",
  "course.create": "Created a course",
  "course.update": "Edited a course",
  "course.delete": "Deleted a course",
  "course.publish": "Published a course",
  "course.unpublish": "Took a course off the site",
  "course.archive": "Archived a course",
  "course.outline": "Saved a course's lessons",
  "course.domain": "Checked a course's subdomain",
  "batch.create": "Added a batch",
  "batch.update": "Edited a batch",
  "batch.delete": "Deleted a batch",
  "student.add": "Added a student",
  "student.export": "Downloaded the students list",
  "student.signout_all": "Signed a student out everywhere",
  "student.erase": "Erased a student's personal data",
  "student.access_link": "Made a sign-in link for a student",
  "enrollment.grant": "Gave a student access",
  "enrollment.revoke": "Ended a student's access",
  "certificate.issue": "Issued a certificate",
  "order.export": "Downloaded the payments list",
  "order.refund": "Started a refund",
  "order.sync": "Re-read a payment from Razorpay",
  "coupon.create": "Created a coupon",
  "coupon.update": "Edited a coupon",
  "coupon.delete": "Deleted a coupon",
  "settings.update": "Changed the settings",
  "site.rebuild": "Asked for a site update",
  "webhook.replay": "Replayed a Razorpay event",
  "media.upload_start": "Started an upload",
  "media.upload_complete": "Finished an upload",
  "media.upload_abort": "Cancelled an upload",
  "media.delete": "Deleted a file",
};

/** "Published a course". */
export function auditSentence(action: string): string {
  const known = SENTENCES[action];
  if (known) return known;
  const [entity, verb] = action.split(".");
  if (!verb) return action;
  const words = verb.replace(/_/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} (${entity})`;
}

/** Where the record's subject lives in the admin, or null. */
export function auditHref(rec: Pick<AuditRecord, "entity" | "entityId">): string | null {
  const id = rec.entityId && /^\d+$/.test(rec.entityId) ? rec.entityId : null;
  switch (rec.entity) {
    case "course":
      return id ? `/admin/courses/edit?id=${id}` : "/admin/courses";
    case "student":
      return id ? `/admin/students?open=${id}` : "/admin/students";
    case "order":
      return id ? `/admin/payments?open=${id}` : "/admin/payments";
    case "coupon":
      return "/admin/coupons";
    case "settings":
      return "/admin/settings";
    default:
      return null;
  }
}

/** The audit entities the filter offers. */
export const AUDIT_ENTITIES: { value: string; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "course", label: "Courses" },
  { value: "batch", label: "Batches" },
  { value: "student", label: "Students" },
  { value: "enrollment", label: "Access" },
  { value: "order", label: "Payments" },
  { value: "coupon", label: "Coupons" },
  { value: "settings", label: "Settings" },
  { value: "site", label: "Site updates" },
  { value: "admin", label: "Sign-ins" },
  { value: "webhook", label: "Razorpay events" },
];

/**
 * A short, readable summary of the record's data: "title: Bridal basics · slug: bridal-basics".
 * Only plain values, at most `max` entries; nested objects as "a → b" for {from, to}.
 */
export function auditDetails(data: unknown, max = 4): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (parts.length >= max) break;
    const label = k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    if (v === null || v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(`${label}: ${String(v)}`);
    else if (Array.isArray(v)) parts.push(`${label}: ${v.slice(0, 6).map(String).join(", ")}${v.length > 6 ? "…" : ""}`);
    else if (typeof v === "object" && "from" in v && "to" in v) {
      const o = v as { from: unknown; to: unknown };
      parts.push(`${label}: ${String(o.from)} → ${String(o.to)}`);
    }
  }
  return parts.join(" · ");
}
