# Feelings Courses

The makeup course of Feelings Beauty Care, on courses.feelingsbeautycare.in. It has three parts:
- a landing page for people arriving from Instagram;
- a Razorpay checkout, in test mode for now;
- a gated course area where buyers watch the lessons.

**Status: demo.** The price and lessons are examples until the client confirms them. Read `CLAUDE.md` first.

```bash
npm install
npm run dev     # http://localhost:4321
npm run build   # astro check + build + CSP hashes (what Cloudflare runs)
npm run test:learn   # course-area gate tests (Node 22, no packages)
```

## Course area

- `/learn` is the dashboard and `/learn/<slug>` one page per lesson. Titles and minutes come from `src/data/course.ts`; slugs and lesson video ids are in `src/data/lessons.ts`.
- **Gate:** every request for `/learn`, `/learn/*`, `/learn.html` and `/learn/*.html` must pass `verifyEnrollment()` (`functions/_lib/enrollment.ts`). Otherwise it gets a 302 to `/?locked=1#pricing`. Gated pages are sent with `Cache-Control: private, no-store`. The files are `functions/learn/_middleware.ts`, `functions/learn.ts`, `functions/learn.html.ts` and the shared `functions/learn/_gate.ts`. The root `functions/_middleware.ts` gates percent-encoded spellings such as `/%6cearn`: Pages routes Functions by the raw path but serves files by the decoded one. It makes every request run through Functions. `/learn/logout` clears the enrollment cookie and goes home.
- **Progress** is saved in the buyer's browser only (localStorage `fbc-progress`).
- **Lesson videos:** none exist yet. Each lesson plays a clearly labelled studio clip from `course.glimpses` instead. To add a real video, set its `videoId` in `src/data/lessons.ts`.

## Deploy

- **Cloudflare Pages project `feelings-courses`.** It is Git-integrated with GitHub `harshbhx/feelings-courses`, and the owner created it. Build command `npm run build`, output folder `dist`, Node 22. Pages picks up `functions/` by itself.
- **Branches:** `main` deploys to production. Every other branch gets a preview at `https://<branch>.feelings-courses.pages.dev`, for example `feat-learn.feelings-courses.pages.dev`.
- **Custom domain:** courses.feelingsbeautycare.in is attached in the Pages project under Custom domains. The feelingsbeautycare.in zone is on Cloudflare, so Cloudflare adds the DNS record itself when the owner activates the domain.
- **Secrets:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `ENROLL_SECRET`. The checkout part owns them. The owner sets them in the Pages project under Settings → Variables and Secrets. Values never go in the repo.
- **Headers and redirects:** `public/_headers`, plus the Content-Security-Policy that `scripts/csp.mjs` writes at build time. `public/_redirects` has the Instagram short links: `/ig` (bio) and `/reel`.
- **Never run `wrangler pages deploy`.** It makes a Direct Upload project, which can't be switched back to Git integration. Push to GitHub instead.

## Payments

Checkout runs in one of three modes. The server picks the mode from the Cloudflare secrets and `course.demo` (`functions/_lib/checkout.ts`, `paymentMode()`); the browser never chooses it. The amount always comes from `src/data/course.ts`, in every mode.

