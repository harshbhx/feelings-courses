// Browser journeys (Playwright) against tests/e2e/server.mjs: the real Functions and the real built
// site, with fake Razorpay, a fake Email Service, an in-memory D1 and R2. Runs in GitHub Actions
// (.github/workflows/e2e.yml), never on the 2-CPU VM. docs/E2E.md explains how to run and read it.
//
// The browser reaches every *.feelingsbeautycare.in host on the local HTTPS port (Chromium's host
// resolver rules) and nothing else: any other host fails to resolve, so a journey can't touch the
// internet. Razorpay's checkout.js is answered by a fake (fixtures.mjs).
import { defineConfig, devices } from "@playwright/test";

const HTTPS_PORT = Number(process.env.E2E_HTTPS_PORT ?? 8443);
const HTTP_PORT = Number(process.env.E2E_HTTP_PORT ?? 8790);
const CI = !!process.env.CI;

const launchOptions = {
  args: [
    `--host-resolver-rules=MAP *.feelingsbeautycare.in 127.0.0.1:${HTTPS_PORT}, MAP feelingsbeautycare.in 127.0.0.1:${HTTPS_PORT}, MAP * ~NOTFOUND`,
  ],
};

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,
  outputDir: "../../test-results/e2e",
  // One shared server (one database, one clock): journeys run one at a time, in file order.
  workers: 1,
  fullyParallel: false,
  // No blanket retries: a journey that fails is a bug or a flaky test, and both need fixing.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 7_000 },
  forbidOnly: CI,
  reporter: CI ? [["list"], ["html", { open: "never", outputFolder: "../../playwright-report" }], ["github"]] : [["list"]],
  use: {
    baseURL: "https://courses.feelingsbeautycare.in",
    ignoreHTTPSErrors: true,
    trace: "on",
    screenshot: "on",
    video: "off",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    launchOptions,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 }, launchOptions }, testIgnore: /mobile\.spec\.mjs$/ },
    {
      name: "mobile",
      // A 390px phone (the site's first check, CLAUDE.md rule 2), on Chromium.
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 }, launchOptions },
      testMatch: /(purchase|mobile)\.spec\.mjs$/,
    },
  ],
  webServer: {
    command: "node --experimental-strip-types --no-warnings --import ./tests/helpers/register.mjs tests/e2e/server.mjs",
    cwd: "../..",
    url: `http://127.0.0.1:${HTTP_PORT}/__e2e/health`,
    reuseExistingServer: !CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
