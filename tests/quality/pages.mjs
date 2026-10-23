// Every page the quality run (Lighthouse and axe, .github/workflows/quality.yml) looks at, by group.
//
//   public   the hub and a course host under `wrangler pages dev` (real _headers, _routes.json and
//            the root middleware), with the seed snapshot's demo course ("selfmakeup");
//   learner  the pages Functions render for students: /signin and /verify live, and every signed-in
//            state rendered by tests/quality/learner-server.mjs (the same Response objects Functions
//            return, from the test world in tests/ux/world.mjs);
//   admin    the course admin, signed in with a throwaway password that only exists in the CI run.
//
// Bases come from the environment so the same list works against any server:
//   QUALITY_HUB      default http://127.0.0.1:8788
//   QUALITY_COURSE   default http://selfmakeup.localhost:8788 (Chrome resolves *.localhost itself)
//   QUALITY_LEARNER  default http://127.0.0.1:8790

export const HUB = (process.env.QUALITY_HUB ?? "http://127.0.0.1:8788").replace(/\/$/, "");
export const COURSE = (process.env.QUALITY_COURSE ?? "http://selfmakeup.localhost:8788").replace(/\/$/, "");
export const LEARNER = (process.env.QUALITY_LEARNER ?? "http://127.0.0.1:8790").replace(/\/$/, "");

/**
 * `lighthouse: false`: axe only. These pages answer 4xx on purpose (404, 400, 403, 410), and
 * Lighthouse refuses to score a page whose document status is an error.
 * @type {{ group: "public" | "learner" | "admin", name: string, url: string, lighthouse?: boolean }[]}
 */
export const PAGES = [
  // public
  { group: "public", name: "home", url: `${HUB}/` },
  { group: "public", name: "course landing (hub)", url: `${HUB}/c/selfmakeup` },
  { group: "public", name: "course landing (course host)", url: `${COURSE}/` },
  { group: "public", name: "catalog", url: `${HUB}/catalog` },
  { group: "public", name: "legal index", url: `${HUB}/legal` },
  { group: "public", name: "terms", url: `${HUB}/legal/terms` },
  { group: "public", name: "refunds", url: `${HUB}/legal/refunds` },
  { group: "public", name: "privacy", url: `${HUB}/legal/privacy` },
  { group: "public", name: "thank you", url: `${HUB}/thank-you` },
  { group: "public", name: "payment failed", url: `${HUB}/payment-failed` },
  { group: "public", name: "404", url: `${HUB}/no-such-page`, lighthouse: false },
  // learner, live
  { group: "learner", name: "sign in", url: `${HUB}/signin` },
  { group: "learner", name: "verify a certificate", url: `${HUB}/verify` },
  // learner, rendered by Functions code from the test world
  { group: "learner", name: "account", url: `${LEARNER}/account` },
  { group: "learner", name: "account, empty", url: `${LEARNER}/account-empty` },
  { group: "learner", name: "course home", url: `${LEARNER}/course-home` },
  { group: "learner", name: "lesson", url: `${LEARNER}/lesson` },
  { group: "learner", name: "certificate", url: `${LEARNER}/certificate` },
  { group: "learner", name: "receipt", url: `${LEARNER}/receipt` },
  { group: "learner", name: "sign-in link sent", url: `${LEARNER}/signin-sent` },
  { group: "learner", name: "sign-in error", url: `${LEARNER}/signin-error`, lighthouse: false },
  { group: "learner", name: "link expired", url: `${LEARNER}/link-expired`, lighthouse: false },
  { group: "learner", name: "access ended", url: `${LEARNER}/access-ended`, lighthouse: false },
  // admin
  { group: "admin", name: "admin sign in", url: `${HUB}/admin` },
  { group: "admin", name: "admin dashboard", url: `${HUB}/admin/dashboard` },
  { group: "admin", name: "admin courses", url: `${HUB}/admin/courses` },
  { group: "admin", name: "admin course editor", url: `${HUB}/admin/courses/edit?id=1` },
  { group: "admin", name: "admin students", url: `${HUB}/admin/students` },
  { group: "admin", name: "admin payments", url: `${HUB}/admin/payments` },
  { group: "admin", name: "admin coupons", url: `${HUB}/admin/coupons` },
  { group: "admin", name: "admin settings", url: `${HUB}/admin/settings` },
  { group: "admin", name: "admin activity", url: `${HUB}/admin/activity` },
];

/** Pages that need the admin cookie (every admin page but the sign-in screen). */
export const needsAdmin = (page) => page.group === "admin" && !page.url.endsWith("/admin");

/** `--url=…` arguments for `lhci collect`, one per line: "plain" pages or the signed-in "admin" ones. */
export function lhciUrls(which) {
  return PAGES.filter((p) => p.lighthouse !== false && (which === "admin" ? needsAdmin(p) : !needsAdmin(p)))
    .map((p) => `--url=${p.url}`)
    .join("\n");
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href && process.argv[2]) {
  console.log(lhciUrls(process.argv[2]));
}