| Mode | When | What the buyer sees | How the payment is checked |
|---|---|---|---|
| **Razorpay** | `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are both set | Razorpay Checkout, with UPI, cards and netbanking. | Fully: a server-side order, Razorpay's signature, and Razorpay's own record of the payment. |
| **Razorpay test** (`razorpay-test`) | `course.demo` is true, no Key Secret is set, and a test Key ID exists: `RAZORPAY_KEY_ID` (`rzp_test_…`) if set, otherwise the committed one below | Razorpay's real Checkout in **Test Mode**, without an order. Before it opens, checkout says "Test payment by Razorpay. No money is charged." | **Not checked.** See below. |
| **Demo** | `course.demo` is true, no Key Secret, and no test Key ID. Also the Razorpay test mode's fallback in Instagram's and Facebook's in-app browsers | A built-in sheet labelled "Test payment: no money is charged". Nothing goes to Razorpay. In the in-app fallback, a note says to open the page in Chrome to try Razorpay's test checkout. | Not needed: no money is involved. |

While `course.demo` is true, only **Test Mode** keys (`rzp_test_…`) work. Live keys (`rzp_live_…`) are refused with a 503 until the course goes live, even a live Key ID on its own. Once `demo` is false, it's the other way round: test keys are refused, so test payments can't unlock the real course. The Razorpay test and Demo modes don't exist then: the live course needs both keys and `ENROLL_SECRET`.

### The committed test Key ID

`src/data/payments.ts` has `RAZORPAY_TEST_KEY_ID = "rzp_test_1DP5mmOlF5G5ag"`. It is a **public Test Mode Key ID**, not a secret: Razorpay Checkout sends a Key ID to the browser anyway, and a test key can't move money. The owner approved committing it on 2026-10-21. It lets the demo open Razorpay's real Checkout before the client has a Razorpay account. **There is no Key Secret for it, and a Key Secret never goes in the repo.**

**What "not checked" means.** Without a Key Secret, the server can't create a Razorpay order, so there is no signature, and it can't ask Razorpay's API about the payment either. `/api/verify` accepts any payment id shaped like Razorpay's (`pay_` and 14 letters or digits) and unlocks the course for it. So someone could type one in and get the demo course for free. That is acceptable only for the demo: the demo sheet unlocks it for free anyway, and Test Mode moves no money. It is impossible once `course.demo` is false, and as soon as the Key Secret is set the full Razorpay mode takes over. Payments in this mode also have no order, and Razorpay's docs say such payments can't be captured: in Test Mode that changes nothing.

**Instagram and Facebook.** Their in-app browsers can't show Checkout in a frame. The Razorpay mode works round that with Razorpay's redirect flow (`callback_url`), but Razorpay's docs list `order_id` as mandatory and don't document that flow without one. So in those browsers the Razorpay test mode opens the demo sheet instead, with a note to open the page in Chrome.

**Going live.** Set a new `ENROLL_SECRET` when the course goes live (or set it then for the first time), so enrollments from test payments stop working.

### Turn on Razorpay test mode

1. Create a free account at [razorpay.com](https://razorpay.com). Test Mode works before KYC.
2. In the Razorpay Dashboard, switch to **Test Mode**. Open **Account & Settings → API Keys** (older dashboards: **Settings → API Keys**) and generate a key. Razorpay shows the **Key Id** (`rzp_test_…`) and the **Key Secret**. The secret is shown only once, so keep it somewhere safe.
3. Make an enrollment secret: any long random string, for example from `openssl rand -hex 32`.
4. In the Cloudflare dashboard, open **Workers & Pages → feelings-courses → Settings → Variables and Secrets**. Add three variables of type **Secret**, for Production and for Preview:
   - `RAZORPAY_KEY_ID`: the Key Id;
   - `RAZORPAY_KEY_SECRET`: the Key Secret;
   - `ENROLL_SECRET`: the random string.
5. Secrets apply to new deployments only. Open **Deployments**, then **Retry deployment** on the latest one (or push a commit).
6. On the site, tap **Enroll**: Razorpay's window should open with "Test Mode" on it.

Secrets never go in the repo, in a `.env` file that is committed, or in a chat with an assistant.

### Test payments (Test Mode only)

From [Razorpay's test integration docs](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/test-integration/):

- **UPI:** `success@razorpay` succeeds, `failure@razorpay` fails.
- **Cards:** any future expiry date and any CVV.

  | Card | Number |
  |---|---|
  | Visa (India) | `4100 2800 0000 1007` |
  | Mastercard (India) | `5500 6700 0000 1002` |
  | RuPay (India) | `6527 6589 0000 1005` |
  | Mastercard (international) | `5555 5555 5555 4444` |
  | Visa (international) | `4012 8888 8888 1881` |

- **Netbanking and wallets:** pick any bank; a mock page offers **Success** and **Failure**.

### How a payment is checked (Razorpay mode)

1. `POST /api/order` creates a Razorpay order on the server. The amount comes from `src/data/course.ts`, never from the browser.
2. Razorpay Checkout opens in the browser. In Instagram's and Facebook's in-app browsers, where its window can't open in a frame, Razorpay sends the buyer back to `/api/verify` instead (`callback_url`).
3. `POST /api/verify` checks Razorpay's signature (HMAC-SHA256 of `order_id|payment_id` with the key secret). It then asks Razorpay for the payment and checks its status, order and amount. Only then does it set the enrollment cookie and send the buyer to `/thank-you`.

In the Razorpay test mode, `POST /api/order` returns the Key ID, amount and prefill with no order id, Checkout's handler gets a `razorpay_payment_id`, and the browser posts `{ mode: "razorpay-test", razorpay_payment_id }` to `/api/verify`, which checks only the id's shape (see above).

The site stores nothing about the buyer. Name, phone and email only prefill Razorpay's form, and Razorpay keeps the payment record. Run the checkout tests with `npm run test:checkout`.
