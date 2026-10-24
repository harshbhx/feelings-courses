# Razorpay test-mode checklist

Do every line on a phone at 390 px wide, in test mode, before Part C of [OWNER-GUIDE.md](OWNER-GUIDE.md). Tick it, note the `pay_…` ID, and write down anything odd. No real money moves in test mode.

**Test payment details** (Razorpay's own; they work only in test mode):
- UPI: `success@razorpay` succeeds, `failure@razorpay` fails.
- Card that succeeds: Visa `4100 2800 0000 1007`, any future expiry, any CVV. On Razorpay's test page, an OTP of 4 to 10 digits succeeds and a shorter one fails.
- Cards that fail on purpose: `4100 2800 0006 0003` (declined), `4100 2800 0008 0001` (insufficient funds).
- Netbanking: pick any bank, then **Success** or **Failure** on Razorpay's test page.

## 0. Before the first test

- [ ] `npm run setup -- --dry-run` shows `keep` for every binding and nothing marked CHANGE or STOP.
- [ ] Pages → Settings → Variables and Secrets (Production) lists `RAZORPAY_KEY_ID` starting with `rzp_test_`.
- [ ] Razorpay is in **Test Mode** and the webhook from A7 is **Active** with the five events.
- [ ] The latest Production deployment says **Success** and was made **after** the setup run (A8).
- [ ] Admin → Settings shows payment mode **Test**.
- [ ] One test course is published, with a fee and one video lesson, plus a coupon `TEST10` (10 % off).

## 1. A normal purchase

- [ ] Open the course's page (on its own subdomain if it has one). The price is the admin's fee.
- [ ] Enroll → name, phone → the terms / refund (24 hours) / privacy box must be ticked to continue.
- [ ] Coupon `TEST10` → the price drops by 10 % before paying.
- [ ] Pay with `success@razorpay`.
- [ ] You land on the receipt: invoice number `FBC/26-27/…`, masked phone, amount paid, **no GSTIN and no tax lines**.
- [ ] **Open course** → a lesson plays; leave and come back, it resumes.
- [ ] Admin → Payments shows the payment as Paid within a minute (the webhook arrived). Razorpay → Webhooks → the webhook shows delivered events with status 200.

## 2. Failures don't give access

- [ ] Pay with `failure@razorpay` → the "payment failed" page, no access, no receipt. Admin shows it as failed or not paid.
- [ ] Close the Razorpay window halfway → back on the course page, nothing charged.
- [ ] Try to buy the same course again with the email from step 1 → it says you're already enrolled and offers your account.

## 3. Devices and sign-in

- [ ] The receipt email arrived at the address you paid with, with **View receipt** and **Open my course**.
- [ ] On a second phone or browser: open `/signin`, enter the same email → a sign-in email arrives → **Sign in** → **Continue** → the course opens. Open the same link again → "expired or already used".
- [ ] Ask for a link for an email that never bought anything → the same "Check your email" page, and no email arrives.
- [ ] Buy a course with a **new** email but a phone number already used before → a new account (the phone never links accounts).
- [ ] On a third browser: sign in again → the **first** device is signed out on its next page load.
- [ ] Admin → Students → the student → **Email a sign-in link** → it arrives by email; **Share on WhatsApp** also works → open the link on another phone → signed in. Open the same link again → it refuses (one use only).
- [ ] Admin → the student → **Edit details** → change the email → a link sent earlier to the old address no longer works.
- [ ] Admin → the student → **Sign out all** → every device is signed out.

## 4. Refunds

- [ ] Admin → Payments → the payment from step 1 → **Refund** (full, **End their access too** on) → "Refund started".
- [ ] Within a few minutes the payment shows Refunded (or press **Re-check with Razorpay**), the receipt says Refunded, and the course no longer opens (videos stop within a minute).
- [ ] Buy again, then refund **part** of it with **End their access too** off → the course stays open.
- [ ] Refund from the Razorpay dashboard instead (Transactions → Payments → the payment → Issue Refund, full) → the site marks it refunded and closes the access by itself.
- [ ] A payment older than 24 hours: the admin's Refund button is closed and says why. (Wait a day, or check on the first payment from step 1 the next day.)

## 5. Free and studio courses

- [ ] A 100 % coupon with "allow free" on → enroll without Razorpay opening → signed in, course open.
- [ ] A course with a studio batch: the batch picker shows the open batches with seats left; after paying, the receipt shows the batch dates.
- [ ] A batch with no seats left doesn't appear.

## 6. Instagram

- [ ] Open the course link from an Instagram story or DM (Instagram's own browser) → enroll → pay with `success@razorpay` → you end up signed in on the receipt.

## 7. After the tests

- [ ] Admin → Settings → Backups → **Back up now** → **Download the newest** opens a file.
- [ ] Admin → Activity lists the refunds and sign-in links you made.
- [ ] Delete or unpublish the test course and the `TEST10` coupon. Test-mode orders stay in the database marked as test; live mode never mixes them up (a refund of a test order with live keys is refused).
- [ ] If you added a preview webhook in Razorpay, delete it.

Anything that failed: note the step, the time and the `pay_…` ID, and don't go live until it's fixed.
