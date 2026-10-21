# Course admin (demo): how to build a screen

The admin at `/admin/*` is a **demo**: no backend, no real sign-in. Data lives in the browser
(`localStorage`, every access in try/catch) and is always labelled as demo data. Read the repo's
`CLAUDE.md` rules first (tokens only, one accent, 44px targets, no inline handlers, phone first).

## Routes

| Route | File | Owner |
|---|---|---|
| `/admin` (demo sign-in) | `src/pages/admin/index.astro` | admin |
| `/admin/dashboard` | `src/pages/admin/dashboard.astro` | admin |
| `/admin/courses`, `/admin/courses/edit?id=…` | `src/pages/admin/courses.astro`, `courses/edit.astro` | admin |
| `/admin/students`, `/admin/payments` | `students.astro`, `payments.astro` + `src/components/admin/students/*`, `payments/*` | helper A |
| `/admin/coupons`, `/admin/settings` | `coupons.astro`, `settings.astro` + `src/components/admin/coupons/*`, `settings/*` | helper B |

Don't edit files you don't own. New store functions go in **new** files
(`src/lib/demo-store-students.ts`, `src/lib/demo-store-coupons.ts`, …) that import from
`src/lib/demo-store.ts`.

## Page pattern

```astro
---
import Admin from "../../layouts/Admin.astro";
import Icon from "../../components/Icon.astro";
---

<Admin title="Students" active="students" icons={["magnifying-glass", "download-simple"]}>
  <header class="page-head">
    <div>
      <h1 class="page-title">Students</h1>
      <p class="page-sub">One line about the screen.</p>
      <p class="demo-note"><Icon name="info" /> Example students (demo data).</p>
    </div>
    <div class="page-actions">
      <button class="btn btn-secondary" type="button" data-export><Icon name="download-simple" /> Export CSV</button>
    </div>
  </header>

  <section class="card"> … server-rendered skeleton, filled by the script … </section>
</Admin>

<script>
  import "../../components/admin/students/students";
</script>

<style is:global>
  /* page styles, every selector prefixed with the page's own class (e.g. .stu-…) */
</style>
```

- **Layout props** (`src/layouts/Admin.astro`):
  - `title` (string, required): the tab title becomes "`title` · Course admin (demo) · Feelings Beauty Care".
  - `active`: `"dashboard" | "courses" | "students" | "payments" | "coupons" | "settings"`, highlights the nav item.
  - `icons`: extra Phosphor icon names your **script** needs (see `icon()` below). Markup in the
    `.astro` file uses `<Icon name="…" />` directly.
  - `noTabbar`: hides the phone tab bar (only for a screen with its own bottom action bar).
  - `bare`: no shell and no sign-in check (only the sign-in page uses it).
- The layout already gives you: the sign-in check, the top bar with the **Demo data** badge, the
  sidebar (from 1024px) and the bottom tab bar (below), a toast region, `noindex`.
- **Scripts:** one `<script>` per page that imports a TS module from your folder. Astro bundles it
  (an external file, so it adds nothing to the CSP). Never `onclick=""` or `javascript:` URLs:
  the build fails. Don't measure layout at script start (use ResizeObserver/IntersectionObserver).
- **Styles:** markup your script builds doesn't get Astro's scoped styles, so use
  `<style is:global>` with selectors prefixed by your screen (`.stu-row`, `.pay-…`, `.cpn-…`,
  `.set-…`). Colours only from `src/styles/tokens.css` variables.
- Icons: copy any missing Phosphor icon (regular weight, unchanged file) into `src/icons/`. The
  main site's `node_modules/@phosphor-icons/core/assets/regular/` has them all.

## The store: `src/lib/demo-store.ts`

Types: `Course`, `Module`, `Lesson`, `Cover`, `Coupon`, `Student`, `Payment`, `PaymentMethod`
(`"UPI" | "Card"`), `PaymentStatus` (`"paid" | "failed"`), `Day`, `Activity`, `SaveResult`.

Saved (localStorage key `fbc-admin-demo-v1`, seeded on first read):
- `getCourses()`, `getCourse(id)`, `getPublishedCourses()`, `saveCourse(course)`, `deleteCourse(id)`,
  `blankCourse()`, `newCourseId(title)`, `lessonTotal(course)`, `minuteTotal(course)`.
- `getCoupons()`, `saveCoupon(coupon)`, `deleteCoupon(id)`. Seed: `INSTA10`, `REEL15`, `BRIDE20` (off),
  `LAUNCH500` (₹500 off, ended) and `REEL3` (₹300 off, main course only). A coupon's optional
  `kind` (`"percent"` default, or `"flat"`), `amount` (₹ off) and `courseId` (null = every course)
  are read through `withDefaults()`; show a discount with `discountLabel()` and a price with
  `priceWith()` from `src/lib/demo-store-coupons.ts`, never `${percent}% off` by hand.
