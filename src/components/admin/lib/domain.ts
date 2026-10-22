/**
 * The Cloudflare setup helper: what the owner does once per course so <slug>.feelingsbeautycare.in
 * opens the course. The site is one Cloudflare Pages project; each course subdomain is added to it as
 * a custom domain. Cloudflare creates the DNS record itself because feelingsbeautycare.in is on
 * Cloudflare, so it is about four clicks and nothing to type but the address.
 */
import type { AdminCourse, DomainStatus } from "../../../shared/types.ts";
import { courseAddresses } from "./slug.ts";

/** The Pages project the site deploys to (CLAUDE.md, Deploy). */
export const PAGES_PROJECT = "feelings-courses";

/** Cloudflare's dashboard deep link to the project's custom domains (":account" picks the account). */
export const PAGES_DOMAINS_URL = `https://dash.cloudflare.com/?to=/:account/pages/view/${PAGES_PROJECT}/domains`;

export interface SetupStep {
  /** What to do, short. */
  title: string;
  /** Extra detail, or null. */
  detail: string | null;
  /** Text worth copying in this step (the host), or null. */
  copy: string | null;
}

/** The steps for one course's subdomain. */
export function domainSteps(slug: string): SetupStep[] {
  const { host } = courseAddresses(slug);
  return [
    {
      title: `Open the "${PAGES_PROJECT}" project in Cloudflare`,
      detail: "Workers & Pages → feelings-courses → Custom domains. The button below goes straight there.",
      copy: null,
    },
    { title: "Click “Set up a custom domain”", detail: null, copy: null },
    { title: "Paste this address and click Continue", detail: null, copy: host },
    {
      title: "Click “Activate domain”",
      detail: `Cloudflare adds the DNS record by itself. The address usually works within 5 minutes (sometimes up to an hour). If it ever asks you to add the record yourself: type CNAME, name ${slug}, target ${PAGES_PROJECT}.pages.dev.`,
      copy: null,
    },
    { title: "Come back here and press “Check now”", detail: "Once it answers, the address is marked live and locked.", copy: null },
  ];
}

export interface DomainView {
  label: string;
  tone: "live" | "wait" | "off";
  /** One sentence for the owner. */
  help: string;
}

/** How to show a course's domain status. */
export function domainView(status: DomainStatus, slug: string): DomainView {
  const { host } = courseAddresses(slug);
  switch (status) {
    case "active":
      return { label: "Live", tone: "live", help: `${host} opens this course. Its web address is locked so links keep working.` };
    case "pending":
      return {
        label: "Waiting",
        tone: "wait",
        help: `${host} didn't answer at the last check. Finish the Cloudflare steps, wait a few minutes, then check again.`,
      };
    default:
      return {
        label: "Not set up",
        tone: "off",
        help: `Until you add ${host} in Cloudflare, the course still works at its courses.feelingsbeautycare.in/c/ address.`,
      };
  }
}

/** What a domain check found, in words. */
export function probeText(probe: number | "timeout" | "unreachable", status: DomainStatus): string {
  if (status === "active") return "It works: the address answered and is now live.";
  if (probe === "timeout") return "The address didn't answer within 5 seconds. Cloudflare may still be setting it up.";
  if (probe === "unreachable") return "The address doesn't exist yet. Add it in Cloudflare first, or wait a few minutes.";
  if (probe === 522 || probe === 523 || probe === 525 || probe === 526)
    return `Cloudflare answered with error ${probe}: the domain is still being set up. Try again in a few minutes.`;
  return `The address answered with HTTP ${probe}, which isn't the course yet. Check the Cloudflare steps.`;
}

/** Courses whose subdomain still needs the owner (published or about to be, not live yet). */
export function coursesNeedingDomain(courses: Pick<AdminCourse, "status" | "domainStatus">[]): number {
  return courses.filter((c) => c.status !== "archived" && c.domainStatus !== "active").length;
}
