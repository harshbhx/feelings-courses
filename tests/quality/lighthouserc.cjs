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

const min = (score) => ["error", { minScore: score }];
const max = (value) => ["error", { maxNumericValue: value }];

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
  // Console errors are bugs.
  "errors-in-console": min(1),
};

// JavaScript budgets (bytes over the wire, all scripts on the page). The public pages are the
// ones people open from Instagram on a phone, so they get the tightest one.
const SCRIPT_BUDGET = { public: 60_000, learner: 25_000, admin: 120_000 };

module.exports = {
  ci: {
    collect: {
      numberOfRuns: 1,
      settings: { ...settings, chromeFlags: "--no-sandbox --headless=new" },
    },
    assert: {
      assertMatrix: [
        {
          matchingUrlPattern: "^http://(127\\.0\\.0\\.1|localhost):8788/(admin)",
          assertions: { ...assertions, "resource-summary:script:size": max(SCRIPT_BUDGET.admin) },
        },
        {
          matchingUrlPattern: "^http://127\\.0\\.0\\.1:8790/|^http://127\\.0\\.0\\.1:8788/(signin|verify)",
          assertions: { ...assertions, "resource-summary:script:size": max(SCRIPT_BUDGET.learner) },
        },
        {
          matchingUrlPattern: "^http://(127\\.0\\.0\\.1|selfmakeup\\.localhost):8788/(?!admin|signin|verify)",
          assertions: { ...assertions, "resource-summary:script:size": max(SCRIPT_BUDGET.public) },
        },
      ],
    },
    upload: { target: "filesystem", outputDir: "quality-report/lighthouse" },
  },
};
