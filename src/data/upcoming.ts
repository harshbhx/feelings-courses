/**
 * The coming-soon page (shown while `course.comingSoon` is true): the online courses on the way.
 *
 * Honest content only. Every topic below is something the academy teaches today or a topic already
 * in course.ts, so nothing here is a new claim:
 * - `academy` is copied from the main site (feelings-beauty-care/src/data/services.ts, the
 *   "makeup-academy-jamnagar" entry, 2026-11-04). Keep it in sync by hand.
 * - the topics' `covers` come from that entry's course lists and from `course.modules` and
 *   `course.outcomes`.
 * No prices, no launch dates, no counts, no countdowns. Which course opens first, and when, is not
 * decided: the page says so.
 */
import { course } from "./course";

export type Tone = "bridal" | "nails" | "mehndi" | "salon" | "academy";

export interface Topic {
  name: string;
  /** One line under the name. */
  line: string;
  /** A few things it covers, from the academy's course lists or course.ts. */
  covers: readonly string[];
  /** The service tone, for the small dot only (never a fill). */
  tone: Tone;
}

/** The academy's in-person courses, as the main site describes them (services.ts). */
export const academy = {
  courses: "a 3-month diploma, a 5-day crash course and a combo course with nail art and mehndi",
  batch: "small batches of 8 to 10 students",
} as const;

export const topics: readonly Topic[] = [
  {
    name: "Self makeup",
    line: "Your own makeup for functions, from skin prep to a finished look.",
    covers: course.modules.map((m) => m.title),
    tone: "academy",
  },
  {
    name: "Eye makeup",
    line: "Natural to dramatic: blending, liner and lashes.",
    covers: ["Brushes and blending basics", "Everyday eyes", "Party eyes with shimmer"],
    tone: "salon",
  },
  {
    name: "Bridal looks",
    line: "Traditional and modern bridal makeup, one step at a time.",
    covers: ["Traditional bridal looks", "Modern bridal looks", "Contouring and highlighting"],
    tone: "bridal",
  },
  {
    name: "Makeup artistry",
    line: "The ground the academy’s diploma covers, for a career in makeup.",
    covers: ["Skin types and colour theory", "Tools and brushes", "Airbrush basics"],
    tone: "academy",
  },
  {
    name: "Nail art",
    line: "The nail art module from the academy’s combo course.",
    covers: ["Nail art module"],
    tone: "nails",
  },
  {
    name: "Mehndi basics",
    line: "The mehndi module from the academy’s combo course.",
    covers: ["Mehndi basics module"],
    tone: "mehndi",
  },
];

/** "self makeup, eye makeup, bridal looks, makeup artistry, nail art and mehndi basics" */
export const topicList = (() => {
  const names = topics.map((t) => t.name.toLowerCase());
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
})();

/** Prefilled WhatsApp messages (sent through whatsappLink() in src/lib/whatsapp.ts). */
export const messages = {
  notify: "Hi Urmi, please tell me when the online makeup courses open.",
  topic: (name: string) => `Hi Urmi, please tell me when the online courses open. I’m most interested in: ${name}.`,
  suggest: "Hi Urmi, I’d love an online course on: ",
} as const;

export const soonFaqs = [
  {
    q: "When do the online courses open?",
    a: "The dates aren’t fixed yet. Tap “Notify me” and send the WhatsApp message, and we’ll tell you as soon as the first courses open.",
  },
  {
    q: "How much will they cost?",
    a: "Prices will be shared when the courses open. Nothing is on sale yet, so there is nothing to pay now.",
  },
  {
    q: "Which course comes first?",
    a: "That is still being decided. Tell us on WhatsApp which topic you want most: it helps Urmi choose.",
  },
  {
    q: "Can I learn in person in the meantime?",
    a: `Yes. The academy in Jamnagar runs ${academy.courses}, in ${academy.batch}. Ask on WhatsApp for the next batch.`,
  },
] as const;
