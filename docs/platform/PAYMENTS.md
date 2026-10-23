# Payments (W2): Razorpay live flow

How a course is bought, paid, refunded and receipted on the platform. Code: `functions/_lib/pricing.ts`, `orders.ts`, `payments.ts`, `receipts.ts`, `razorpay.ts`. Tests: `tests/w2/` (fake Razorpay, no real keys).

## Flow

1. **Price** (`POST /api/coupon/quote`, and inside `/api/order`): `quote()` reads the course, batch and coupon from D1. The browser sends a course slug, maybe a batch id and a coupon code. It never sends a price, and nothing else it sends is read.
2. **Order** (`POST /api/order` with an `OrderRequest`): checks the buyer's details (name and **email** required, phone optional) and consent, applies rate limits (per IP and per email), finds or creates the student **by email** (owner decision, 23 Oct 2026: the email is the account; a checkout never changes an existing account, and the phone never finds one), and refuses a second order while the student's access lasts (`409 already_enrolled`). It then writes our `orders` row, creates the Razorpay order for exactly that amount (`receipt: order_<id>`), and links the two.
   - Free orders (an `allow_free` coupon at 100%, or a course priced 0) skip Razorpay and enroll directly. The coupon redemption is unique per student and course, and stays within `max_uses`, even when requests race. The account's email gets "You're enrolled" with a sign-in link; the device is signed in under the same `claim.ts` rule as a payment, else it lands on "check your email" (`/signin?sent=1`).
3. **Verify** (`POST /api/verify`): the signature (HMAC-SHA256 of `order_id|payment_id` with the key secret) is checked first. Then Razorpay's record of the payment, which must match the order, the amount and a captured status (an authorized payment is captured first). Then `fulfilOrder`. The answer redirects to W3's sign-in handoff, which lands on the receipt, only when the payment may open the account on this device (`claim.ts`: the account's email was never proven and it holds nothing else); otherwise to the receipt itself. The receipt and a 15-minute sign-in link go to the account's email, once per order (whichever of verify and the webhook marked it paid sends them; `signin-links.ts sendReceiptEmail`).
4. **Webhook** (`POST /api/razorpay/webhook`): `X-Razorpay-Signature` is checked against the raw body with `RAZORPAY_WEBHOOK_SECRET`. The event is stored once per `X-Razorpay-Event-Id`, then processed. A duplicate of a processed event answers 200 at once. A processing error answers 500 so Razorpay retries, and the event stays in `webhook_events` for the admin's replay.
5. **Fulfil** (`fulfilOrder`): one D1 batch. Every statement is guarded by "the order is still unpaid", and the last one marks it paid, so verify, the webhook, retries and replays apply it exactly once. The batch writes:
   - the enrollment (`access_days` from the payment time; 365 by default);
   - the coupon redemption and `used_count`;
   - the batch seat;
   - the invoice number;
   - the stats;
   - the audit row.

   A paid second order for a course the student already has active is flagged in the audit log (`order.duplicate_payment`) for a refund. It never enrolls the student twice. Seats are checked when the order is created, so two buyers can both pay for a batch's last seat: the later payment still books (the money was taken) and is flagged `order.batch_overbooked` for the admin to move the student or refund. Both flags allow a refund after the 24-hour window.

## Owner decisions in the code

- **Refunds within 24 hours of payment** (`REFUND_WINDOW_SECONDS`). `refundOrder` refuses after that with `refund_window_closed`. The one exception is a payment flagged as a duplicate, which can always be returned.
  - The amount is reserved in `refunds` before Razorpay is called, so two clicks can't refund more than was paid.
  - If Razorpay refuses, the refund is marked failed and the amount is released. If the answer is lost (a timeout), the refund stays pending until the webhook or `syncOrder` matches it by `notes.refund_id`.
  - Refunds made in Razorpay's dashboard are recorded from the webhook. A full refund made there revokes access.
  - A full, revoking refund of a batch booking gives the seat back.
- **Invoice numbers:** `FBC/26-27/00001`, consecutive per Indian financial year (April to March, India time). Each one is given inside the fulfil batch from `invoice_counters`, so there are no gaps and no duplicates.
  - Only **live-mode** payments get one. Test payments show `TEST-<order id>` and never use up numbers in the real series.
  - The number has 15 characters, within GST's 16-character limit.
- **No GSTIN and no tax lines.** The receipt copies the public business fields one by one, so a stored `gstin` can't reach it. A test checks this.
- **Receipts on screen and by email.** The receipt is a page at `https://<hub>/receipt/<orderId>?k=<key>`, where the key is HMAC-SHA256 of the order id with `APP_SECRET` (128 bits). The same link is emailed after the payment (Cloudflare Email Sending, [EMAIL.md](EMAIL.md)).
  - The buyer can print it, save it as a PDF, or share the link on WhatsApp.
  - The page shows the buyer's name only (no phone, no email: someone who paid with another person's address learns nothing more), and sends `Referrer-Policy: no-referrer`, a strict CSP and `noindex`.
  - Without `APP_SECRET` there are no receipt links at all.
- **Modes:** the key prefix decides the mode (`rzp_test_` / `rzp_live_`), and every order and enrollment stores it.
  - Live keys never sell a demo course (`live_keys_on_demo`).
  - Live keys need `legal_confirmed` (`legal_not_confirmed`).
  - Refunds and syncs refuse an order from the other mode (`mode_mismatch`).
  - Stats count live payments only.

## Owner setup (Razorpay dashboard)

- **Webhook URL:** `https://courses.feelingsbeautycare.in/api/razorpay/webhook`, with the secret the setup script writes as `RAZORPAY_WEBHOOK_SECRET`.
- **Events:** `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed` (and `payment.authorized` if auto-capture is off).
- **Auto-capture** is recommended. Without it, the site captures authorized payments itself.

## The demo checkout

The demo checkout (`checkout.ts`) keeps working unchanged until the platform is set up:
- `/api/order` takes the live flow only with D1 bound **and** a body that names a `course`;
- `/api/verify` takes the live flow only when D1 knows the Razorpay order id.

## Left for integration

- **Checkout component:** wire `<Checkout>` (`CheckoutProps`) to send an `OrderRequest`, with a consent checkbox, a coupon field calling `/api/coupon/quote`, the `free` mode, and redirects to the hub.
- **W3:** `issueLoginToken` (handoff) and `/api/me/orders/:id`, which returns `buildReceipt()`.
- **W5:** the admin endpoints that call `refundOrder`, `syncOrder`, `processWebhookEvent` and `loadAdminOrder`.
- **W7:** `bump()`, used for `checkouts_started`. Paid orders, revenue and refunds use W2's own guarded upsert, because an unguarded one would double-count a racing batch.
- **W1:** `_routes.json` must keep `/api/*` and `/receipt/*` in Functions.
