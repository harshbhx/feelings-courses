# Legal pages: questions for Harsh to confirm

The draft pages are in `src/data/legal.ts` (terms, refunds, privacy, delivery). They show a "draft" note until the admin's **Settings** → **Legal pages** switch is turned on, and live payments stay off until then. This list compares every promise in the draft with what the code actually does on the integration branch (as of 23 Oct 2026). It is a consistency review, not legal advice. Items 12 and 13 are worth a short check with the business's CA.

**Checked and consistent** (no question): refunds within 24 hours of payment (`REFUND_WINDOW_HOURS`, enforced in `functions/_lib/orders.ts`); 1 year of access by default (`DEFAULT_ACCESS_DAYS`); 2 devices (`MAX_DEVICES_PER_STUDENT`); receipts on screen and by email (email identity, 23 Oct 2026: the policies were updated to say email is collected; no new legal question was added); no GSTIN and no tax lines on any public page or receipt (`check-dist.mjs` fails the build if one appears); sign-in by a one-time link sent to the student's email (the admin can also share one on WhatsApp); Razorpay never shows us card or UPI details; the checkout's terms, refund and privacy checkbox; cookies limited to the student session and the admin session; certificates with a public check page and withdrawal by the admin; deposit (booking amount) payments for studio batches.

## A. The wording says one thing and the site does another (pick one side)

**1. Which device gets signed out.**
- Pages say: "signing in on another device signs out the one **used longest ago**" (terms), "the one used least recently" (account page and sign-in page).
- Code does: signs out the device that **signed in first** (`functions/_lib/session.ts`, `ORDER BY created_at`). A student who signed in on a laptop first and uses it daily loses the laptop, not the old phone in a drawer.
- Recommendation: change the code to `last_seen_at` (one line, plus a W3 test), because "used longest ago" is what students expect. Otherwise change the three texts to "the device you signed in on first".
- Confirm: ☐ change the code ☐ change the wording

**2. A refund asked for within 24 hours but answered later.**
- Refund policy says: "a request sent within 24 hours of payment is accepted even if we reply later."
- Code does: the admin's Refund button closes exactly 24 hours after payment (`refund_window_closed`). A late answer has to be refunded in the Razorpay dashboard. The site then picks the refund up from Razorpay's webhook and closes the access, so it works, but outside the admin.
- Confirm: ☐ keep the wording, Urmi uses the Razorpay dashboard for late answers (the owner guide says how) ☐ add an admin override for "asked in time" (code change, W2) ☐ drop the sentence

**3. Refunds after 24 hours in the three exception cases** (batch cancelled or moved, double charge, a fault on our side not fixed in 7 days).
- Same mechanism as 2: duplicates can be refunded from the admin; the other two only from the Razorpay dashboard. Confirm that's acceptable. ☐

**4. A cancelled batch on a hybrid course.**
- Terms say: if we cancel a batch "you can … get a refund of what you paid for that batch."
- Code does: one order pays for the course, with the chosen batch, at one price (a batch may have its own price, which replaces the course price). Nothing says which part of it is the batch and which the recorded lessons. A **full** refund (admin or dashboard) ends access to the recorded lessons too; a partial refund keeps it.
- Confirm: ☐ for hybrid courses, refund a partial amount Urmi decides and keep the lessons (wording: "a refund of the batch part of the fee, as shown on the course page") ☐ full refund and the lessons end ☐ other: ____

