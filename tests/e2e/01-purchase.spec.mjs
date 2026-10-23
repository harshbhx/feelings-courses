// Journey 1: buy a recorded course on its own subdomain → payment confirmed → signed in on the hub
// → receipt (and the receipt email with a sign-in link) → learn → progress → certificate → the
// public verify page. Runs on desktop and on a 390px phone (playwright.config.mjs).
import { checkout, COURSE_HOST, expect, expectCleanBrowser, expectNoSideScroll, HUB, test } from "./fixtures.mjs";

test("buy a recorded course, learn it, get and verify the certificate", async ({ page, context, ctl, buyer }) => {
  // The landing page on the course's own host, built from the server's snapshot.
  await page.goto(`${COURSE_HOST}/`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Glow Makeup");
  await expect(page.locator("body")).not.toContainText(/GSTIN/i);
  await expectNoSideScroll(page, "landing");

  // Checkout: details → (fake) Razorpay → /api/verify → the hub's one-time sign-in → receipt.
  const dialog = await checkout(page, buyer);
  await expect(dialog).toContainText(/₹\s?1,499/);
  await page.waitForURL(`${HUB}/receipt/**`, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payment received");
  await expect(page.locator("main")).toContainText(/FBC\/\d{2}-\d{2}\/\d{5}/);
  await expect(page.locator("body")).not.toContainText(/GSTIN/i);
  await expect(page.locator("body")).not.toContainText(buyer.phone);
  await expectNoSideScroll(page, "receipt");

  // The server asked Razorpay for its own amount, not the browser's.
  const { calls } = await ctl.razorpay();
  const created = calls.filter((c) => c.path === "/orders").at(-1);
  expect(created.body.amount).toBe(149900);

  // The receipt email went to the buyer, with a link that signs in on another device.
  const receiptMail = await ctl.waitForMail(buyer.email, /^Payment received: Glow Makeup/);
  expect(receiptMail.text).not.toMatch(/GSTIN/i);
  expect(ctl.linkIn(receiptMail)).toMatch(/^https:\/\/courses\.feelingsbeautycare\.in\/auth\/continue\?t=/);

  // Learn: course home, the first lesson, mark both lessons done.
  await page.getByRole("link", { name: "Start learning" }).click();
  await expect(page).toHaveURL(`${HUB}/learn/glow`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Glow Makeup");
  await expect(page.locator("main")).toContainText("Finish every lesson to get your certificate.");
  await expectNoSideScroll(page, "course home");

  await page.getByRole("link", { name: /Start: Skin prep/ }).click();
  await expect(page).toHaveURL(`${HUB}/learn/glow/prep`);
  const video = page.locator("video[data-lesson-id]");
  await expect(video).toHaveAttribute("src", /^\/media\/v\/4001\?/);
  // The signed video link works in this browser (its session cookie) and serves R2's bytes.
  const media = await page.evaluate(async () => {
    const v = document.querySelector("video[data-lesson-id]");
    const res = await fetch(v.getAttribute("src"), { headers: { Range: "bytes=0-7" } });
    return { status: res.status, bytes: [...new Uint8Array(await res.arrayBuffer())] };
  });
  expect(media).toEqual({ status: 206, bytes: [0, 0, 0, 24, 102, 116, 121, 112] });
  await expectNoSideScroll(page, "lesson");

  await page.getByRole("button", { name: "Mark as done and go on" }).click();
  await expect(page).toHaveURL(`${HUB}/learn/glow/base`);
  // The last lesson: done, and back to the course home.
  await page.getByRole("button", { name: /^Mark as done/ }).click();
  await expect(page).toHaveURL(`${HUB}/learn/glow`);

  // Progress is saved on the server.
  const progress = await ctl.sql(
    `SELECT lp.lesson_id, lp.completed_at IS NOT NULL AS done FROM lesson_progress lp JOIN students s ON s.id = lp.student_id
     WHERE s.email = ? ORDER BY lp.lesson_id`,
    [buyer.email],
  );
  expect(progress).toEqual([{ lesson_id: 4001, done: 1 }, { lesson_id: 4002, done: 1 }]);

  // Certificate: course home → Get your certificate → name → the public verify page.
  await page.goto(`${HUB}/learn/glow`);
  await expect(page.locator("main")).toContainText("You've finished the course");
  await page.getByRole("link", { name: "Get your certificate" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Get your certificate");
  await page.getByLabel("Name to print").fill("Asha R. Patel");
  await page.getByRole("button", { name: "Get certificate" }).click();
  await expect(page).toHaveURL(/\/verify\/[A-Z0-9]{6,20}$/);
  const code = page.url().split("/").pop();
  await expect(page.locator("main")).toContainText("Asha R. Patel");
  await expect(page.locator("main")).toContainText("Glow Makeup");
  await expectNoSideScroll(page, "certificate");

  // Anyone can check it: a fresh browser with no session, by typing the code.
  const stranger = await context.browser().newContext({ ignoreHTTPSErrors: true, viewport: page.viewportSize() });
  const other = await stranger.newPage();
  await other.goto(`${HUB}/verify`);
  await other.getByRole("textbox").fill(code.toLowerCase());
  await other.getByRole("button", { name: "Check" }).click();
  await expect(other.locator("main")).toContainText("Asha R. Patel");
  await expect(other.locator("main")).toContainText("Glow Makeup");
  // A made-up code is not a certificate.
  await other.goto(`${HUB}/verify/ZZZZZZZZZZ`);
  await expect(other.locator("main")).not.toContainText("Asha R. Patel");
  await stranger.close();

  // The account lists the course and the payment.
  await page.goto(`${HUB}/account`);
  await expect(page.locator("main")).toContainText("Glow Makeup");
  await expect(page.getByRole("link", { name: /receipt/i }).first()).toBeVisible();
  await expectNoSideScroll(page, "account");

  expectCleanBrowser(context);
});

test("a buyer who closes Razorpay's window is not charged and can try again", async ({ page, context, ctl, buyer, razorpay }) => {
  await page.goto(`${COURSE_HOST}/`);
  razorpay.next = "dismiss";
  const dialog = await checkout(page, buyer);
  await expect(dialog).toContainText("nothing was charged");
  // Try again: this time the payment goes through.
  await dialog.getByRole("button", { name: "Try again" }).click();
  await page.waitForURL(`${HUB}/receipt/**`, { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payment received");
  const orders = await ctl.sql(
    `SELECT o.status FROM orders o JOIN students s ON s.id = o.student_id WHERE s.email = ? ORDER BY o.id`,
    [buyer.email],
  );
  expect(orders.map((o) => o.status)).toEqual(["paid"]);
  expectCleanBrowser(context);
});
