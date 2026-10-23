// Shared Playwright fixtures for the e2e journeys.
//
//   import { test, expect, HUB, COURSE_HOST } from "./fixtures.mjs";
//   test("…", async ({ page, ctl, buyer }) => { … });
//
// - Every browser context gets its own client IP (x-e2e-ip → CF-Connecting-IP), so rate limits
//   never leak from one journey into another, and a fake Razorpay Checkout: checkout.js is answered
//   by a small script whose open() "pays" through the server's fake Razorpay (the order must exist
//   there, the amount is the order's) and calls the site's handler with a correctly signed response.
//   `razorpay.next = "dismiss"` makes the next open() close the window without paying instead.
// - `ctl` talks to the server's control API: the email outbox, the clock, SQL reads, Razorpay calls.
// - Each test fails on a browser page error, a Content-Security-Policy violation, or a server error.
import { test as base, expect } from "@playwright/test";
import { ADMIN_PASSWORD, COURSE_HOST, HUB, STUDIO_HOST } from "./world.mjs";

export { expect, ADMIN_PASSWORD, COURSE_HOST, HUB, STUDIO_HOST };

const CONTROL = `http://127.0.0.1:${process.env.E2E_HTTP_PORT ?? 8790}/__e2e`;
let ipCounter = 10;

