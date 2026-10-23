// Journey 3: coupons. A wrong code is explained; a 10% code lowers what Razorpay is asked for (the
// server's price, not the browser's); a 100% "free" code enrolls without any payment and opens the
// course; a second free enrollment for the same email is refused.
import { checkout, COURSE_HOST, expect, expectCleanBrowser, HUB, test } from "./fixtures.mjs";

const orderAmounts = async (ctl) => (await ctl.razorpay()).calls.filter((c) => c.path === "/orders").map((c) => c.body.amount);

test("a 10% coupon: the checkout and Razorpay both get the discounted price", async ({ page, context, ctl, buyer }) => {
  await page.goto(`${COURSE_HOST}/`);
  await page.locator("[data-enroll]").first().click();
  const dialog = page.locator("dialog[data-checkout]");
  await dialog.getByText("Have a coupon code?").click();

  // An unknown code is explained next to the field; nothing changes.
  await dialog.getByLabel("Coupon code").fill("NOSUCHCODE");
  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).toContainText("That coupon code doesn't exist.");
  await dialog.getByRole("button", { name: "Close checkout" }).click();

  // WELCOME10 (typed in lower case): ₹1,499 → ₹1,349 (₹1,349.10, charged in paise).
  const before = (await orderAmounts(ctl)).length;
  await checkout(page, buyer, { coupon: "welcome10" });
  await page.waitForURL(`${HUB}/receipt/**`, { timeout: 15_000 });
  const amounts = await orderAmounts(ctl);
  expect(amounts.slice(before)).toEqual([134910]);
  await expect(page.locator("main")).toContainText(/1,349\.10/);
  const [redemption] = await ctl.sql(
    "SELECT r.discount_paise FROM coupon_redemptions r JOIN students s ON s.id = r.student_id WHERE s.email = ?",
    [buyer.email],
  );
  expect(redemption.discount_paise).toBe(14990);
  expectCleanBrowser(context);
});

test("a free coupon enrolls without a payment and opens the course; it can't be used twice", async ({ page, context, ctl, buyer }) => {
  const before = (await orderAmounts(ctl)).length;
  await page.goto(`${COURSE_HOST}/`);
  const dialog = await checkout(page, buyer, { coupon: "GIFTGLOW", submit: false });
  await expect(dialog.locator("[data-co-submit]")).toContainText("Get free access");
  await expect(dialog.locator("[data-co-amount]")).toContainText(/₹\s?0/);
  await dialog.locator("[data-co-submit]").click();

  // No Razorpay, straight into the course on the hub, signed in.
  await page.waitForURL(`${HUB}/learn/glow`, { timeout: 15_000 });
  await expect(page.locator("main")).toContainText("Skin prep");
  expect((await orderAmounts(ctl)).length).toBe(before);
  const mail = await ctl.waitForMail(buyer.email, /^You're enrolled: Glow Makeup/);
  expect(ctl.linkIn(mail)).toMatch(/\/auth\/continue\?t=/);
  const [enrollment] = await ctl.sql(
    "SELECT e.source FROM enrollments e JOIN students s ON s.id = e.student_id WHERE s.email = ? AND e.course_id = 40",
    [buyer.email],
  );
  expect(enrollment.source).toBe("coupon_free");

  // Again with the same email: "You already have this course", with a way to it.
  await page.goto(`${COURSE_HOST}/`);
  const again = await checkout(page, buyer, { coupon: "GIFTGLOW", expectNote: false });
  await expect(again).toContainText(/already/i);
  expect((await orderAmounts(ctl)).length).toBe(before);
  expectCleanBrowser(context);
});
