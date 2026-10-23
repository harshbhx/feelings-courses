# Backups and restore (W7)

The data that matters lives in D1 (`fbc-courses`): courses, students, orders, enrollments, progress, certificates. Lesson videos live in R2 (`fbc-media`) and are the owner's own uploads; keep the originals on the owner's computer or Google Drive.

## Three layers

| Layer | What | When | Kept | Restores |
|---|---|---|---|---|
| 1. D1 Time Travel | Cloudflare's point-in-time history of the database | always on | 7 days (free plan), 30 days (paid) | the whole database to any minute |
| 2. R2 dumps | `functions/_lib/backup.ts`: an SQL dump, gzipped, at `fbc-media/backups/d1/<time>.sql.gz` | daily (lazy daily job), and on demand from the admin (W5) | the last 35, and never more than 35 days (an R2 lifecycle rule `npm run setup` adds) | every business table |
| 3. Offline export | `node scripts/backup-d1.mjs`: `wrangler d1 export` to `backups/` on the owner's computer | monthly, and before risky changes (a migration, go-live) | as long as you keep it | schema and data |

`settings.last_backup_at` holds the last R2 dump's time; the admin shows it (W5/W6). If it is older than two days, the daily job isn't running: check that an admin page was opened (the job is triggered by admin visits and Razorpay webhooks, since Pages has no cron) and read the `daily.failed` entries in the audit log.

### What the R2 dump leaves out

`sessions`, `login_tokens`, `admin_sessions` (credential-like; a restore signs everyone out, which is right after an incident), `rate_limits` (minutes-long) and `d1_migrations` (the schema comes from the migrations). `tests/w7/ops.test.mjs` fails if a new table is in neither list, so nothing is skipped silently.

### Limits

The dump runs inside a Pages Function after the response is sent. Pages Functions on the free Workers plan get about 10 ms of CPU per request, which covers a small database (thousands of rows). If `daily.failed` entries show the backup being cut short as the data grows, rely on layers 1 and 3 and move the dump to a paid plan or a scheduled Worker.

## Restore

**Always restore into a new database first, check it, then switch.** Never run a dump against the live database without a fresh export (layer 3) in hand.

### A bad edit or a bad deploy in the last days: Time Travel

```sh
npx wrangler d1 time-travel info fbc-courses                       # the current bookmark, note it
npx wrangler d1 time-travel restore fbc-courses --timestamp=2026-11-02T10:00:00+05:30
```

The restore itself can be undone with the bookmark it prints.

### The database is gone or Time Travel is too short: an R2 dump

1. Download the dump: Cloudflare dashboard → R2 → `fbc-media` → `backups/d1/` → the newest file → Download. Unzip it: `gunzip <file>.sql.gz`.
2. Create a database and let the site build its schema: `npx wrangler d1 create fbc-courses-restore`, bind it as `DB` on the **preview** environment (Pages → Settings → Bindings), open the preview URL once (the site migrates itself).
3. Load the dump: `npx wrangler d1 execute fbc-courses-restore --remote --file <file>.sql`. It replaces every table it lists, so the demo seed rows are replaced by the backed-up ones.
4. Check the preview: courses, a student, an order, the admin dashboard.
5. Bind `fbc-courses-restore` as `DB` on **production** and redeploy. Keep the old database until you're sure.

### From an offline export (layer 3)

The same steps, with `npx wrangler d1 execute fbc-courses-restore --remote --file backups/fbc-courses-<time>.sql` on an **empty** database (the export contains the schema, so don't open the site against it before loading).

## Privacy

Backups contain students' names and phone numbers. The R2 bucket is private (never give it a public URL), dumps older than 35 days are deleted automatically, and `backups/` is gitignored. The privacy policy (`src/data/legal.ts`) says backups are kept for 35 days; change both together.
