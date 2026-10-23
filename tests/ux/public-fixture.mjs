// Test snapshots for the public site's screenshots (.github/workflows/screenshots.yml). Writes
// src/generated/snapshot.json, the file src/data/snapshot.ts reads at build time, so `astro build`
// renders one of these instead of the seed:
//
//   node --experimental-strip-types --no-warnings --import ./tests/helpers/register.mjs tests/ux/public-fixture.mjs showcase
//   node ... tests/ux/public-fixture.mjs empty
//
// - showcase: three courses, one per format: the seed's recorded course, a studio course with
//   batches (one nearly full, one full, one without a seat limit) and a studio-and-online course
//   on its own subdomain with a booking amount. The hub then shows its catalog.
// - empty: no published course (the hub's "nothing yet" state).
//
// TEST DATA ONLY. Nothing here is a fact about the business: titles, prices, dates and seats are
// made up to exercise every layout. It never reaches a real build: CI's other jobs use the seed,
// and Cloudflare Pages uses the live snapshot. The demo flag stays on, so every page carries the
// demo ribbon in the pictures too.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { seedSnapshot } from "../../src/data/seed-snapshot.ts";

const root = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(root, "src", "generated", "snapshot.json");
const HUB = "https://courses.feelingsbeautycare.in";

/** A calendar day `days` from today, "YYYY-MM-DD", so batch dates stay in the future. */
function dayFromNow(days) {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

let nextLesson = 1000;
const lesson = (title, minutes = 0) => ({
  id: ++nextLesson,
  slug: `l-${nextLesson}`,
  title,
  minutes,
  freePreview: false,
  vertical: false,
  hasVideo: false,
});

export function showcase() {
  const snap = seedSnapshot();
  const recorded = snap.courses[0];
  const glimpses = recorded.details.glimpses;

  const studio = {
    ...recorded,
    id: 2,
    slug: "studio-basics",
    title: "Makeup Basics at the Studio",
    subtitle: "Hands-on classes at the studio in small batches, with a kit list and practice on models.",
    description: null,
    format: "in_person",
    pricePaise: 1500000,
    compareAtPaise: null,
    depositPaise: null,
    level: "Beginner",
    language: "Hindi and Gujarati",
    durationText: "4 weeks",
    accessDays: null,
    certificateTitle: "Certificate from Feelings Beauty Care",
    details: {
      outcomes: ["Skin prep and base for every skin tone", "Day and party eye looks", "Hair and saree draping basics"],
      forWho: ["Beginners who learn best with a teacher beside them", "Women starting out as freelance makeup artists"],
      faqs: [
        { q: "Where are the classes?", a: "At the studio in Jamnagar. The address is at the bottom of this page." },
        { q: "Do I bring my own kit?", a: "A kit list comes when you book. You can bring what you already have." },
      ],
      glimpses: [],
      highlights: [],
    },
    canonicalUrl: `${HUB}/c/studio-basics`,
    domainActive: false,
    modules: [
      { id: 21, position: 1, title: "Week 1: Skin and base", lessons: [lesson("Skin types and prep"), lesson("Foundation and concealer")] },
      { id: 22, position: 2, title: "Week 2: Eyes", lessons: [lesson("Brushes and blending"), lesson("Liner and lashes")] },
      { id: 23, position: 3, title: "Week 3: Looks", lessons: [lesson("Day look"), lesson("Party look")] },
      { id: 24, position: 4, title: "Week 4: Hair and draping", lessons: [lesson("Buns and curls"), lesson("Saree draping")] },
    ],
    batches: [
      { id: 201, title: "Morning batch", startsOn: dayFromNow(12), endsOn: dayFromNow(40), scheduleText: "Mon to Fri, 10 am to 1 pm", pricePaise: null, seatsLeft: 3 },
      { id: 202, title: "Evening batch", startsOn: dayFromNow(19), endsOn: dayFromNow(47), scheduleText: "Mon to Fri, 5 pm to 8 pm", pricePaise: null, seatsLeft: 0 },
      { id: 203, title: "Weekend batch", startsOn: dayFromNow(33), endsOn: dayFromNow(89), scheduleText: "Sat and Sun, 11 am to 4 pm", pricePaise: 1800000, seatsLeft: null },
    ],
  };

  const both = {
    ...recorded,
    id: 3,
    slug: "bridal",
    title: "Bridal Makeup Course",
    subtitle: "Recorded lessons to start at home, then a batch at the studio to practise bridal looks.",
    format: "hybrid",
    pricePaise: 3500000,
    compareAtPaise: null,
    depositPaise: 500000,
    level: "Intermediate",
    durationText: "6 weeks",
    accessDays: 365,
    details: {
      ...recorded.details,
      outcomes: ["Long-wear bridal base", "Traditional and modern bridal eyes", "Dupatta and jewellery setting"],
      glimpses: [glimpses[3], glimpses[4], glimpses[1]].filter(Boolean),
    },
    canonicalUrl: "https://bridal.feelingsbeautycare.in/",
    domainActive: true,
    modules: [
      { id: 31, position: 1, title: "Bridal base", lessons: [lesson("Prep for a long day", 12), lesson("Base that lasts", 14)] },
      { id: 32, position: 2, title: "Bridal eyes", lessons: [lesson("Traditional eyes", 16), lesson("Modern soft glam", 13)] },
      { id: 33, position: 3, title: "Finishing", lessons: [lesson("Dupatta setting", 9), lesson("Touch-up kit", 7)] },
    ],
    batches: [
      { id: 301, title: "Bridal batch", startsOn: dayFromNow(26), endsOn: dayFromNow(68), scheduleText: "Tue and Thu, 2 pm to 6 pm", pricePaise: null, seatsLeft: 5 },
    ],
  };

  return { ...snap, courses: [recorded, studio, both] };
}

export function empty() {
  return { ...seedSnapshot(), courses: [] };
}

const VARIANTS = { showcase, empty };

if (import.meta.url === `file://${process.argv[1]}`) {
  const name = process.argv[2] ?? "showcase";
  const make = VARIANTS[name];
  if (!make) {
    console.error(`public-fixture: unknown variant "${name}" (${Object.keys(VARIANTS).join(", ")})`);
    process.exit(1);
  }
  mkdirSync(path.dirname(OUT), { recursive: true });
  // "url": the same shape scripts/snapshot.mjs writes for an explicit SNAPSHOT_URL.
  writeFileSync(OUT, JSON.stringify({ source: "url", snapshot: make() }) + "\n");
  console.log(`public-fixture: ${name} (${make().courses.length} course(s)) -> ${path.relative(root, OUT)}`);
}
