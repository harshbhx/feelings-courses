# Rollback plan

What to do when a change goes wrong, from the smallest undo to the biggest. Each section says what it undoes, how long it takes and what it doesn't touch. Work top to bottom: most problems end at section 1 or 2.

**Before any risky change** (go-live, a setup run that shows CHANGE, a restore), have these in hand:
1. an offline database copy: `node scripts/backup-d1.mjs` (needs `npx wrangler login` once);
2. the D1 Time Travel bookmark: `npx wrangler d1 time-travel info fbc-courses`, written down;
3. the latest `setup.local.backup-<time>.json` (every setup run writes one before changing anything: bindings, plain variables, variable names, Time Travel bookmarks and R2 lifecycle rules; never secret values).

## 1. A bad deploy (the site broke after a merge or a publish)

Undoes: the code and pages. Doesn't touch: the database, videos, settings.
Takes: 1 minute.

1. Cloudflare → **Workers & Pages** → `feelings-courses` → **Deployments**.
2. Find the last **Production** deployment that worked → **⋯** → **Rollback to this deployment** → confirm.
3. The site serves that version at once. Then fix the code on a branch; the next merge to `main` deploys again.

Safe because migrations are additive only (CLAUDE.md): an older deployment runs fine on a newer database.

## 2. A failed build after "Publish changes"

Nothing to undo: a failed build leaves the previous deployment live, and the edits are saved in the database.
1. **Deployments** → the failed one → **View build log**.
2. If it says the snapshot API answered 5xx, the database had a hiccup: **Retry deployment**.
3. Anything else: tell Harsh with the log's last 20 lines.

## 3. A setup run went wrong (a variable or binding missing or wrong)

Undoes: Cloudflare settings. Doesn't touch: data.
Takes: 5 minutes.

The script already checks itself afterwards. If it printed `lost …` or `missing …`:
1. Open the newest `setup.local.backup-<time>.json`. Under `project.deployment_configs.<production|preview>` it lists every binding (`d1_databases`, `r2_buckets`, with ids) and every variable name with its type, and the values of the plain ones.
2. Re-add what's missing in **Workers & Pages** → `feelings-courses` → **Settings** → **Variables and Secrets** (variables) or **Bindings** (DB, MEDIA). Secret values aren't in the backup: re-run `npm run setup` (it re-sends every secret it owns from `setup.local.json` and `setup.local.out.json`), or re-type a hand-set one.
3. **Deployments** → **Retry deployment** on the latest production one. Settings only apply to new deployments.

If DB was pointed at the wrong database: bind the right one by id (the backup lists the previous id) in **Bindings**, retry the deployment. `npm run setup` refuses to change an existing DB or MEDIA binding without `--allow-rebind`, so this only happens by hand.

## 4. Going back from live payments to test mode

Undoes: live keys. Doesn't touch: orders already paid (they stay live orders; refund them from the Razorpay dashboard in Live Mode).
Takes: 10 minutes.

1. Put the **test** Key Id and Key Secret back in `setup.local.json`.
2. `npm run setup -- --env production --dry-run`, then `npm run setup -- --env production`.
3. **Retry deployment** on production.
4. Razorpay Live Mode → Webhooks → disable the live webhook (don't delete it; you'll want it back).
5. Admin → Settings shows payment mode **Test** again. The admin refuses to refund a live order with test keys (`mode_mismatch`): do those in the Razorpay dashboard.

## 5. Wrong data (a bad edit, an import gone wrong, a deleted course)

Undoes: the database to a point in time. Loses: everything written after that point (orders, sign-ins, progress), so note the paid orders after that time first (admin → Payments, or Razorpay's Transactions list).
Takes: 15 minutes.

1. Stop editing in the admin.
2. Take an offline copy of the database as it is now: `node scripts/backup-d1.mjs`.
3. Find the time just before the mistake (admin → Activity shows who changed what and when).
4. Restore with D1 Time Travel (the last 7 days on the free plan, 30 on paid):
   ```sh
   npx wrangler d1 time-travel info fbc-courses                                   # note the current bookmark: it undoes the restore
   npx wrangler d1 time-travel restore fbc-courses --timestamp=2026-11-02T10:00:00+05:30
   ```
5. Check the admin. If it's wrong, restore again with `--bookmark=<the bookmark from step 4>` to get back to where you were.
6. Paid orders made after the restore point: open each in Razorpay and press **Re-check with Razorpay** for it in the admin, or, if the order is gone, give the student a sign-in link and enroll them by hand.

Older than Time Travel: docs/ops/BACKUPS.md "Restore" (from the R2 daily dumps or an offline export, always into a new database first, bound to the preview environment, checked, then switched with `npm run setup -- --allow-rebind` or by hand).

## 6. A lifecycle rule or bucket setting looks wrong

The backup file has each bucket's lifecycle rules before the run (`r2.<bucket>.lifecycle`). To put them back: R2 → the bucket → **Settings** → **Object lifecycle rules**, or with wrangler: `npx wrangler r2 bucket lifecycle set fbc-media --file rules.json` with `{ "rules": [ … ] }` copied from the backup.

## 7. A leaked secret

Rotate it (docs/ops/RUNBOOK.md, "Secrets and keys"), redeploy, then check admin → Activity for anything done with it. A leaked deploy hook URL: delete the hook in **Settings** → **Builds** → **Deploy hooks**, add a new one, put it in `setup.local.json`, `npm run setup -- --env production`.

## 8. Remove a course subdomain

1. Admin: unpublish the course or change its address.
2. Cloudflare → `feelings-courses` → **Custom domains** → the domain → **⋯** → **Remove domain**.
3. Cloudflare → `feelingsbeautycare.in` → **DNS** → **Records** → delete the CNAME for that name (Pages doesn't remove it for you).
4. Publish changes, so the hub stops redirecting to the old address.

## What can't be rolled back

- Money: a refund can't be cancelled, and a payment can only be refunded. Fix with a new payment or a refund.
- WhatsApp messages already sent (sign-in links expire after 24 hours and work once; **Sign out all** ends any session made with one).
- Lesson videos deleted with **force**: keep the originals on your computer or Google Drive.
