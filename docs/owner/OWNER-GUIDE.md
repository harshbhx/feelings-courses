# Owner guide: running the course site

For Urmi and Harsh. Plain steps, no screenshots. Every name in **bold** is a button or menu you click.

- **Part A** is a one-time setup on a laptop. Harsh does it, about one hour, test mode first.
- **Part B** is the everyday work in the course admin (`https://courses.feelingsbeautycare.in/admin`). Urmi can do all of it from a phone.
- **Part C** is switching to real payments, once, when everything in Part A and the test checklist is done.

Other pages in this folder:
- [RAZORPAY-TEST-CHECKLIST.md](RAZORPAY-TEST-CHECKLIST.md): the test purchases to do before going live.
- [ROLLBACK.md](ROLLBACK.md): how to undo a bad change.
- [MONITORING.md](MONITORING.md): free alerts.
- [LEGAL-QUESTIONS.md](LEGAL-QUESTIONS.md): the wording questions to answer before the legal pages are confirmed.
- [SETUP.md](SETUP.md): the technical reference for the setup script.

**Three rules:**
- The only secrets you ever handle are the Razorpay keys, the Cloudflare token and the files the setup script writes. They go only into `setup.local.json` on the laptop or into the Cloudflare and Razorpay dashboards. Never into WhatsApp, email, a screenshot, GitHub or a chat with an assistant.
- Test mode first. Real keys (`rzp_live_…`) are used only in Part C.
- If something looks wrong, stop and read [ROLLBACK.md](ROLLBACK.md) before clicking more.

---

## Before you start: what is left for you (as of 24 Oct 2026)