async function call(path, body) {
  const res = await fetch(`${CONTROL}${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`control ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

export const ctl = {
  health: () => call("/health"),
  /** Every message sent to `to` (oldest first). */
  mail: async (to) => (await call(`/mail?to=${encodeURIComponent(to)}`)).messages,
  /** Waits for a message to `to` whose subject matches, and returns it. */
  async waitForMail(to, subject, { after = 0 } = {}) {
    let found = null;
    await expect
      .poll(async () => {
        const messages = (await ctl.mail(to)).slice(after);
        found = messages.filter((m) => subject.test(m.subject)).at(-1) ?? null;
        return found !== null;
      }, { message: `an email to ${to} matching ${subject}`, timeout: 10_000 })
      .toBe(true);
    return found;
  },
  /** The sign-in link in a message. */
  linkIn(message) {
    const m = /https:\/\/[^\s]+\/auth\/continue\?t=[A-Za-z0-9_%-]+/.exec(message.text);
    if (!m) throw new Error(`no sign-in link in "${message.subject}"`);
    return m[0];
  },
  advance: async (seconds) => (await call("/clock", { advance: seconds })).now,
  now: async () => (await call("/health")).now,
  sql: async (sql, params = []) => (await call("/sql", { sql, params })).rows,
  razorpay: () => call("/razorpay"),
  deployHooks: async () => (await call("/deploy-hooks")).calls,
  r2Keys: async (prefix = "") => (await call(`/r2?prefix=${encodeURIComponent(prefix)}`)).keys,
  errors: async () => (await call("/errors")).errors,
};

/** The fake checkout.js. `window.__e2ePay(orderId)` is exposed by the context fixture. */
const FAKE_CHECKOUT_JS = `
(() => {
  class Razorpay {
    constructor(options) { this.options = options; this.handlers = {}; }
    on(event, fn) { this.handlers[event] = fn; }
    open() {
      const o = this.options;
      document.documentElement.dataset.e2eRazorpay = "open";
      setTimeout(async () => {
        const mode = await window.__e2eCheckoutMode();
        document.documentElement.dataset.e2eRazorpay = mode;
        if (mode === "dismiss") { o.modal && o.modal.ondismiss && o.modal.ondismiss(); return; }
        if (mode === "fail") {
          this.handlers["payment.failed"] && this.handlers["payment.failed"]({ error: { description: "Payment declined by the bank." } });
          o.modal && o.modal.ondismiss && o.modal.ondismiss();
          return;
        }
        const paid = await window.__e2ePay(o.order_id, o.amount);
        o.handler(paid);
      }, 50);
    }
  }
  window.Razorpay = Razorpay;
})();
`;

/** Checks the page can't be scrolled sideways (CLAUDE.md rule 2). */
export async function expectNoSideScroll(page, label = page.url()) {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  expect(scroll, `sideways scroll on ${label}`).toBeLessThanOrEqual(width);
}

/** A unique address per test and project, so journeys never share an account. */
function emailFor(testInfo, tag = "buyer") {
  const slug = `${testInfo.project.name}-${testInfo.titlePath.at(-1)}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return `${tag}-${slug}-${testInfo.workerIndex}${testInfo.retry}@example.com`;
}

export const test = base.extend({
  ctl: async ({}, use) => use(ctl),

  razorpay: async ({}, use) => use({ next: "pay" }),

  buyer: async ({}, use, testInfo) => use({ name: "Asha Patel", email: emailFor(testInfo), phone: "9876543210" }),

  newIp: async ({}, use) => use(() => `198.51.100.${(ipCounter = (ipCounter % 250) + 1)}`),

  context: async ({ browser, contextOptions, razorpay, newIp }, use, testInfo) => {
    // A fresh context per test (the default `context` fixture would do too, but this one carries the
    // IP header and the fake checkout). Extra contexts (a second device) come from `device()`.
    const context = await newDevice(browser, contextOptions, razorpay, newIp(), testInfo);
    await use(context);
    await context.close();
  },

  /** Another browser (another phone), with its own IP. */
  device: async ({ browser, contextOptions, razorpay, newIp }, use, testInfo) => {
    const made = [];
    await use(async (options = {}) => {
      const context = await newDevice(browser, { ...contextOptions, ...options }, razorpay, newIp(), testInfo);
      made.push(context);
      return context;
    });
    for (const c of made) await c.close();
  },

  page: async ({ context }, use) => {
    const page = await context.newPage();
    await use(page);
  },

  // Fails the test on a server error that happened while it ran.
  serverErrors: [
    async ({}, use) => {
      const before = (await ctl.errors()).length;
      await use();
      const after = await ctl.errors();
      expect(after.slice(before), "server errors during the test").toEqual([]);
    },
    { auto: true },
  ],
});

async function newDevice(browser, options, razorpay, ip, testInfo) {
  const context = await browser.newContext({ ...options, extraHTTPHeaders: { ...(options.extraHTTPHeaders ?? {}), "x-e2e-ip": ip } });
  await context.exposeFunction("__e2eCheckoutMode", () => {
    const mode = razorpay.next;
    razorpay.next = "pay";
    return mode;
  });
  await context.exposeFunction("__e2ePay", async (orderId) => {
    const res = await fetch(`${CONTROL}/razorpay/pay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId }) });
    return res.json();
  });
  await context.route("https://checkout.razorpay.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: FAKE_CHECKOUT_JS }),
  );
  // Page errors and CSP violations fail the test (collected per page, checked at the end).
  const problems = [];
  context.on("page", (page) => {
    page.on("pageerror", (err) => problems.push(`page error on ${page.url()}: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error" && /Content Security Policy/i.test(msg.text())) problems.push(`CSP on ${page.url()}: ${msg.text()}`);
    });
  });
  context.on("close", () => {
    if (problems.length) testInfo.annotations.push({ type: "browser problems", description: problems.join("\n") });
  });
  context.problems = problems;
  return context;
}

/** Call at the end of a journey: no page errors and no CSP violations in any of its contexts. */
export function expectCleanBrowser(...contexts) {
  for (const context of contexts) expect(context.problems ?? [], "browser errors and CSP violations").toEqual([]);
}

/** Fills and sends the checkout on a course landing page that is already open. */
export async function checkout(page, buyer, { coupon, batch, consent = true, submit = true, expectNote = true } = {}) {
  await page.locator("[data-enroll]").first().click();
  const dialog = page.locator("dialog[data-checkout]");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Your name").fill(buyer.name);
  await dialog.getByLabel("Email", { exact: true }).fill(buyer.email);
  if (buyer.phone) await dialog.getByLabel(/Mobile number/).fill(buyer.phone);
  if (batch) await dialog.locator('select[name="batchId"]').selectOption(batch);
  if (coupon) {
    await dialog.getByText("Have a coupon code?").click();
    await dialog.getByLabel("Coupon code").fill(coupon);
    await dialog.getByRole("button", { name: "Apply" }).click();
    if (expectNote) await expect(dialog.locator("[data-co-coupon-note]")).toContainText(coupon.toUpperCase() === "GIFTGLOW" ? "free" : "applied");
  }
  if (consent) await dialog.locator('input[name="consent"]').check();
  if (submit) await dialog.locator("[data-co-submit]").click();
  return dialog;
}

/** Buys Glow Makeup on its own host and lands on the receipt. Returns the order id. */
export async function buyGlow(page, buyer, options = {}) {
  await page.goto(`${COURSE_HOST}/`);
  await checkout(page, buyer, options);
  await page.waitForURL(`${HUB}/receipt/**`, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payment received");
  return Number(new URL(page.url()).pathname.split("/").pop());
}

/** Signs in to the admin with the e2e password and waits for the dashboard (or `next`). */
export async function adminSignIn(page, next = "/admin/dashboard") {
  await page.goto(`${HUB}/admin${next === "/admin/dashboard" ? "" : `?next=${encodeURIComponent(next)}`}`);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(`${HUB}${next}**`);
}

/** Makes the browser's clock agree with the server's (which tests move forward). */
export async function syncClock(context) {
  await context.clock.install({ time: (await ctl.now()) * 1000 });
}
