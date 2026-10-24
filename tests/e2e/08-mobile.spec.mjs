// Journey 8: a 390px phone (the "mobile" project; 01-purchase also runs there end to end). Every
// page a student or the admin opens fits the screen (no sideways scroll), the enroll bar and the
// checkout fit, and the admin works on a phone.
import { adminSignIn, COURSE_HOST, expect, expectCleanBrowser, expectNoSideScroll, HUB, STUDIO_HOST, test } from "./fixtures.mjs";

test("public pages fit a phone, and the checkout opens full width", async ({ page, context }) => {
  for (const url of [`${HUB}/`, `${COURSE_HOST}/`, `${STUDIO_HOST}/`, `${HUB}/signin`, `${HUB}/verify`, `${COURSE_HOST}/terms`, `${COURSE_HOST}/refunds`, `${HUB}/admin`]) {
    await page.goto(url);
    await expect(page.locator("body")).toBeVisible();
    await expectNoSideScroll(page, url);
  }

  // The landing page's enroll button opens a checkout that fits the screen.
  await page.goto(`${COURSE_HOST}/`);
  await page.locator("[data-enroll]").first().click();
  const dialog = page.locator("dialog[data-checkout]");
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390 + 1);
  await expectNoSideScroll(page, "checkout open");
  // Fields are big enough to tap (44px, CLAUDE.md).
  const submit = await dialog.locator("[data-co-submit]").boundingBox();
  expect(submit.height).toBeGreaterThanOrEqual(44);
  expectCleanBrowser(context);
});

test("the admin on a phone: dashboard, courses, payments, students, settings", async ({ page, context }) => {
  await adminSignIn(page);
  for (const path of ["/admin/dashboard", "/admin/courses", "/admin/payments", "/admin/students", "/admin/coupons", "/admin/settings", "/admin/activity"]) {
    await page.goto(`${HUB}${path}`);
    await expect(page.locator("main")).toBeVisible();
    // Let the screen load its data before measuring.
    await page.waitForLoadState("networkidle");
    await expectNoSideScroll(page, path);
  }
  await page.goto(`${HUB}/admin/courses/edit?id=40`);
  await page.waitForLoadState("networkidle");
  await expectNoSideScroll(page, "course editor");
  expectCleanBrowser(context);
});
