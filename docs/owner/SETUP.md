# Owner setup, one time (hub page section 5)

About 20 minutes, on a laptop with this repo, Node 22 and `npx wrangler login` done once. Nothing here is needed again unless keys change.

## What you need

- **Razorpay test keys**: Razorpay dashboard → Account & Settings → API keys → Generate (test mode). Copy the Key Id and the Key Secret (shown once).
- **A Cloudflare API token**: Cloudflare dashboard → My Profile → API Tokens → Create token → Custom: Account → Cloudflare Pages: Edit, D1: Edit, Workers R2 Storage: Edit. Limit it to your account.
- **R2 enabled**: Cloudflare dashboard → R2 → Enable (it asks for a card; the course site stays within the free tier: 10 GB stored, no fees for downloads).
- **A deploy hook**: Workers & Pages → `feelings-courses` → Settings → Builds → Deploy hooks → Add (`publish`, branch `main`). Copy its URL.

## Steps

1. `cp setup.example.json setup.local.json` and fill in the four things above. The file is gitignored; never share it.
2. `npm run setup -- --check`: checks the file without touching anything.
3. `npm run setup -- --dry-run`: reads Cloudflare and prints what it would create and set.
4. `npm run setup`: creates the databases (`fbc-courses`, `fbc-courses-preview`) and buckets (`fbc-media`, `fbc-media-preview`), binds them, sets the variables and secrets, and checks afterwards that nothing you had set before was dropped. It never prints a secret.
5. Open `setup.local.out.txt` (private, next to `setup.local.json`): the admin password, and the Razorpay webhook URL and secret.
6. Razorpay dashboard → Settings → Webhooks → Add: the URL and secret from step 5, with the events listed there.
7. Pages → Deployments → Retry the latest deployment, so Functions see the new bindings. The first request then builds the database by itself.
8. Sign in at `https://courses.feelingsbeautycare.in/admin` with the password from step 5, and change it.
9. For each course domain: Workers & Pages → `feelings-courses` → Custom domains → Set up a domain → `<slug>.feelingsbeautycare.in` (about 4 clicks), then "Check domain" in the admin. docs/platform/HOSTS.md has the details; `node scripts/smoke-hosts.mjs <slug>` checks it.

## Going live (later)

When the courses, fees and policies are final:

1. Admin → Settings: confirm the legal pages (the draft note disappears). Unpublish the demo course. Publish the real ones.
2. Razorpay: complete activation, generate **live** keys, add the live webhook (same URL).
3. Put the live Key Id and Secret in `setup.local.json`.
4. `npm run go-live`: it refuses while the legal pages aren't confirmed, the demo course is still published, or no real course is published. Then the same steps as setup, with live keys.
5. `node scripts/check-dist.mjs --live` on a fresh build, and `node scripts/smoke-hosts.mjs <slugs>`.
6. Take a first offline backup: `node scripts/backup-d1.mjs` (docs/ops/BACKUPS.md).

## If something goes wrong

- `setup: … lost <NAME>`: the Cloudflare API replaced variables instead of merging them. Re-add the named ones in Pages → Settings → Variables and Secrets (they're the ones you set by hand earlier, such as the demo's `ENROLL_SECRET`).
- `failed: 10000: Authentication error`: the token lacks a permission from "What you need".
- R2 errors: R2 isn't enabled yet.
- Anything else: docs/ops/RUNBOOK.md.
