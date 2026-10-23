// Journey 7: rate limits and the admin lockout, as people meet them in the browser.
//   - admin password: 5 tries per 15 minutes per IP, then "Too many tries"; other places unaffected;
//   - 20 wrong admin passwords in a day lock the form for everyone for an hour (signed-in admins keep
//     working);
//   - sign-in links: at most 3 emails per address per 15 minutes, with the same page every time;
//   - orders: 10 per IP per 10 minutes, then the checkout says to wait.
// Runs last among the desktop journeys, and moves the clock past every window when it ends.
import { ADMIN_PASSWORD, adminSignIn, browserFetch, buyGlow, COURSE_HOST, ctl as control, expect, expectCleanBrowser, HUB, syncClock, test } from "./fixtures.mjs";

// Clear every window (the daily admin counter included) for anything that runs after.
test.afterAll(async () => {
  await control.advance(25 * 3600);
});

async function wrongPassword(page, password = "not-the-password-123") {
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("admin sign-in: 5 tries per IP, then a wait; another IP is unaffected", async ({ page, context, device, ctl }) => {
  await syncClock(context);
  await page.goto(`${HUB}/admin`);
  for (let i = 0; i < 5; i++) {
    await wrongPassword(page);
    await expect(page.getByText("That password isn't right. Check capitals and spaces.")).toBeVisible();
  }
  // The 6th try, even with the right password, waits.
  await wrongPassword(page, ADMIN_PASSWORD);
  await expect(page.locator("[data-signin-alert]")).toContainText(/Too many tries\. Wait .*, then try again\./);
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
  expect(new URL(page.url()).pathname).toBe("/admin");

  // Another device (another IP) signs in normally.
  const laptop = await device();
  const other = await laptop.newPage();
  await adminSignIn(other);

  // 15 minutes later this one can try again.
  await ctl.advance(15 * 60 + 5);
  const retry = await context.newPage();
  await retry.goto(`${HUB}/admin`);
  await retry.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await retry.getByRole("button", { name: "Sign in" }).click();
  await retry.waitForURL(`${HUB}/admin/dashboard`);
  expectCleanBrowser(context, laptop);
});

test("20 wrong admin passwords lock sign-in for everyone for an hour; signed-in admins keep working", async ({ context, device, ctl }) => {
  // An admin who is already signed in.
  const office = await device();
  const signedIn = await office.newPage();
  await adminSignIn(signedIn);

  // Wrong passwords from 5 places (4 each stays under the per-IP limit): 20 is the daily allowance.
  let tries = 0;
  for (let place = 0; place < 6 && tries < 21; place++) {
    const ctx = await device();
    const p = await ctx.newPage();
    await p.goto(`${HUB}/admin`);
    for (let i = 0; i < 4 && tries < 21; i++) {
      const res = await browserFetch(p, "/api/admin/login", { method: "POST", body: { password: `wrong-password-${place}-${i}` } });
      tries += 1;
      if (res.status === 429) break;
      expect(res.status).toBe(401);
    }
  }

  // Now even the right password, from a new place, is refused, with the lock explained.
  const late = await device();
  await syncClock(late);
  const latePage = await late.newPage();
  await latePage.goto(`${HUB}/admin`);
  await latePage.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
  await latePage.getByRole("button", { name: "Sign in" }).click();
  await expect(latePage.locator("[data-signin-alert]")).toContainText("Too many wrong passwords today, so sign-in is locked for everyone");

  // The admin who was signed in still works.
  expect((await browserFetch(signedIn, "/api/admin/me")).status).toBe(200);

  // An hour later the right password works again.
  await ctl.advance(3600 + 5);
  const later = await device();
  await syncClock(later);
  const laterPage = await later.newPage();
  await adminSignIn(laterPage);
  expectCleanBrowser(context, office, late, later);
});

test("sign-in links: 3 emails per address per 15 minutes, and the page never tells", async ({ page, context, ctl, buyer, device }) => {
  await buyGlow(page, buyer);
  const phone = await device();
  const p = await phone.newPage();
  const ask = async () => {
    await p.goto(`${HUB}/signin`);
    await p.getByLabel(/email/i).fill(buyer.email);
    await p.getByRole("button", { name: "Email me a sign-in link" }).click();
  };
  const links = async () => (await ctl.mail(buyer.email)).filter((m) => /^Your sign-in link/.test(m.subject)).length;
  for (let i = 0; i < 3; i++) {
    await ask();
    await expect(p.getByRole("heading", { level: 1 })).toHaveText("Check your email");
  }
  await expect.poll(links).toBe(3);
  // The 4th: no email, and the answer doesn't reveal the limit to someone probing an address.
  await ask();
  await expect(p.getByRole("heading", { level: 1 })).toHaveText(/Check your email|Too many/);
  await p.waitForTimeout(500);
  expect(await links()).toBe(3);
  // 15 minutes later it works again.
  await ctl.advance(15 * 60 + 5);
  await ask();
  await expect.poll(links).toBe(4);
  expectCleanBrowser(context, phone);
});

test("orders: 10 per IP per 10 minutes, then the checkout asks to wait", async ({ page, context, ctl, buyer }) => {
  await page.goto(`${COURSE_HOST}/`);
  // Ten checkouts started from this phone (abandoned at Razorpay).
  for (let i = 0; i < 10; i++) {
    const res = await browserFetch(page, "/api/order", { method: "POST", body: { course: "glow", consent: true, name: "Asha Patel", email: `limit-${i}-${buyer.email}` } });
    expect(res.status, res.text).toBe(200);
  }
  // The 11th, through the real checkout form: refused, with a clear message, and Razorpay not asked.
  const ordersBefore = (await ctl.razorpay()).calls.filter((c) => c.path === "/orders").length;
  await page.locator("[data-enroll]").first().click();
  const dialog = page.locator("dialog[data-checkout]");
  await dialog.getByLabel("Your name").fill("Asha Patel");
  await dialog.getByLabel("Email", { exact: true }).fill(buyer.email);
  await dialog.locator('input[name="consent"]').check();
  await dialog.locator("[data-co-submit]").click();
  await expect(dialog).toContainText(/too many|wait|try again/i);
  expect((await ctl.razorpay()).calls.filter((c) => c.path === "/orders").length).toBe(ordersBefore);
  expectCleanBrowser(context);
});
