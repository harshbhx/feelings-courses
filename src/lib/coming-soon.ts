import { course } from "../data/course";

/**
 * While the courses are coming soon (course.comingSoon), every page but the home page sends its
 * visitors home: the course area, the checkout results, the catalog and the admin demo. Each of
 * those pages starts with
 *
 *   const soonHome = comingSoonHome();
 *   if (soonHome) return Astro.redirect(soonHome, 307);
 *
 * Static output turns that into a small page that forwards at once (a meta refresh; Astro waits
 * 2 seconds for a 302 but none for other statuses, hence 307). The course area is still gated
 * first (functions/learn/*), so a visitor without an enrollment gets the gate's 302 to
 * /?locked=1#pricing, which opens the coming-soon sheet. Returns null when the course is live (or
 * a demo again), so the page renders as before.
 */
export function comingSoonHome(hash = ""): string | null {
  return course.comingSoon ? `/${hash}` : null;
}
