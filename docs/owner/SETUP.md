# Setup script reference (hub page section 5)

The step-by-step version for the owner is [OWNER-GUIDE.md](OWNER-GUIDE.md), Part A. This page is the reference for `scripts/setup.mjs`. How each Cloudflare call behaves, with sources: [docs/ops/CLOUDFLARE-API.md](../ops/CLOUDFLARE-API.md).

Needs Node 22.13 or newer and `setup.local.json` (copy `setup.example.json`; gitignored).

## Commands

| Command | Does |
|---|---|
| `npm run setup -- --check` | validates `setup.local.json`, no network |
| `npm run setup -- --dry-run` | reads Cloudflare and prints the plan; writes nothing, locally or remotely |
| `npm run setup -- --env preview` | the preview environment only (do this first) |
| `npm run setup -- --env production` | production only |
| `npm run setup` | both environments, test keys |
| `npm run go-live -- --dry-run` / `npm run go-live` | live keys, **production only**; refuses until the legal pages are confirmed, the demo course is unpublished and a real course is published |
| `npm run setup -- --add-domain <slug> [--dry-run]` | attaches `<slug>.<apexDomain>` to the Pages project, then adds the proxied CNAME (needs Zone Read + DNS Edit on the token) |
| `--yes` | skips the "type yes" question (for a second run you've already checked with `--dry-run`) |
| `--allow-rebind` | allows pointing an existing `DB` / `MEDIA` binding at another database or bucket (after a restore) |

Unknown options stop the script, so a typo like `--dryrun` never becomes a real run.

## What a run does

1. Reads the Pages project. Stops if a wrangler config exists in the repo.
2. Finds `fbc-courses` / `fbc-courses-preview` (D1) and `fbc-media` / `fbc-media-preview` (R2). Warns if a bucket is public on r2.dev.
3. `--live`: runs the go-live query on the production database.
4. Prints the plan, per environment: each binding (`add`, `keep`, `CHANGE`) and each variable (`add`, `keep`, `change`, or `set again` for a secret, whose value can't be read back). Stops on `CHANGE` of DB or MEDIA unless `--allow-rebind`.
5. `--dry-run` ends here.
6. Asks for `yes`.
7. Writes `setup.local.backup-<time>.json`: the project's bindings, plain variables, secret names and types (never values), each database's Time Travel bookmark and each bucket's lifecycle rules.
8. Creates what's missing (location hint `apac`, or `cloudflare.location`), and adds the R2 lifecycle rule `fbc-backups-35d` (dumps under `backups/d1/` deleted after 35 days), keeping every other rule.
9. Writes `setup.local.out.json` and `setup.local.out.txt` (admin passwords, webhook secrets, the mailer key) before sending anything.
10. Uploads the mailer Worker `fbc-courses-mailer` (`workers/mailer/index.js`) with its `send_email` binding locked to the sender (`email.from`, default `courses@feelingsbeautycare.in`), and turns its `workers.dev` and preview URLs off. One Worker serves both environments. ([docs/platform/EMAIL.md](../platform/EMAIL.md))
11. PATCHes the bindings (`DB`, `MEDIA`, the `MAILER` service binding), variables and secrets (the API merges per key; nothing it doesn't own is touched).
12. Reads the project back: anything that was there before and is gone, or anything it set that's missing, is named.

All local files are mode 600 and gitignored. The console shows names, ids and actions only.

### Variables and secrets it sets

| Name | Type | Production | Preview |
|---|---|---|---|
| `APP_ENV` | plain | `production` | `preview` |
| `HUB_HOST`, `APEX_DOMAIN` | plain | from `setup.local.json` | same |
| `RAZORPAY_KEY_ID` | plain | test key (setup) or live key (go-live) | always the test key |
| `RAZORPAY_KEY_SECRET` | secret | matches the key id | test |
| `APP_SECRET`, `ADMIN_PASSWORD_HASH`, `RAZORPAY_WEBHOOK_SECRET` | secret | generated once, reused | generated once, reused (different from production) |
| `DEPLOY_HOOK_URL` | secret | from `setup.local.json` | never (a preview never rebuilds production) |
| `EMAIL_PROVIDER` | plain | `cloudflare` | `cloudflare` (previews send real mail: test with your own address) |
| `MAILER_KEY` | secret | generated once, reused; the mailer Worker holds the same value | same key (one Worker) |
| `DB`, `MEDIA` | bindings | `fbc-courses`, `fbc-media` | `fbc-courses-preview`, `fbc-media-preview` |
| `MAILER` | service binding | Worker `fbc-courses-mailer` | same Worker |

On the mailer Worker: `EMAIL` (send_email, `allowed_sender_addresses: [email.from]`), `EMAIL_FROM`, `EMAIL_FROM_NAME` (plain) and `MAILER_KEY` (secret).

To rotate a generated secret, delete its value (or the whole file) in `setup.local.out.json` and run setup again; docs/ops/RUNBOOK.md lists the effects.

## The token

Account → Cloudflare Pages: Edit, D1: Edit, Workers R2 Storage: Edit, Workers Scripts: Edit. For `--add-domain` also Zone → Zone: Read and DNS: Edit on `feelingsbeautycare.in`. Limit it to the account and give it an end date.

## If something goes wrong

- `unknown option …`: check the spelling; nothing ran.
- `R2 isn't enabled`: OWNER-GUIDE step A3, then run again. Nothing changed.
- `STOP … DB is bound to database …`: an earlier restore or a hand-made binding. Read [ROLLBACK.md](ROLLBACK.md) section 3 before using `--allow-rebind`.
- `lost <NAME>` / `missing <NAME>`: re-add from the newest backup file ([ROLLBACK.md](ROLLBACK.md) section 3).
- `failed: 10000: Authentication error`: the token lacks a permission listed above.
- `the API token can't read Workers`: add Workers Scripts: Edit to the token.
- `email.from: an address on feelingsbeautycare.in`: the sender must be on the apex domain (the one onboarded in Email Sending).
- Sign-in emails don't arrive after setup: the domain isn't onboarded in Email Service → Email Sending on this account, or the account isn't on Workers Paid (OWNER-GUIDE A3b). The mailer Worker's logs show the code.
- `go-live: not yet`: the listed items in the admin, then run again.
- Anything else: docs/ops/RUNBOOK.md.

## Not done by the script (dashboard only)

The deploy hook (Settings → Builds → Deploy hooks), enabling R2, the Workers Paid plan and onboarding `feelingsbeautycare.in` in Email Sending, the Email Routing rule for replies to the sender, the Razorpay keys and webhooks, the redeploy after a change (Deployments → Retry deployment), and the first admin sign-in. OWNER-GUIDE.md walks through each.