All the code is on one branch, `release/courses-v1`, with green checks, in the draft PR [#29](https://github.com/harshbhx/feelings-courses/pull/29). Already done for you: R2, Workers Paid and Email Sending are on in the **DualMind Labs** Cloudflare account (ID `ce26b52f735d01c85c31b3ff4c74d3bd`), and `courses@feelingsbeautycare.in` forwards to `info.feelingsbeautycare@gmail.com`. Nothing has been set up on Cloudflare for the course platform yet (no database, bucket or mailer), and production has not been touched.

What only you can do, in this order:

1. **Razorpay test keys** (A1): Test Mode → **Account & Settings** → **API Keys** → **Generate Test Key**. Key Id (`rzp_test_…`) and Key Secret go into `setup.local.json` only.
2. **Cloudflare API token** (A2): a custom token named `feelings-courses setup`, Account Resources = **DualMind Labs**, with:
   - Account → **Cloudflare Pages: Edit**
   - Account → **D1: Edit**
   - Account → **Workers R2 Storage: Edit**
   - Account → **Workers Scripts: Edit**
   - optional, only for `--add-domain`: Zone → **Zone: Read** and Zone → **DNS: Edit**, for the zone `feelingsbeautycare.in` only
   - only if the mailer upload fails with an auth error: Account → **Email Sending: Edit** (not expected to be needed)
3. **Deploy hook** (A4): **Workers & Pages** → `feelings-courses` → **Settings** → **Builds** → **Deploy hooks** → **Add deploy hook**, name `publish`, branch `main`.
4. **courses@ replies** (A3b step 3): already forwarding to the salon inbox. Only if replies should reach Urmi's own inbox: add and verify her address under **Email Routing** → **Destination addresses**, then edit the `courses@` rule.
5. **Fill in `setup.local.json`** on the laptop (A5): account ID above, the token, the Razorpay test keys, the deploy hook URL. The file is in `.gitignore`.
6. **Setup on the preview** (A6), from the `release/courses-v1` branch:
   `npm ci`, then `npm run setup -- --check`, `npm run setup -- --env preview --dry-run`, `npm run setup -- --env preview`. Then **Retry deployment** on the `release/courses-v1` preview so it gets the bindings, and test there.
7. **Switch to `main`**: mark PR #29 **Ready for review** and **Merge pull request**. Cloudflare then builds production from the new code (still without bindings, so it shows the public pages and the demo checkout until step 8).
8. **Setup on production, only after step 7**: `npm run setup -- --dry-run`, then `npm run setup`. Then the test webhook (A7), **Retry deployment** on production (A8), the first admin sign-in (A9) and [RAZORPAY-TEST-CHECKLIST.md](RAZORPAY-TEST-CHECKLIST.md).
9. **Before real money** (Part C): the legal wording ([LEGAL-QUESTIONS.md](LEGAL-QUESTIONS.md)), real courses and fees, Razorpay KYC and live keys.

Why production waits for step 7: the demo now on `main` reads `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. Set on production before the switch, they would turn the demo's built-in test sheet into Razorpay test checkout on its next build.

---

## Part A: one-time setup (Harsh, on the laptop)

You need: this repo, Node 22 or newer, and logins for Cloudflare (the account that has `feelingsbeautycare.in`) and Razorpay.

### A1. Razorpay test keys

1. Sign in at dashboard.razorpay.com.
2. Switch the toggle at the top to **Test Mode**.
3. **Account & Settings** → **API Keys** → **Generate Test Key** (or **Regenerate** if one exists).
4. Copy the **Key Id** (starts with `rzp_test_`) and the **Key Secret**. The secret is shown only once. Paste both straight into `setup.local.json` (step A5), nowhere else.

### A2. A Cloudflare API token for the script

1. Cloudflare dashboard → your profile icon → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**.
2. Name it `feelings-courses setup`.
3. Permissions, all on **Account** level:
   - **Cloudflare Pages: Edit**
   - **D1: Edit**
   - **Workers R2 Storage: Edit**
   - **Workers Scripts: Edit** (the small mailer Worker that sends sign-in links and receipts)
4. Optional, only if you want the script to add course subdomains for you (B1 has the dashboard way): **Zone → Zone: Read** and **Zone → DNS: Edit**, limited to the zone `feelingsbeautycare.in`.
5. **Account Resources**: only this account. Give it an end date a few weeks away; you can make a new one later.
6. **Continue to summary** → **Create Token**. Copy it once into `setup.local.json`.

Also copy the **Account ID**: **Workers & Pages** → right-hand side → **Account ID** (32 letters and digits).

### A3. Turn on R2 (the storage for videos and backups)

**Checked 23 Oct 2026: already done.** `feelingsbeautycare.in`, the `feelings-courses` Pages project, Email Sending and R2 all live in the **DualMind Labs** account (ID `ce26b52f735d01c85c31b3ff4c74d3bd`), and R2 is already on there (the salon app's `fbc-staff-media` bucket). Skip A3 and steps 1 and 2 of A3b on that account; the steps below are for a fresh account.

1. Cloudflare dashboard → **R2 object storage** → **Purchase R2 Plan** / **Enable R2**.
2. It asks for a card. The course site stays inside the free allowance (10 GB stored, a million uploads and ten million reads a month, downloads are never charged). Nothing is charged unless that is passed. [MONITORING.md](MONITORING.md) shows how to see the usage.
3. Don't create buckets yourself: the script does that with the right names.

### A3b. Email: let Cloudflare send from feelingsbeautycare.in

Students sign in with a link we email them, and get their receipt by email. Cloudflare sends it (Email Sending), so there is no other email company to pay. Three dashboard steps, once:

1. **Workers Paid plan** on this Cloudflare account (**Workers & Pages** → **Plans**). Sending to any address needs it; 3,000 emails a month are included. If the salon app (Feelings Staff) already runs on this account, it is already on.
2. **Compute** → **Email Service** → **Email Sending** → **Onboard Domain** → `feelingsbeautycare.in` → **Done**. Cloudflare adds its own records on a `cf-bounce` sub-domain; the existing email forwarding keeps working. Wait until it shows **Verified** (usually minutes). If the domain is already listed there (the salon app did it), skip this step. It must be the **same Cloudflare account** as the `feelings-courses` Pages project.
3. Replies: emails come from `courses@feelingsbeautycare.in`. **Email Service** → **Email Routing** → **Routing rules** → **Create address**: `courses` → send to Urmi's inbox, so a student who replies reaches someone. (Done 23 Oct 2026: `courses@` forwards to `info.feelingsbeautycare@gmail.com`, the same verified inbox as the salon app's `staff@`. Change the destination there if replies should go elsewhere.)

The setup script (A6) does the rest. To use another sender, set `"email": { "from": "…@feelingsbeautycare.in" }` in `setup.local.json` and add the same routing rule for it. More in [docs/platform/EMAIL.md](../platform/EMAIL.md).

### A4. The deploy hook (so "Publish changes" rebuilds the site)

Cloudflare has no API to create this, so it is a dashboard step.

1. **Workers & Pages** → `feelings-courses` → **Settings** → **Builds** → **Deploy hooks** → **Add deploy hook**.
2. Name `publish`, branch `main` → **Save**.
3. Copy the URL (it starts with `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/`). Anyone with this URL can start a build, so treat it like a password: it goes only into `setup.local.json`.

### A5. Fill in `setup.local.json`

In the repo folder:

```sh
cp setup.example.json setup.local.json
```

Open `setup.local.json` and replace each example value: account ID, token, the two Razorpay test values, the deploy hook URL. Leave `project`, `hubHost` and `apexDomain` as they are. The file is ignored by git; never send it to anyone.

### A6. Run the setup, preview first

```sh
npm ci
npm run setup -- --check                    # checks the file only
npm run setup -- --env preview --dry-run    # reads Cloudflare, shows the plan, changes nothing
npm run setup -- --env preview              # type "yes" when asked
```

What to look for in the plan:
- `will be created` for `fbc-courses-preview` and `fbc-media-preview` the first time, `exists` after that.
- `binding DB … add` the first time, `keep` after that. If you ever see **CHANGE** or **STOP**, don't continue: an existing database would be swapped. Read [ROLLBACK.md](ROLLBACK.md) first.
- No secret is ever printed. If you see one, stop and tell Harsh's assistant only the line's first words, not the value.

Then production, but only after this code is on `main`. The project's production environment is what `main` deploys, and the demo now on `main` reads `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`: with them set, its next deployment would swap the built-in demo checkout for real Razorpay test checkout.

```sh
npm run setup -- --dry-run
npm run setup
```

The script writes three private files next to `setup.local.json`:
- `setup.local.out.txt`: the admin passwords and the Razorpay webhook details. Open it, use it, and keep it somewhere safe (a password manager).
- `setup.local.out.json`: the same values for the script itself. Keep it: without it, the next run makes new passwords.
- `setup.local.backup-<time>.json`: what Cloudflare had before the change (no secret values). [ROLLBACK.md](ROLLBACK.md) uses it.

### A7. Razorpay webhook (test mode)

1. Razorpay dashboard, still in **Test Mode** → **Account & Settings** → **Webhooks** → **Add New Webhook**.
2. **Webhook URL**: `https://courses.feelingsbeautycare.in/api/razorpay/webhook`.
3. **Secret**: the production webhook secret from `setup.local.out.txt`.
4. **Active events**: `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`.
5. **Create Webhook**.
6. **Account & Settings** → **Payment Capture**: automatic capture on (the site also captures by itself, this is a second safety net).

Testing purchases on a preview address instead of the real one? `setup.local.out.txt` also shows the preview URL and its own secret. Razorpay test mode has one webhook list, so add a second webhook for the preview, and delete it when you're done.

### A8. Redeploy so the site sees the new settings

Settings only reach the site on the next deployment.

1. **Workers & Pages** → `feelings-courses` → **Deployments**.
2. On the latest **Production** deployment: **⋯** → **Retry deployment**. Wait for **Success** (about 2 minutes).
3. Open `https://courses.feelingsbeautycare.in/` once. The site builds its database tables by itself on this first visit.
4. Check email: open `https://courses.feelingsbeautycare.in/signin` and enter an email that has a course (after your first test purchase). The sign-in link should arrive within a minute (look in Spam once). Nothing? Check A3b, then **Workers & Pages** → `fbc-courses-mailer` → **Logs** for a code like `E_SENDER_NOT_VERIFIED`.

### A9. First sign-in to the admin

1. Open `https://courses.feelingsbeautycare.in/admin` and sign in with the production admin password from `setup.local.out.txt`.
2. **Settings** → **Admin password** → choose your own. Every other device is signed out.
3. **Settings** → **Backups** → **Back up now**, then **Download the newest** and keep the file off Cloudflare (Google Drive is fine).

Now do the test purchases in [RAZORPAY-TEST-CHECKLIST.md](RAZORPAY-TEST-CHECKLIST.md).

---

## Part B: everyday work (Urmi, in the admin)

### B1. Give a course its own address (`glow.feelingsbeautycare.in`)

1. Admin → **Courses** → the course → **Web address** → type the subdomain (`glow`). Lowercase letters, digits and hyphens. Save.
2. Open **Set up the subdomain in Cloudflare** → **Open Cloudflare**. In Cloudflare: **Custom domains** → **Set up a custom domain** → type `glow.feelingsbeautycare.in` → **Continue** → **Activate domain**. Cloudflare adds the DNS record by itself because the domain is already on Cloudflare.
3. Wait 5 to 10 minutes (Cloudflare issues the certificate).
4. Back in the admin, on the course: **Check now**. When it says the address works, the course's page moves to its own address on the next publish.

Harsh can do steps 2 and 3 from the laptop instead: `npm run setup -- --add-domain glow --dry-run`, then without `--dry-run`. It attaches the domain first and then adds the DNS record, which is the order Cloudflare needs (a DNS record made first gives a 522 error page). Once the subdomain is active it can't be renamed in the admin; ask Harsh.

Up to 100 course addresses fit on the free plan.

### B2. Publish changes

Prices, enrollments, progress and videos are live as soon as you save. Course **pages** (text, photos, the list of lessons) are rebuilt by Cloudflare:

1. Save your edits. A **Publish changes** chip appears at the top.
2. Tap **Publish changes**. The chip shows **Updating site…** for about 2 minutes.
3. When it disappears, the pages are updated. A second publish within 2 minutes waits; that's on purpose.

If it says the build didn't start: nothing is lost (your edits are saved). Try again in 2 minutes. If it still fails, Harsh checks **Workers & Pages** → `feelings-courses` → **Deployments** for a failed build ([ROLLBACK.md](ROLLBACK.md), section 2).

### B3. Handle a refund

The policy: a full refund for any reason within **24 hours** of payment.

**Within 24 hours** (the normal case):
1. Admin → **Payments** → find the student (search by name or phone) → open the payment.
2. The drawer says **Refundable for … more (until …)**.
3. **Refund** → leave the amount empty for a full refund → write the reason (for example "asked on WhatsApp 10:15") → keep **End their access too** on → **Refund** → **Yes, refund**.
4. It says "Refund started". Razorpay confirms in a few minutes; then the payment shows Refunded and the course closes for that student. If it still says pending after an hour: **Re-check with Razorpay**.
5. Tell the student on WhatsApp. Banks take 5 to 7 working days to show the money.

**After 24 hours**, the admin's Refund button is closed. The policy still allows a refund in three cases: you cancelled or moved a studio batch, they were charged twice, or a fault on our side stops them from using the course. Also when they asked within 24 hours and you are answering late. For these:
1. A payment Razorpay or the site flagged as a duplicate can still be refunded from the admin.
2. Otherwise: Razorpay dashboard (**Live Mode** after go-live) → **Transactions** → **Payments** → search the `pay_…` ID from the student's receipt → **Issue Refund** → full amount → write the reason.
3. The site hears about it from Razorpay by itself: a full refund ends the course access, a partial one doesn't. In the admin, **Re-check with Razorpay** on that payment shows it at once.

A full refund always ends the access to that course's recorded lessons, also for a hybrid course where only the batch was cancelled. If the student should keep the lessons, refund part of the amount instead ([LEGAL-QUESTIONS.md](LEGAL-QUESTIONS.md), question 4).

### B4. Help someone sign in

Students sign in by themselves: on the sign-in page they type their email and open the link we send them (it works once, for 15 minutes). Help is for a student whose email doesn't arrive, who typed it wrong when paying, or who can't open their inbox.

1. Admin → **Students** → search by name, email or phone → open the student.
2. Wrong or missing email? **Edit details** → correct it → **Save**. (Links already sent to the old address stop working.)
3. **Email a sign-in link**. It goes to their email at once and works once, for 24 hours.
4. Can't reach their email? **Share on WhatsApp** (or **Copy link**) and send it to the student's own number.
5. They tap it, press **Continue**, and are signed in on that phone.

Good to know:
- A student's email is their account. They can't change it themselves: you do, after checking it's really them.
- A student can be signed in on **2 devices**. Signing in on a third signs out the device they signed in on first.
- **Sign out all** in the student drawer ends every device at once (for a lost phone or a shared account). Use it too after changing an email that wasn't theirs.
- Never send a sign-in link to anyone but the student.

### B5. Receipts

After paying, the student sees the receipt on screen, gets it by email (with a link to open the course), and keeps it in **My account**. If they ask for it again: open their payment in the admin, open the receipt, and share the link or a screenshot on WhatsApp. Receipts never show a GSTIN or tax lines.

### B6. Weekly habits (5 minutes)

- Open the admin at least once a day you have students (the daily clean-up and backup run when the admin is opened or a payment arrives).
- **Settings** → **Backups**: the last copy should be from today or yesterday. Once a month, **Download the newest** and keep it.
- **Payments**: anything stuck in "pending" for more than a day → **Re-check with Razorpay**.

---

## Part C: switching to real payments (Harsh, once)

Only after the whole test checklist passes and the legal questions are answered.

1. Razorpay: finish account activation (KYC). Then switch to **Live Mode** → **Account & Settings** → **API Keys** → **Generate Key**. Copy both values into `setup.local.json` (replacing the test ones; keep a copy of the test ones in your password manager).
2. Razorpay **Live Mode** → **Webhooks** → add the same webhook as A7 (same URL, the production secret, the same five events). Live and test webhooks are separate lists.
3. Admin: publish the real courses with their fees; unpublish the demo course; **Settings** → **Legal pages** → confirm.
4. On the laptop:
   ```sh
   npx wrangler login                      # once per laptop, for the backup below
   node scripts/backup-d1.mjs              # an offline copy of the database first
   npm run go-live -- --dry-run            # the go-live checks and the plan
   npm run go-live
   ```
   go-live refuses while the legal pages aren't confirmed, the demo course is published, or no real course is published. It changes **production only**: previews keep the test keys, so a preview can never take real money.
5. Redeploy (A8), then make one real ₹1 purchase with a coupon (or the smallest real course), and refund it from the admin.
6. `node scripts/smoke-hosts.mjs <every course slug>` and keep the result.

To go back to test mode: [ROLLBACK.md](ROLLBACK.md), section 4.
