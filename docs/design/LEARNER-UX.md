# Learner experience: design notes

What a student sees from the price card to the certificate, and how to review it. The look is the
main site's brand system (`harshbhx/feelings-beauty-care`, `docs/03-design-system.md`): white and
blush surfaces, warm ink, one sindoor red for the primary action, one maroon band per page, the
bindi, Plus Jakarta Sans, Phosphor icons. English only.

## Where each page lives

| Page | Rendered by | Look |
|---|---|---|
| Course landing (`/`, `/c/<slug>`, a course's own subdomain) | Astro, static (`src/components/landing/*`) | `src/styles/*.css` |
| Checkout sheet | Astro + one script (`src/components/checkout/Checkout.astro`) | in the component |
| Sign-in, one-time link, sign-out | Functions (`functions/_lib/pages/auth.ts`) | `public/app/app.css` |
| My courses (`/account`) | Functions (`pages/account.ts`) | `public/app/app.css` |
| Course home, lesson player, certificate request (`/learn/...`) | Functions (`pages/learn.ts`) + `public/app/learn.js` | `public/app/app.css` |
| Certificate and its check (`/verify`) | Functions (`pages/verify.ts`) | `public/app/app.css` |
| Receipt (`/receipt/<id>?k=...`) | Functions (`functions/_lib/receipts.ts`) | `public/app/app.css` |

The Functions pages are personal, so they're rendered live from D1. Their CSP allows only
same-origin files (no inline style or script, not even a `style=""` attribute), so `app.css` holds
their whole look and `/app/fonts/` carries the brand font. The receipt is the one exception: its
print button is a single inline script, allowed by hash.

## The pieces

**Course landing (in-person, recorded, both).** The sections are worded per format by
`src/lib/course-view.ts`. The price card now ends with three after-payment lines: the receipt shows
on screen, recorded lessons play on up to 2 devices, and the 24-hour refund (linked to `/refunds`).
All three come from `src/shared/constants.ts`, so they follow the owner's decisions.

**Checkout.** Unchanged in behaviour: two steps with a step counter, a test-mode badge, the terms,
refund and privacy checkbox, a "working" step with a progress bar, and a calm "problem" step with
retry and WhatsApp.

**Receipt.** The thank-you and the next step come first: "Your course is ready" with Start learning
(or "See you at the studio" with the batch date for a studio-only booking), then the receipt itself
(receipt number, name, payment ID, amounts, the refund window while it's open; no phone or email since email identity), then Share
on WhatsApp and Print. A booking amount is the bold total; the balance at the studio sits under it.
Never a GSTIN or tax line.

**My courses.** One card per course: the format, the access tag (until when, ended, removed,
completed), the batch with readable dates, a progress bar and Start, Continue or Open course.
Courses that can be opened come first. No course yet: an empty state with "See the courses" and a
WhatsApp line for "paid already?". Devices show as two slots, filled per signed-in device.

**Course home.** A maroon resume band: "Up next, Lesson 3 of 7", the lesson, its module, "Pick up at
3:12" when it was left part way, the progress bar and one button. Then the modules with done ticks,
"2 of 3 done, 26 min", and the next lesson marked `aria-current="step"`. Then the certificate card.

**Lesson player.** The video with a quiet loading mark behind it (no layout shift; `learn.js` adds
`.ready` on the first frame), edge to edge on phones. "Picking up where you left off, at 3:12"
when it resumes. "Mark as done and go on" (a plain form, so it works without JS); when the video ends,
`learn.js` marks it done and reveals Next lesson. Notes, then previous and next cards. Beside it from
1024px (below it on phones) the course outline, with the current lesson `aria-current="page"`.

**Device limit.** When a browser comes back with a session that has ended (signed out from another
device, or pushed out by the 2-device limit), `/signin` says so in plain words before the form.

**Certificates.** A printable certificate (A4 landscape through a named `@page`; receipts stay
portrait) with a seal, the name on a sindoor rule, the course, teacher, date and code, and a
"Verified" banner that doesn't print. `/verify` has a code form, and calm not-found and withdrawn
states.

**Empty, error and expired states.** One pattern (`messagePage()` in `pages/html.ts`): an icon in a
tinted circle, a heading, one line, one primary action and, where it helps, a WhatsApp action.
Access ended explains the one-year access and keeps progress; an expired sign-in link offers "Ask
for a new link".

## Accessibility and performance

- Text contrast 4.5:1 or more on every surface it sits on; `tests/ux/learner-pages.test.mjs`
  computes the ratios from `app.css` (the palette pairs) and fails below AA.
- One `h1` per page, a skip link, labelled fields, `role="alert"` for errors and `role="status"`
  for notices, icons hidden from screen readers unless they carry meaning, native `<progress>`.
- Focus ring on everything (2px sindoor, offset 3px). Targets 44px or more.
- Motion: opacity and transform only, short, and all of it off under `prefers-reduced-motion`.
- No framework on these pages: `app.css` (about 37 KB unminified, one request), `learn.js` (lesson pages only)
  and one 27 KB font file, preloaded.

## Reviewing and screenshots

The pages need D1, so they can't be opened from `astro dev`. Instead, render every state to static
HTML from the test world in `tests/ux/world.mjs` (no server, no browser, a second or two):

```sh
node --experimental-strip-types --no-warnings --import ./tests/helpers/register.mjs scripts/preview-student-pages.mjs
# then open preview/student/index.html
```

Screenshots at 390px and 1280px run in GitHub Actions (`.github/workflows/screenshots.yml`, on
demand and on pull requests touching these pages), never on the VM. The spec is
`tests/ux/screenshots.mjs`: it also fails on sideways scroll at 390px and on an invisible skip link.

```sh
gh workflow run screenshots.yml -R harshbhx/feelings-courses --ref <branch>
gh run watch -R harshbhx/feelings-courses
gh run download <run-id> -R harshbhx/feelings-courses -n student-pages
```

On a machine with a browser, the same spec runs locally after the preview step:
`npm i --no-save playwright@1.48.2 && npx playwright install chromium && node tests/ux/screenshots.mjs`.
