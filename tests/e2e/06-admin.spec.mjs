// Journey 6: the course admin. Sign in, create a recorded course with its own web address
// (subdomain), set the fee, add a module and a lesson, upload the lesson's video (multipart upload
// into the fake R2), publish (the Pages deploy hook is called, the public snapshot has the course),
// find a student and their payment, run a backup and download it, sign out.
import { adminSignIn, browserFetch, buyGlow, expect, expectCleanBrowser, HUB, test } from "./fixtures.mjs";
import { VIDEO } from "./world.mjs";

const SLUG = "party-e2e";

test("admin: create, fill, upload, publish; students, payments, backup", async ({ page, context, device, ctl, buyer }) => {
  // A student buys first, so the admin has someone to find.
  const phone = await device();
  const student = await phone.newPage();
  const orderId = await buyGlow(student, buyer);

  // Wrong page without a session: the admin sends you to sign in.
  await page.goto(`${HUB}/admin/courses`);
  await page.waitForURL(`${HUB}/admin?next=**`);
  await adminSignIn(page, "/admin/courses");

  // New course: title, web address (the subdomain), recorded.
  await page.getByRole("button", { name: "New course" }).first().click();
  const create = page.getByRole("dialog").filter({ hasText: "New course" });
  await create.getByLabel("Course title").fill("Party Makeup");
  await create.getByLabel("Web address").fill(SLUG);
  await expect(create).toContainText(`${SLUG}.feelingsbeautycare.in`);
  await create.getByText("Recorded course").click();
  await create.getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(`${HUB}/admin/courses/edit?id=*`);
  const courseId = Number(new URL(page.url()).searchParams.get("id"));
  expect(courseId).toBeGreaterThan(0);

  // Fee and certificate wording, saved.
  await page.getByLabel("Fee", { exact: true }).fill("999");
  await page.getByLabel(/Certificate wording/).fill("Party Makeup certificate");
  await page.locator("[data-save]").first().click();
  await expect(page.getByText("Saved.", { exact: true }).first()).toBeVisible();

  // Lessons: a module and a lesson, saved.
  await page.locator("[data-add-module]").click();
  await page.getByLabel("Module 1 title").fill("Looks");
  await page.getByRole("button", { name: "Add lesson" }).click();
  let drawer = page.getByRole("dialog").filter({ hasText: "New lesson" });
  await drawer.getByLabel("Lesson title").fill("Smoky eyes");
  await drawer.getByRole("button", { name: "Done" }).click();
  await page.locator("[data-outline-save]").click();
  await expect(page.getByText("Lessons saved.").first()).toBeVisible();

  // Upload the lesson's video: a real multipart upload through the admin API into R2.
  await page.getByRole("button", { name: /Smoky eyes/ }).first().click();
  drawer = page.getByRole("dialog").filter({ hasText: "Edit lesson" });
  await drawer.getByText("Upload a video").click();
  const bytes = Buffer.concat([Buffer.from(VIDEO), Buffer.alloc(64 * 1024, 7)]);
  await drawer.getByLabel("Upload video").setInputFiles({ name: "smoky-eyes.mp4", mimeType: "video/mp4", buffer: bytes });
  await expect(page.getByText(/Video uploaded/).first()).toBeVisible({ timeout: 15_000 });
  await expect(drawer).toContainText("Current video:");
  await drawer.getByRole("button", { name: "Done" }).click();
  await page.locator("[data-outline-save]").click();
  await expect.poll(async () => (await ctl.sql("SELECT video_provider FROM lessons WHERE course_id = ?", [courseId]))[0]?.video_provider).toBe("r2");
  const videos = await ctl.r2Keys("videos/");
  expect(videos.some((k) => k.endsWith("smoky-eyes.mp4"))).toBe(true);
  const [lesson] = await ctl.sql("SELECT video_provider, video_ref FROM lessons WHERE course_id = ?", [courseId]);
  expect(lesson.video_provider).toBe("r2");
  expect(videos).toContain(lesson.video_ref);

  // Publish: the deploy hook runs and the public snapshot (what the next build reads) has it.
  const hooksBefore = (await ctl.deployHooks()).length;
  await page.locator("[data-publish]").click();
  await expect(page.getByText(/Publishing\. The site updates|Saved\./).first()).toBeVisible();
  await expect.poll(async () => (await ctl.deployHooks()).length).toBeGreaterThan(hooksBefore);
  const snapshot = (await browserFetch(page, "/api/public/snapshot")).json;
  const published = snapshot.courses.find((c) => c.slug === SLUG);
  expect(published?.title).toBe("Party Makeup");
  expect(published.pricePaise).toBe(99900);
  expect(JSON.stringify(published)).toContain("Smoky eyes");

  // Students: find the buyer by email; their drawer shows the course.
  await page.goto(`${HUB}/admin/students?q=${encodeURIComponent(buyer.email)}`);
  await page.getByRole("button", { name: /Asha Patel/ }).first().click();
  await expect(page.locator(".drawer").last()).toContainText("Glow Makeup");
  await expect(page.locator("body")).not.toContainText(/GSTIN/i);

  // Payments: the order, with its amount and status.
  await page.goto(`${HUB}/admin/payments?open=${orderId}`);
  await expect(page.locator(".drawer-title")).toContainText("1,499");
  await expect(page.locator(".drawer-title")).toContainText("Paid");

  // Backups: back up now, then download the newest copy.
  await page.goto(`${HUB}/admin/settings`);
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByText("Backup saved.").first()).toBeVisible();
  expect((await ctl.r2Keys("backups/")).length).toBeGreaterThan(0);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download the newest" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.sql\.gz$/);

  // Sign out: the admin pages need the password again.
  await page.locator("[data-signout]").first().click();
  await page.waitForURL(`${HUB}/admin**`);
  await page.goto(`${HUB}/admin/dashboard`);
  await page.waitForURL(`${HUB}/admin?next=**`);
  expectCleanBrowser(context, phone);
});
