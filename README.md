# Feelings Courses

The makeup course of Feelings Beauty Care, on courses.feelingsbeautycare.in. It has three parts:
- a landing page for people arriving from Instagram;
- a Razorpay checkout, in test mode for now;
- a gated course area where buyers watch the lessons.

**Status: demo.** The price and lessons are examples until the client confirms them. Read `CLAUDE.md` first.

```bash
npm install
npm run dev     # http://localhost:4321
npm run build   # astro check + build + CSP hashes (what Cloudflare runs)
node scripts/test-learn.mjs   # course-area gate tests (Node 22, no packages)
```

## Course area

- `/learn` is the dashboard and `/learn/<slug>` one page per lesson. Titles and minutes come from `src/data/course.ts`; slugs and lesson video ids are in `src/data/lessons.ts`.
- **Gate:** every request for `/learn`, `/learn/*`, `/learn.html` and `/learn/*.html` must pass `verifyEnrollment()` (`functions/_lib/enrollment.ts`). Otherwise it gets a 302 to `/?locked=1#pricing`. Gated pages are sent with `Cache-Control: private, no-store`. The files are `functions/learn/_middleware.ts`, `functions/learn.ts`, `functions/learn.html.ts` and the shared `functions/learn/_gate.ts`. `/learn/logout` clears the enrollment cookie and goes home.
- **Progress** is saved in the buyer's browser only (localStorage `fbc-progress`).
- **Lesson videos:** none exist yet. Each lesson plays a clearly labelled studio clip from `course.glimpses` instead. To add a real video, set its `videoId` in `src/data/lessons.ts`.

## Deploy

- **Cloudflare Pages project `feelings-courses`.** It is Git-integrated with GitHub `harshbhx/feelings-courses`, and the owner created it. Build command `npm run build`, output folder `dist`, Node 22. Pages picks up `functions/` by itself.
- **Branches:** `main` deploys to production. Every other branch gets a preview at `https://<branch>.feelings-courses.pages.dev`, for example `feat-learn.feelings-courses.pages.dev`.
- **Custom domain:** courses.feelingsbeautycare.in is attached in the Pages project under Custom domains. The feelingsbeautycare.in zone is on Cloudflare, so Cloudflare adds the DNS record itself when the owner activates the domain.
- **Secrets:** `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `ENROLL_SECRET`. The checkout part owns them. The owner sets them in the Pages project under Settings → Variables and Secrets. Values never go in the repo.
- **Headers and redirects:** `public/_headers`, plus the Content-Security-Policy that `scripts/csp.mjs` writes at build time. `public/_redirects` has the Instagram short links: `/ig` (bio) and `/reel`.
- **Never run `wrangler pages deploy`.** It makes a Direct Upload project, which can't be switched back to Git integration. Push to GitHub instead.
