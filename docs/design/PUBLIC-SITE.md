# Public site: design notes

What a visitor sees before buying: the hub's catalog, a course's landing page (on `/c/<slug>` and on
its own subdomain), the empty hub and the 404. Same brand system as the learner pages
(`LEARNER-UX.md`): white and blush, warm ink, one sindoor red per view for the main action, one
maroon band per page, the bindi, Plus Jakarta Sans, Phosphor icons. English only.

Every fact on these pages comes from the build's snapshot (`src/data/snapshot.ts`, worded by
`src/lib/course-view.ts`) or the business facts in `src/data/site.ts`. Nothing is invented: no
testimonials, counts or ratings beyond what `site.ts` holds (the studio's Google rating with its
month, the year it opened, the 2019 award wording still marked CONFIRM there).

## The hub (`/`)

| Courses published | What `/` shows |
|---|---|
| none | "New courses are on their way", WhatsApp (red) and Instagram, then the teacher band |
| one | that course's landing page (the Instagram `/ig` and `/reel` links land here) |
| two or more | the catalog below |

**Catalog.** A hero with who teaches (Urmi's face and the confirmed Google rating) and, from 56rem,
her cut-out portrait on a blush card; then one card per course (`CourseCard.astro`), the teacher
band ("Meet Urmi") and a blush "Not sure which one?" band with WhatsApp and the phone number.

A card's picture, best first: the admin's cover image, the local cover of the course's first
glimpse, Urmi's cut-out on blush (her courses), else a blush tile with the format's icon. The chip
names the format (Online, At the studio, Studio + online). Studio courses show their next open batch
and its seats; 5 or fewer seats take the accent (a real count, never a countdown).

## A course page

Sections in order: hero, glimpses, what you'll learn and the lessons, batch dates, teacher, who
it's for and how it works, the price card, questions, the closing band, the footer. Sections with
nothing to say are left out (no batches on a recorded course, no teacher band for another teacher).

- **Hero.** The title, the key numbers, the red button. Studio courses add the next batch under the
  button (dates, schedule, seats). The picture is the first glimpse as a reel; without one, the
  admin's cover, else Urmi's cut-out on blush with the next batch pinned to it as a calendar ticket.
- **Lessons.** Native `<details>` per module (keyboard and screen readers for free; the first is
  open). A lesson marked as a free preview in the admin carries a "Free preview" tag.
- **Batch dates.** One ticket per open batch: a calendar leaf (month, day, weekday), the dates,
  the schedule, its price and seats, and "Book this batch", which opens the checkout with that batch
  already chosen. A full batch stays listed (dashed, "Full") with "Ask about the next one".
- **Price card.** The ticket-style card with what's included, the red button, Razorpay's line and
  the three after-payment lines (receipt on screen, 2 devices, 24-hour refund).
- **Questions.** The course's FAQs, and beside the heading "Something else? Ask Urmi on WhatsApp".
- **Phone enroll bar.** Slides up once the hero's button has scrolled away and steps aside while
  another red button is on screen. Recorded courses say lessons and access; studio courses say the
  next batch's day and "Book a seat".

## Header and footer

One family with the main site (`harshbhx/feelings-beauty-care`, `Header.astro` and `Footer.astro`):
the maroon logo, a white bar with a hairline, quiet pill links with a bindi under the current one,
the "Menu" pill, and a maroon footer with small column titles.

- **Header** (`src/components/landing/Header.astro`, every public page and the payment result
  pages). Logo with a "Courses" tag; All courses (the hub, absolute, because on a course's own
  subdomain `/` is that course), My courses (`/account`, which signs in first), Contact
  (`/legal#contact`) and the main site; "Ask Urmi" on WhatsApp, never red (the one red button on a
  course page is Enroll). Sticky: once the page scrolls it tucks 0.5rem above the top edge and the
  logo settles by transform, so its height never changes and nothing below it moves. Below 64rem
  the links live in a full-height menu: focus moves in and stays in the header, Escape closes it
  and returns focus to the button, the page behind is inert, every target is 44px or more, and
  with reduced motion it opens without animation.
- **Footer** (`src/components/landing/Footer.astro`). `full`: brand block (Instagram, YouTube,
  WhatsApp), Courses (All courses, My courses, Sign in, Check a certificate), The studio
  (feelingsbeautycare.in, the makeup academy, Contact us), Visit (address, directions, hours,
  phone), then copyright, the four policies and Back to top. `compact` (payment results, the
  course area): one brand row, the main links and the same legal row. Hours and the map pin are
  copied from the main site's `site.ts` (CONFIRM there).
- **Course area** (`LearnHeader.astro`, `LearnFooter.astro`) and the **student pages** Functions
  render (`functions/_lib/pages/html.ts`, `public/app/app.css`) use the same logo, tag, pill links
  and maroon footer; the logo is `public/app/logo.webp` drawn as a mask (no inline style, CSP).
- **Admin** keeps its own compact bar and sidebar.

`.github/workflows/screenshots.yml`, job `header-footer` (`tests/ux/header-footer.mjs`), checks all
of this in a browser at 390, 768 and 1280px and makes contact sheets
(`gh run download <run id> -n header-footer`).

## Link previews

Each course gets `/og/<slug>.jpg` (1200x630), made at build time by `src/pages/og/[slug].jpg.js`
with sharp: the logo in white on maroon with a short red rule, beside the course's own photo (its
first glimpse's cover, or Urmi on blush). No words in the picture: WhatsApp and Instagram print the
page's title under it, and drawn text would depend on the build machine's fonts. A share image set
in the admin (`ogImageUrl`) wins. The hub and legal pages keep `public/og.jpg`.

## Motion

Small, opacity and transform only. The hero's words rise in, sections reveal on scroll, cards lift
2px on hover with a slow zoom on their picture, the hero's batch ticket slides up once. With reduced
motion every reveal is a short fade or nothing, and nothing moves on hover.

## Screenshots

`.github/workflows/screenshots.yml`, job `public-pages` (runs on pull requests that touch `src/`,
`public/` or `tests/ux/`, and on demand). It builds the site twice from test snapshots
(`tests/ux/public-fixture.mjs`: `showcase` has one course per format, `empty` none), serves `dist`
the way Pages does and runs `tests/ux/public-screenshots.mjs`:

- every page full length at 390px and 1280px, plus the phone states (enroll bar, opened FAQ and
  module, checkout sheet);
- fails on sideways scroll at 390px, a skip link that doesn't show on the first Tab, an image that
  doesn't load or has no box, a script error, and axe-core's serious or critical findings (all
  findings are listed in `a11y-*.txt`);
- `tests/ux/contact-sheets.mjs` makes JPEG contact sheets under 1.5 MB, and the course share images
  are copied next to them.

```
gh run download <run id> -n public-pages
```

The fixture's titles, prices, dates and seats are test data only; they never reach a real build.
