# Course admin (W6): how it is built

The admin at `/admin/*` runs on the real admin API (W5, `docs/admin-api.md`) and W4's uploads
(`docs/platform/MEDIA.md`). Pages are static shells; every screen loads its data in the browser with the
HttpOnly admin cookie. Read the repo's `CLAUDE.md` rules first (tokens only, one accent, 44px targets,
no inline handlers, phone first).

## Routes

| Route | Page | Script |
|---|---|---|
| `/admin` (sign-in) | `src/pages/admin/index.astro` | `client/signin.ts` |
| `/admin/dashboard` | `dashboard.astro` | `client/dashboard.ts` |
| `/admin/courses` | `courses.astro` | `client/courses.ts` |
| `/admin/courses/edit?id=…` | `courses/edit.astro` | `editor/editor.ts` (+ `outline.ts`, `batches.ts`, `lists.ts`, `uploads.ts`) |
| `/admin/students` (`?q=&course=&page=&open=`) | `students.astro` | `client/students.ts` |
| `/admin/payments` (`?status=&course=&from=&to=&page=&open=`) | `payments.astro` | `client/payments.ts` |
| `/admin/coupons` | `coupons.astro` | `client/coupons.ts` |
| `/admin/settings` (business, payments, legal, site, backups, addresses, password) | `settings.astro` | `client/settings.ts` |
| `/admin/activity` (`?entity=`) | `activity.astro` | `client/activity.ts` |

## Layers

- `lib/` — pure logic, no DOM, tested in Node (`tests/w6/`): money in paise, India-time dates, slugs and
  YouTube links, the course form and publish checklist, the outline model, batches, coupons, refunds
  (24-hour window), students, stats, publish wording, uploads, the activity log, the Cloudflare steps,
  error wording and the safe sign-in redirect. Put new rules here first, with a test.
- `client/` — browser helpers and screens:
  - `api.ts`: `admin(key, params, body)` wraps `call()` from `src/lib/api-client.ts`. A 401 `unauthorized`
    goes to `/admin?next=<this page>`. `adminMe()` is the page's one `GET /api/admin/me` (the shell and
    the screens share it); `siteHosts()` / `hostsReady()` give the hub host and course domain it
    returned, for every course address (`courseAddresses(slug, siteHosts())`). `download(path)` saves an
    attachment the API serves (the newest backup).
  - `states.ts`: `loadInto(region, load, render)` shows placeholders, then the data, or an error with
    "Try again"; `emptyBox()` for empty lists. Use them for every load.
  - `fields.ts`: `field()`, `input()`, `select()`, `switchRow()`, and `setErrors(root, errors)`, which puts
    API errors (`fields` from a 400) on the controls marked `data-field="<api name>"`.
  - `ui.ts`: `toast()`, `confirmDialog()`, `formDialog()` (a dialog or drawer with a busy submit),
    `busy(button, fn)`, `copyText()`, `announce()`.
  - `events.ts`: `notifyChanged()` after a save that changes the public site; the shell's
    "Publish changes" chip checks again.
  - `shell.ts` (every page): session check, payment-mode badge, publish chip, sign out.
- `editor/Field.astro` — one labelled field with hint, counter and error slot (id = `fieldId(name)`).

## Rules the screens follow

- Text goes in with `textContent` (`h()` in `client/dom.ts`), never `innerHTML`: names, codes and titles
  are typed by people. `tests/w6/static.test.mjs` checks this.
- Money is paise everywhere; `lib/money.ts` parses and formats rupees. Dates are India time
  (`lib/time.ts`), whatever the device's zone.
- Edits send only the fields that changed (`changedFields`, `couponChanges`).
- Anything that can't be undone asks first (`confirmDialog`, typed confirmation for erase).
- **No GSTIN outside the settings form** (owner decision); a test enforces it.
- Refunds, sync and replay (W2) and sign-in links and certificates (W3) are live on the integration
  branch. A 501 (only from a deployment older than this admin) shows "Not switched on yet".
- Course addresses use the hosts from `GET /api/admin/me`, never typed-in domains, so the admin shows
  what the router serves (production's hosts until the answer arrives).
- Rules the server checks again come from `src/shared/constants.ts`, not copies: phone numbers
  (`normalizePhone`), the GSTIN format, and the upload types and sizes (W4's table).

## Uploads

`editor/uploads.ts` runs W4's `uploadMedia()` (`src/lib/media-upload.ts`) per destination: a lesson's video or captions, the cover, the sharing image.
Progress, pause/resume and cancel show wherever `data-upload-slot="<id>"` is on the page, so a lesson
row keeps showing progress after its drawer closes. Choosing the same file again resumes.

## Browser storage

Only W4's upload resume state (`fbc-upload:*` in localStorage). The admin keeps no data in the browser.
