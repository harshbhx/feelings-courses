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

Checkout runs in one of two modes. The server picks the mode from the Cloudflare secrets; the browser never chooses it.

| Mode | When | What the buyer sees |
|---|---|---|
| **Demo** | No Razorpay keys are set (and `course.demo` is true) | A built-in sheet labelled "Test payment: no money is charged". Nothing goes to Razorpay. |
| **Razorpay** | `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are set | Razorpay Checkout, with UPI, cards and netbanking. |

While `course.demo` is true, only **Test Mode** keys (`rzp_test_…`) work. Live keys (`rzp_live_…`) are refused with a 503 until the course goes live. Once `demo` is false, it's the other way round: test keys are refused, so test payments can't unlock the real course.

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

### How a payment is checked

1. `POST /api/order` creates a Razorpay order on the server. The amount comes from `src/data/course.ts`, never from the browser.
2. Razorpay Checkout opens in the browser. In Instagram's and Facebook's in-app browsers, where its window can't open in a frame, Razorpay sends the buyer back to `/api/verify` instead (`callback_url`).
3. `POST /api/verify` checks Razorpay's signature (HMAC-SHA256 of `order_id|payment_id` with the key secret). It then asks Razorpay for the payment and checks its status, order and amount. Only then does it set the enrollment cookie and send the buyer to `/thank-you`.

The site stores nothing about the buyer. Name, phone and email only prefill Razorpay's form, and Razorpay keeps the payment record. Run the checkout tests with `npm run test:checkout`.
