// Journey 4: refunds (owner decision: within 24 hours of purchase). The admin refunds from the
// Payments screen; Razorpay confirms with its webhook; the student's access ends and the receipt says
// Refunded. After 24 hours the admin isn't offered a refund and the API refuses one; access stays.
import { adminSignIn, buyGlow, expect, expectCleanBrowser, HUB, syncClock, test } from "./fixtures.mjs";

const orderStatus = async (ctl, id) => (await ctl.sql("SELECT status, refunded_paise FROM orders WHERE id = ?", [id]))[0];

test("a refund within 24 hours ends access and the receipt says so", async ({ page, context, device, ctl, buyer }) => {
  const orderId = await buyGlow(page, buyer);
  const receiptUrl = page.url();
  await page.goto(`${HUB}/learn/glow`);
  await expect(page.locator("main")).toContainText("Skin prep");

  // Two hours later the student asks; the admin refunds from Payments.
  await ctl.advance(2 * 3600);
  const laptop = await device({ viewport: { width: 1280, height: 800 } });
  await syncClock(laptop);
  const admin = await laptop.newPage();
  await adminSignIn(admin, `/admin/payments?open=${orderId}`);
  const drawer = admin.locator("[data-drawer-body]");
  await expect(drawer).toContainText(/Refundable for .* more/);
  await drawer.getByRole("button", { name: "Refund", exact: true }).click();
  const form = admin.getByRole("dialog").filter({ hasText: "Refund Asha" });
  await form.getByLabel("Reason").fill("Asked within 24 hours, can't attend");
  await form.getByRole("button", { name: "Refund", exact: true }).click();
  await admin.getByRole("button", { name: "Yes, refund" }).click();
  await expect(admin.getByText("Refund started.")).toBeVisible();

  // Razorpay's refund.processed webhook arrives: the order is refunded in full.
  await expect.poll(() => orderStatus(ctl, orderId), { timeout: 10_000 }).toEqual({ status: "refunded", refunded_paise: 149900 });
  await admin.reload();
  await expect(admin.locator("[data-drawer-body]")).toContainText("Already refunded in full.");

  // The student: no course, and the receipt says Refunded.
  await page.goto(`${HUB}/learn/glow`);
  await expect(page.locator("main")).not.toContainText("Skin prep");
  await page.goto(receiptUrl);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payment refunded");
  await expect(page.getByRole("link", { name: "Start learning" })).toHaveCount(0);
  expectCleanBrowser(context, laptop);
});

test("after 24 hours there is no refund: not offered, refused by the API, access stays", async ({ page, context, device, ctl, buyer }) => {
  const orderId = await buyGlow(page, buyer);
  await ctl.advance(24 * 3600 + 60);

  const laptop = await device({ viewport: { width: 1280, height: 800 } });
  await syncClock(laptop);
  const admin = await laptop.newPage();
  await adminSignIn(admin, `/admin/payments?open=${orderId}`);
  const drawer = admin.locator("[data-drawer-body]");
  await expect(drawer).toContainText("The 24-hour refund window has closed.");
  await expect(drawer.getByRole("button", { name: "Refund", exact: true })).toHaveCount(0);

  // Even a direct API call (an old tab, a wrong clock) is refused, and Razorpay is never asked.
  const refundsBefore = (await ctl.razorpay()).refunds.length;
  const res = await admin.request.post(`${HUB}/api/admin/orders/${orderId}/refund`, {
    data: { reason: "Too late", revoke: true },
    headers: { Origin: HUB },
  });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe("refund_window_closed");
  expect((await ctl.razorpay()).refunds.length).toBe(refundsBefore);
  expect(await orderStatus(ctl, orderId)).toEqual({ status: "paid", refunded_paise: 0 });

  // The student still has the course.
  await page.goto(`${HUB}/learn/glow`);
  await expect(page.locator("main")).toContainText("Skin prep");
  expectCleanBrowser(context, laptop);
});