- `resetDemo()`: back to the seed (Settings uses it).
- `storageIsBlocked()`: true in a private window or with storage blocked.
- Every `save…` returns a `SaveResult` (`{ ok: true }` or `{ ok: false, reason: "quota" | "blocked" }`):
  pass it to `reportSave(result, "Saved.")` from `ui.ts`.

Example activity (never saved; generated per date with a fixed seed, so the same day always shows
the same numbers and the history always ends today):
- `getActivity()` → `{ days: Day[], payments: Payment[], students: Student[] }`, 70 days back,
  newest first for payments and students. Every paid payment has a student
  (`student.paymentId === payment.id`); failed payments have `studentId: null`.
- `couponUses(code)`, `studentCounts()` (Map course id → students).
- Constants: `MAIN_COURSE_ID`, `MAIN_PRICE`, `LEVELS`, `LANGUAGES`.
- Session: `isSignedIn()`, `signIn()`, `signOut()`.

To add **your own seed data**, put it in your new store file (e.g. `demo-store-students.ts`), derived
from `getActivity()` where you can, so the numbers agree with the dashboard. Keep anything you
persist under your own localStorage key prefixed `fbc-admin-demo-`, and wrap every read and write
in try/catch. Settings' "Reset demo data" clears every key with that prefix (it keeps the sign-in).

Browser storage keys in use:

| Key | Where | What |
|---|---|---|
| `fbc-admin-demo-v1` (localStorage) | `src/lib/demo-store.ts` | Courses and coupons |
| `fbc-admin-demo-coupons-v1` (localStorage) | `src/lib/demo-store-coupons.ts` | Flag: the extra example codes were added |
| `fbc-admin-demo-settings-v1` (localStorage) | `src/components/admin/settings/prefs.ts` | Notification choices on the Settings screen |
| `fbc-admin-demo-session` (sessionStorage) | `src/lib/demo-store.ts`, `src/layouts/Admin.astro` | The demo sign-in flag |

## Shared client helpers (`src/components/admin/client/`)

- `dom.ts`: `h(tag, props, ...children)` builds elements (text via `textContent`; `on…` props
  become listeners), `s()` for SVG, `icon(name, className?)` clones an icon from the page's sprite
  (list the name in the layout's `icons` prop), `$`, `$$`, `fill(el, ...children)`, `ready(fn)`,
  `reducedMotion()`.
- `ui.ts`: `toast(message, "success" | "info" | "error")`, `demoNote("Refunds")` → "Refunds is
  available in the real version…", `reportSave(result, successMessage?)`,
  `confirmDialog({ title, body, confirm, danger? })` → `Promise<boolean>` (native `<dialog>`).
- `format.ts`: `inr(2999)` → "₹2,999", `inrShort`, `num`, `plural(n, "lesson")`, `duration(min)`,
  `maskPhone("9812341234")` → "98xxxx1234", `dayMonth`, `fullDate`, `longDate`, `time`, `ago`,
  `initials(name)`, `change(now, before)`.
- `covers.ts`: `coverImage(cover, title)` → `{ src, alt }` (needs `<CoverData />` on the page).

## Shared classes (`src/components/admin/admin.css`)

- Page: `.page-head`, `.page-title`, `.page-sub`, `.page-actions`, `.demo-note`, `.back-link`, `.notice`.
- Cards: `.card`, `.card-pad`, `.card-head` (+ `.no-rule`), `.card-title`, `.card-sub`, `.stack`.
- Buttons: global `.btn` + `.btn-primary` (the one red action per screen), `.btn-secondary`,
  `.btn-ghost`, `.btn-danger`; `.icon-btn` (44px round, needs `aria-label`), `.link-btn`.
- Forms: `.field`, `.field-label` (`.opt` for "optional"), `.field-hint`, `.field-error`
  (with `aria-describedby` + `aria-invalid` on the input), `.input`, `.select`, `.textarea`,
  `.input-affix` + `.affix`, `.form-grid` (+ `.cols-2`, `.cols-3`, `.span-all`),
  `.switch` (`<label class="switch"><input type="checkbox" role="switch"><span class="switch-track"></span></label>`),
  `.error-summary`.
- Lists: `.rows` (`li + li` hairlines), `.rows-head`, `.cell-label`, `.meter` (`style="--p: 40%"`,
  `.is-done`), `.pill` (`.pill-live` for live/on, plain for draft/off), `.empty`.
- Filters: `.toolbar`, `.search` (icon + `.input`), `.segmented` (buttons with `aria-pressed`).
- Overlays: `.dlg` (+ `.dlg-body`, `.dlg-title`, `.dlg-actions`) and `.drawer` (+ `.drawer-head`,
  `.drawer-body`): use `<dialog>` + `showModal()`; a bottom sheet on phones, a side panel from 768px.
- `.avatar` (`.avatar-soft`), `.num`/`.tnum` for aligned figures, global `.visually-hidden`.