**5. "Backup copies of the database: 35 days, then deleted."**
- The daily dumps in R2 keep the last 35 copies (by count). On days without an admin visit or a payment no dump is made, so the oldest copy could be older than 35 days. This PR's setup adds an R2 lifecycle rule that deletes dumps older than 35 days, so that part now holds.
- Not covered by the sentence: the **offline exports** `docs/ops/BACKUPS.md` recommends monthly (`node scripts/backup-d1.mjs`, kept on the owner's computer "as long as you keep it"), and D1 Time Travel (7 days free, 30 paid, fine).
- Confirm: ☐ keep offline copies for at most ____ months and say so ("…and offline copies kept by the owner, deleted after N months") ☐ delete offline copies after 35 days too

**6. "Your IP address … deleted within about two days."**
- Rate-limit rows are cleaned by the daily job, which runs only when the admin is opened or a payment arrives. In a quiet week they can stay longer.
- Suggest: "deleted within a few days". ☐ agree ☐ keep "two days" (then the admin must be opened daily)

**7. "A coupon applies … only once per student unless it says otherwise."**
- Code: coupons have a total use limit (`max_uses`), not a per-student one. A student can't buy the same course twice, but a coupon valid for every course can be used by one student on several courses.
- Confirm: ☐ drop "once per student" ☐ add a per-student limit (code change, W2)

**8. "Access lasts 1 year … unless the course page says otherwise."**
- The admin can set a different access period per course (default 365 days), and the course page shows it. The owner decision was "access 1 year".
- Confirm: ☐ per-course periods are fine (keep the wording) ☐ always 1 year (lock the field in the admin)

## B. Wording that only the owner can confirm

**9. Grievance officer.** Named as "Urmi Mengar" (`src/data/site.ts`, marked "CONFIRM spelling"; old documents also say "Manger"), with the business's legal name and address from admin → Settings. Promises: acknowledge within **48 hours**, resolve within **one month**. ☐ name ☐ spelling ☐ the two time limits

**10. Refund timing.** "We start an approved refund within **2 working days**; banks take 5 to 7 working days." In practice the admin's refund starts at once. ☐ keep 2 working days as the outer promise

**11. Privacy rights.** "We reply within **7 days** and act within **30 days**." ☐ agree

**12. Adults only.** "The courses are for adults. Anyone under 18 may join only when a parent or guardian buys the course and agrees to this policy." The checkout doesn't ask for age or a guardian. Under the DPDP Act, a child's data needs verifiable parental consent. ☐ keep (and accept no age check) ☐ add "I am 18 or older, or a parent/guardian buying for my child" to the checkout checkbox (small code change) — worth asking the CA or a lawyer.

**13. No GSTIN on receipts.** The owner decision is that no GSTIN and no tax lines appear anywhere; the admin stores a GSTIN for records only. If the business is GST-registered, GST rules expect a tax invoice that shows the supplier's GSTIN. ☐ the business is not GST-registered, or the CA has confirmed the on-screen receipt is enough ☐ ask the CA. (The pages say "receipt", never "tax invoice".)

**14. Record keeping: "Payment and receipt records: 8 years."** Eight years is the Companies Act period; a sole proprietorship may only need the Income-tax or GST periods (around 6 years). Longer than needed is still allowed, but the policy should match practice. ☐ 8 years ☐ ____ years

**15. Courts at Jamnagar, Gujarat; liability limited to the amount paid for the course; nothing overrides the Consumer Protection Act, 2019.** ☐ agree

**16. Studio batches.** "The rest of the fee is paid at the studio before the batch starts", "moving to a later batch is possible when a seat is free; not guaranteed", and the studio's hygiene rules. The site records only the online booking amount, not the studio payment, and the online refund policy covers only the online amount. ☐ agree ☐ add how the studio part is refunded

**17. Hosting outside India.** "Cloudflare … Its servers may be outside India." Razorpay stores payment data in India. ☐ agree

## After answering

1. Change `src/data/legal.ts` (and the code for any "code change" box), and set `LEGAL_UPDATED` to the day of the change.
2. `tests/w7/legal.test.mjs` checks the numbers come from the constants; run it with the other tests.
3. Publish, read the four pages on a phone (`/legal/terms`, `/legal/refunds`, `/legal/privacy`, `/legal/delivery`), then admin → **Settings** → **Legal pages** → confirm.
