// Lighthouse CI settings for .github/workflows/quality.yml (docs/QUALITY.md explains the numbers).
//
//   LH_PRESET=mobile|desktop   mobile is Lighthouse's default (Moto G Power, slow 4G, 4x CPU slowdown);
//                              desktop is its desktop preset.
//   LH_ADMIN_COOKIE            the admin session cookie for the signed-in admin pages (CI only: a
//                              throwaway password on a local server that ends with the job).
//
// The URLs come from tests/quality/pages.mjs (the workflow passes them with --url).
//
// One audit is skipped on purpose: "is-crawlable". Every page here is noindex for a reason that is
// not a defect: the dev host (X-Robots-Tag on localhost), the demo course (src/lib/seo.ts) and the
// private areas (admin, learner). tests/quality/headers.mjs checks the robots rules per host instead.
const desktop = process.env.LH_PRESET === "desktop";
const cookie = process.env.LH_ADMIN_COOKIE;

const settings = {
  skipAudits: ["is-crawlable"],
  ...(desktop ? { preset: "desktop" } : {}),
  ...(cookie ? { extraHeaders: { Cookie: cookie } } : {}),
};

// Judged on the median run of the three (by performance score), not the best one.
const min = (score) => ["error", { minScore: score, aggregationMethod: "median-run" }];
const max = (value) => ["error", { maxNumericValue: value, aggregationMethod: "median-run" }];

// Thresholds. Every page, every form factor: 95 or more in each category, and the Core Web
// Vitals inside Google's "good" limits under Lighthouse's throttling.
const assertions = {
  "categories:performance": min(0.95),
  "categories:accessibility": min(0.95),
  "categories:best-practices": min(0.95),
  "categories:seo": min(0.95),
  "cumulative-layout-shift": max(0.1),
  "largest-contentful-paint": max(desktop ? 1200 : 2500),
  "total-blocking-time": max(200),
  // Images: sized, responsive, lazy below the fold, modern formats.
  "unsized-images": min(1),
  "uses-responsive-images": min(0.9),
  "offscreen-images": min(0.9),
  "modern-image-formats": min(0.9),
  // Text and fonts.
  "font-display": min(1),
  "uses-text-compression": min(1),
  // An accessible name that starts with the visible label (WCAG 2.5.3; not in the a11y score).
  "label-content-name-mismatch": min(1),
  // Console errors are bugs.
  "errors-in-console": min(1),
};

// JavaScript budgets (bytes over the wire, all scripts on the page). The public pages are the
// ones people open from Instagram on a phone, so they get the tightest one.
const SCRIPT_BUDGET = { public: 60_000, learner: 25_000, admin: 120_000 };

module.exports = {
  ci: {
    collect: {
      // Three runs per page; Lighthouse CI keeps the median one, so one slow run on a busy
      // runner doesn't fail the check.
      numberOfRuns: 3,
      settings: { ...settings, chromeFlags: "--no-sandbox --headless=new" },
    },
    assert: {
      assertMatrix: [
        {
          // The admin's sign-in screen asks GET /api/admin/me whether a session already exists
          // (to skip the form); the expected 401 is the one console line, so that audit is off here.
          matchingUrlPattern: "^http://127\\.0\\.0\\.1:8788/admin$",
          assertions: { ...assertions, "errors-in-console": "off", "resource-summary:script:size": max(SCRIPT_BUDGET.admin) },
        },
        {
          matchingUrlPattern: "^http://127\\.0\\.0\\.1:8788/admin/",
          assertions: { ...assertions, "resource-summary:script:size": max(SCRIPT_BUDGET.admin) },
        },
        {
          matchingUrlPattern: "^http://127\\.0\\.0\\.1:8790/(?!receipt)|^http://127\\.0\\.0\\.1:8788/(signin|verify)",
          assertions: { ...assertions, "resource-summary:script:size": max(SCRIPT_BUDGET.learner) },
        },
        {
          // The receipt's policy is the strictest on the site (default-src 'none', no connect-src:
          // functions/_lib/receipts.ts), so Lighthouse's in-page fetch of /robots.txt is refused and
          // its robots-txt audit fails (SEO 88). Search engines fetch robots.txt themselves and the
          // receipt is personal and noindex; loosening the policy for an audit tool isn't worth it.
          matchingUrlPattern: "^http://127\\.0\\.0\\.1:8790/receipt",
          assertions: { ...assertions, "categories:seo": min(0.85), "resource-summary:script:size": max(SCRIPT_BUDGET.learner) },
        },
        {
          matchingUrlPattern: "^http://(127\\.0\\.0\\.1|selfmakeup\\.localhost):8788/(?!admin|signin|verify|catalog)",
          assertions: { ...assertions, "resource-summary:script:size": max(SCRIPT_BUDGET.public) },
        },
        {
          // /catalog's cards show a 4:5 cover cropped to 4:3 on phones (object-fit: cover). The
          // srcset picks the right width, but Lighthouse doesn't model the crop and counts the
          // hidden part as waste. A real fix is a 4:3 crop per phone width (docs/QUALITY.md).
          matchingUrlPattern: "^http://127\\.0\\.0\\.1:8788/catalog",
          assertions: { ...assertions, "uses-responsive-images": "off", "resource-summary:script:size": max(SCRIPT_BUDGET.public) },
        },
      ],
    },
    upload: { target: "filesystem", outputDir: "quality-report/lighthouse" },
  },
};
