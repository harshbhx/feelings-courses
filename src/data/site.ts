/**
 * Business facts, copied from the main site (feelings-beauty-care/src/data/site.ts, 2026-10-20).
 * Keep them in sync by hand: if the main site's facts change, change them here too.
 * Anything marked CONFIRM is not yet verified with the client.
 */

export const site = {
  name: "Feelings Beauty Care",
  founder: "Urmi Mengar", // CONFIRM spelling (old docs also say "Manger")
  foundedYear: 2009,
  mainUrl: "https://feelingsbeautycare.in",
  academyUrl: "https://feelingsbeautycare.in/makeup-academy-jamnagar",
  url: "https://courses.feelingsbeautycare.in",

  phone: { display: "+91 80006 61578", tel: "+918000661578" },
  whatsappNumber: "918000661578",

  address: {
    street: "Om Residency, Hirji Mistry Road",
    landmark: "Near J J Tower",
    city: "Jamnagar",
    region: "Gujarat",
    postalCode: "361006",
    country: "IN",
  },

  social: {
    instagram: "https://www.instagram.com/feelingsbeautycare/",
    youtube: "https://www.youtube.com/@feelingsbeautycare",
  },

  reviewsUrl: "https://www.google.com/maps?cid=17942140304950606128",
  // Confirmed by the owner for the salon's Google profile. Show it with its month. Never in schema.
  googleRating: { rating: 4.8, count: 956, asOf: "2026-10-19" },

  // CONFIRM exact wording with Urmi.
  award: { year: 2019, text: "Recognised by Madhuri Dixit for excellence in beauty artistry" },
} as const;

export const yearsTeaching = new Date().getFullYear() - site.foundedYear;
