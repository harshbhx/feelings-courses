// Journey 5: a student is their email. Another phone signs in with an emailed single-use link; the
// first proof of the email signs out the unproven paying device; at most 2 devices stay signed in
// (a third sign-in signs out the one used least recently); links work once and expire.
import { buyGlow, expect, expectCleanBrowser, HUB, test } from "./fixtures.mjs";

/** Asks for a sign-in link on `page` and opens it there, landing on `next`. */
async function signInByEmail(page, ctl, email, next = "/learn/glow") {
  const before = (await ctl.mail(email)).length;
  await page.goto(`${HUB}/signin?next=${encodeURIComponent(next)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Open your course on this device");
  await page.getByLabel(/email/i).fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");
  const mail = await ctl.waitForMail(email, /^Your sign-in link/, { after: before });
  const link = ctl.linkIn(mail);
  await page.goto(link);
  // Opening the link only shows Continue (mail scanners that open links sign nobody in).
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Open your course on this device");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(`${HUB}${next}`);
  return link;
}

const signedIn = async (page) => {
  await page.goto(`${HUB}/learn/glow`);
  return !new URL(page.url()).pathname.startsWith("/signin");
};

test("second device by email, the 2-device limit, single-use links", async ({ page, context, device, ctl, buyer }) => {
  // Device A pays (and is signed in by the purchase).
  await buyGlow(page, buyer);
  expect(await signedIn(page)).toBe(true);

  // Device B: signs in with the emailed link. That proves the email, so A (unproven) is signed out.
  const phoneB = await device();
  const pageB = await phoneB.newPage();
  const linkB = await signInByEmail(pageB, ctl, buyer.email);
  await expect(pageB.locator("main")).toContainText("Skin prep");
  expect(await signedIn(page)).toBe(false);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Open your course on this device");

  // The same link can't be used again, on any device.
  const phoneX = await device();
  const pageX = await phoneX.newPage();
  await pageX.goto(linkB);
  await expect(pageX.getByRole("button", { name: "Continue" })).toHaveCount(0);
  expect(await signedIn(pageX)).toBe(false);

  // Device C: two devices now (B and C).
  const phoneC = await device();
  const pageC = await phoneC.newPage();
  await signInByEmail(pageC, ctl, buyer.email);
  expect(await signedIn(pageB)).toBe(true);
  expect(await signedIn(pageC)).toBe(true);
  await pageC.goto(`${HUB}/account`);
  await expect(pageC.locator("main")).toContainText("Signed in on 2 of 2 devices.");

  // Device D: the third sign-in signs out the least recently used device (B).
  const phoneD = await device();
  const pageD = await phoneD.newPage();
  await signInByEmail(pageD, ctl, buyer.email);
  expect(await signedIn(pageD)).toBe(true);
  expect(await signedIn(pageC)).toBe(true);
  expect(await signedIn(pageB)).toBe(false);
  const [{ n }] = await ctl.sql(
    "SELECT COUNT(*) AS n FROM sessions x JOIN students s ON s.id = x.student_id WHERE s.email = ? AND x.revoked_at IS NULL AND x.expires_at > ?",
    [buyer.email, await ctl.now()],
  );
  expect(n).toBe(2);
  expectCleanBrowser(context, phoneB, phoneC, phoneD, phoneX);
});

test("a sign-in link expires after 15 minutes; only the newest link works", async ({ page, context, ctl, buyer, device }) => {
  await buyGlow(page, buyer);
  const phone = await device();
  const p = await phone.newPage();

  // Ask twice: the first link stops working when the second is sent.
  for (let i = 0; i < 2; i++) {
    await p.goto(`${HUB}/signin`);
    await p.getByLabel(/email/i).fill(buyer.email);
    await p.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(p.getByRole("heading", { level: 1 })).toHaveText("Check your email");
  }
  await expect.poll(async () => (await ctl.mail(buyer.email)).filter((m) => /^Your sign-in link/.test(m.subject)).length).toBe(2);
  const [first, second] = (await ctl.mail(buyer.email)).filter((m) => /^Your sign-in link/.test(m.subject)).map((m) => ctl.linkIn(m));
  await p.goto(first);
  await expect(p.getByRole("button", { name: "Continue" })).toHaveCount(0);

  // 16 minutes later the newest one has expired too.
  await ctl.advance(16 * 60);
  await p.goto(second);
  const continueButton = p.getByRole("button", { name: "Continue" });
  if (await continueButton.count()) await continueButton.click();
  expect(await signedIn(p)).toBe(false);
  expectCleanBrowser(context, phone);
});

test("an address with no account gets the same answer and no email", async ({ page, context, ctl }) => {
  const nobody = "nobody-has-this-address@example.com";
  await page.goto(`${HUB}/signin`);
  await page.getByLabel(/email/i).fill(nobody);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Check your email");
  await page.waitForTimeout(500);
  expect(await ctl.mail(nobody)).toEqual([]);
  expectCleanBrowser(context);
});
