/**
 * The course: every word, number and lesson the pages show comes from here.
 *
 * DEMO CONTENT. Feelings Beauty Care has not confirmed the price, modules, lessons, duration or
 * certificate yet. Until they do, `demo` stays true: the site shows a visible "demo" ribbon, stays
 * noindexed, and checkout runs in test mode only. When the client confirms a value, replace it
 * here and remove it from `toConfirm`.
 */

export const course = {
  demo: true,
  toConfirm: ["title", "price", "modules and lessons", "duration", "certificate", "access period", "promo video"],

  slug: "self-makeup-masterclass",
  title: "Self Makeup Masterclass",
  subtitle: "Learn the makeup Urmi does for brides, on your own face, in short video lessons.",
  teacher: "Urmi Mengar", // CONFIRM spelling, same as site.founder
  language: "Hindi and Gujarati, with English terms", // CONFIRM
  level: "Beginner to confident",

  // Razorpay works in paise. Example price only.
  price: { amount: 299900, compareAt: null as number | null, currency: "INR", display: "₹2,999" },
  access: "12 months", // CONFIRM
  certificate: "Certificate of completion from Feelings Beauty Care", // CONFIRM

  outcomes: [
    "Prep skin so makeup lasts through a long function",
    "Match foundation and concealer to Indian skin tones",
    "Do a soft glam and a party look in under 30 minutes",
    "Blend eyeshadow, line eyes and fix lashes cleanly",
    "Choose products that suit your budget",
  ],

  modules: [
    {
      title: "Skin prep and base",
      lessons: [
        { title: "Know your skin type", minutes: 6 },
        { title: "Prep and priming for long wear", minutes: 9 },
        { title: "Foundation shade matching", minutes: 11 },
      ],
    },
    {
      title: "Eyes",
      lessons: [
        { title: "Brushes and blending basics", minutes: 8 },
        { title: "Everyday eyes in 5 minutes", minutes: 7 },
        { title: "Party eyes with shimmer", minutes: 12 },
      ],
    },
    {
      title: "Complete looks",
      lessons: [
        { title: "Soft glam for day functions", minutes: 14 },
        { title: "Evening party look", minutes: 15 },
        { title: "Touch-ups that last the night", minutes: 6 },
      ],
    },
  ],

  forWho: [
    "Brides-to-be who want to do their own pre-wedding function looks",
    "Women who want everyday makeup that looks like them",
    "Beginners thinking about makeup as a career, before a full academy course",
  ],

  // Short vertical clips for the hero and the "glimpses" strip. Until the course's own promo
  // clips arrive, these are the studio's real YouTube Shorts (ids from the main site's videos.ts).
  glimpses: [
    { id: "X6w8f8d0ON4", label: "Certification day at the academy" },
    { id: "vFGCoQrwch4", label: "Student’s work at the academy" },
    { id: "AIXl9I2_X_w", label: "Dewy makeup look" },
    { id: "nXRVnVS0ack", label: "Royal bridal makeup look" },
    { id: "YGNvPE4qvJM", label: "Reception night glam" },
  ],

  faqs: [
    { q: "Do I need any makeup experience?", a: "No. The course starts from skin prep and builds up one step at a time." },
    { q: "Which products do I need?", a: "A short starter list comes with the first lesson. You can use what you already have." },
    { q: "How long can I watch the lessons?", a: "You get access for the period shown on this page, on phone or laptop." },
    { q: "Is there a certificate?", a: "Yes, after you finish the lessons." },
    { q: "Can I ask Urmi questions?", a: "Yes, on WhatsApp. The button is at the bottom of this page." },
  ],
} as const;

export const lessonCount = course.modules.reduce((n, m) => n + m.lessons.length, 0);
export const totalMinutes = course.modules.reduce((n, m) => n + m.lessons.reduce((s, l) => s + l.minutes, 0), 0);
