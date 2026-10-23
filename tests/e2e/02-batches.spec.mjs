// Journey 2: an in-person course. Booking a studio batch pays the booking amount (deposit) online;
// a batch with no seats left is refused at checkout even though the static page (built earlier)
// still lists it; the buyer picks another batch and books it.
import { browserFetch, checkout, expect, expectCleanBrowser, expectNoSideScroll, HUB, STUDIO_HOST, test } from "./fixtures.mjs";

const seats = async (ctl) =>
  Object.fromEntries((await ctl.sql("SELECT id, seats_taken FROM batches WHERE course_id = 41 ORDER BY id")).map((b) => [b.id, b.seats_taken]));

test("book the last seat of a batch; the next buyer is refused and books another batch", async ({ page, context, device, ctl, buyer }) => {
  // The landing page lists the batches with dates and seats (as of the build).
  await page.goto(`${STUDIO_HOST}/`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Studio Makeup Batch");
  await expect(page.locator("main")).toContainText("Last seat batch");
  await expect(page.locator("main")).toContainText("Weekend batch");
  await expectNoSideScroll(page, "studio landing");

  // Buyer 1 books the last seat: Razorpay charges the ₹5,000 booking amount, not the ₹25,000 fee.
  const dialog = await checkout(page, buyer, { batch: "410" });
  await page.waitForURL(`${HUB}/receipt/**`, { timeout: 15_000 });
  await expect(page.locator("main")).toContainText("Your seat is booked.");
  await expect(page.getByRole("link", { name: "Start learning" })).toHaveCount(0);
  const { calls } = await ctl.razorpay();
  expect(calls.filter((c) => c.path === "/orders").at(-1).body.amount).toBe(500000);
  expect(await seats(ctl)).toMatchObject({ 410: 1, 411: 0 });
  void dialog;
  // A studio-only course has no lessons: its account lists the booking.
  await page.goto(`${HUB}/account`);
  await expect(page.locator("main")).toContainText("Studio Makeup Batch");

  // Buyer 2, on another phone, from the same (now stale) page: the full batch is refused.
  const phone = await device();
  const page2 = await phone.newPage();
  await page2.goto(`${STUDIO_HOST}/`);
  const second = { name: "Meera Shah", email: buyer.email.replace(/^buyer-/, "second-"), phone: "" };
  const dialog2 = await checkout(page2, second, { batch: "410" });
  await expect(dialog2).toContainText("That batch is full. Please pick another one.");
  const before = (await ctl.razorpay()).calls.filter((c) => c.path === "/orders").length;
  expect(before).toBe(calls.filter((c) => c.path === "/orders").length);

  // They go back and pick the weekend batch instead.
  await dialog2.getByRole("button", { name: "Try again" }).click();
  await dialog2.locator('select[name="batchId"]').selectOption("411");
  await dialog2.locator("[data-co-submit]").click();
  await page2.waitForURL(`${HUB}/receipt/**`, { timeout: 15_000 });
  await expect(page2.locator("main")).toContainText("Your seat is booked.");
  expect(await seats(ctl)).toMatchObject({ 410: 1, 411: 1 });

  // The admin sees the bookings against the batches.
  const enrollments = await ctl.sql(
    "SELECT s.email, e.batch_id FROM enrollments e JOIN students s ON s.id = e.student_id WHERE e.course_id = 41 AND s.email IN (?, ?) ORDER BY e.batch_id",
    [buyer.email, second.email],
  );
  expect(enrollments).toEqual([
    { email: buyer.email, batch_id: 410 },
    { email: second.email, batch_id: 411 },
  ]);
  expectCleanBrowser(context, phone);
});

test("two buyers racing for one last seat: the batch is never silently overbooked", async ({ page, context, ctl, buyer }) => {
  // A fresh one-seat batch. Both buyers start checkout before either pays (both see a free seat).
  await ctl.sql(
    "INSERT INTO batches (id, course_id, title, starts_on, schedule_text, seats, seats_taken, status, created_at, updated_at) VALUES (412, 41, 'Race batch', '2027-04-05', 'Weekdays', 1, 0, 'open', ?, ?)",
    [await ctl.now(), await ctl.now()],
  );
  await page.goto(`${STUDIO_HOST}/`);
  const order = async (email) => {
    const res = await browserFetch(page, "/api/order", { method: "POST", body: { course: "studio", consent: true, name: "Race Buyer", email, batchId: 412 } });
    expect(res.status, res.text).toBe(200);
    return res.json;
  };
  const first = await order(buyer.email);
  const second = await order(buyer.email.replace(/^buyer-/, "racer-"));
  expect(first.amount).toBe(500000);

  // Both pay on Razorpay; both payments reach /api/verify.
  const verify = async (placed) => {
    const paid = await (await fetch(`http://127.0.0.1:${process.env.E2E_HTTP_PORT ?? 8790}/__e2e/razorpay/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId: placed.orderId }),
    })).json();
    return browserFetch(page, "/api/verify", { method: "POST", body: paid });
  };
  const v1 = await verify(first);
  const v2 = await verify(second);
  expect(v1.status).toBe(200);
  // The money for the second seat was taken, so it must not vanish: either the booking stands and the
  // admin is told the batch is over its seats, or it is refused for a refund. Never a silent overbook.
  const [batch] = await ctl.sql("SELECT seats, seats_taken FROM batches WHERE id = 412");
  const flagged = await ctl.sql("SELECT action FROM audit_log WHERE action = 'batch.overbooked' AND entity_id = 412");
  expect(batch.seats_taken <= batch.seats || flagged.length > 0, `seats ${batch.seats}, taken ${batch.seats_taken}, verify 2: ${v2.status}`).toBe(true);
  expectCleanBrowser(context);
});
