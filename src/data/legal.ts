/**
 * The legal pages (W7): terms, refunds, privacy and delivery, served at /legal/<page> on the hub
 * and at /<page> on every course host (functions/_lib/hosts.ts).
 *
 * Every number comes from the owner's decisions in src/shared/constants.ts (refund window, access
 * period, device limit) and every business fact from the snapshot's settings, so the pages can't
 * drift from what the platform enforces. tests/w7/legal.test.mjs checks that.
 *
 * Owner decisions honoured here: refunds within REFUND_WINDOW_HOURS of purchase; 12 months of
 * access; MAX_DEVICES_PER_STUDENT devices; the student's email is their account (sign-in links and
 * receipts by email, sent through Cloudflare; 23 Oct 2026), the phone number is optional;
 * NO GSTIN and no tax lines anywhere.
 *
 * Until the owner confirms the wording in the admin (settings.legal_confirmed), every page shows a
 * "draft" note. This is plain-language wording written for the owner to review, not legal advice.
 */
import {
  DEFAULT_ACCESS_DAYS,
  DEFAULT_HUB_HOST,
  DEFAULT_APEX_DOMAIN,
  LEGAL_PAGES,
  MAX_DEVICES_PER_STUDENT,
  REFUND_WINDOW_HOURS,
  type LegalPage,
} from "../shared/constants.ts";
import type { PublicSettings } from "../shared/types.ts";
import { formatAccess, plural } from "../lib/course-view.ts";
import { site } from "./site.ts";

/** Shown as "Last updated" on every page. Change it whenever the wording changes. */
export const LEGAL_UPDATED = "2026-10-23";
/** Days a backup copy is kept (functions/_lib/backup.ts BACKUP_KEEP). */
const BACKUP_DAYS = 35;
/** Payment and receipt records are kept for this many years (Indian accounting record rules). */
const RECORD_YEARS = 8;

export interface LegalSection {
  heading: string;
  /** Shown before the list. */
  paragraphs?: string[];
  items?: string[];
  /** Shown after the list. */
  note?: string;
}

export interface LegalDoc {
  page: LegalPage;
  /** <h1> and <title>. */
  title: string;
  /** Meta description and the line under the title. */
  summary: string;
  sections: LegalSection[];
}

export const LEGAL_TITLES: Record<LegalPage, string> = {
  terms: "Terms of use",
  refunds: "Refund and cancellation policy",
  privacy: "Privacy policy",
  delivery: "Delivery policy",
};

const words = ["zero", "one", "two", "three", "four", "five"];
const number = (n: number) => words[n] ?? String(n);

/** All four documents for a business. */
export function legalDocs(settings: PublicSettings, hubHost: string = DEFAULT_HUB_HOST): Record<LegalPage, LegalDoc> {
  const b = settings.business;
  const name = b.name || site.name;
  const legalName = b.legalName || name;
  const address = b.address;
  const phone = b.phone || site.phone.tel;
  const wa = `WhatsApp ${phone}`;
  const hours = plural(REFUND_WINDOW_HOURS, "hour");
  const access = formatAccess(DEFAULT_ACCESS_DAYS);
  const devices = number(MAX_DEVICES_PER_STUDENT);
  const owner = site.founder;
  const contact = `${legalName}, ${address}. Phone and ${wa}.`;

  const terms: LegalDoc = {
    page: "terms",
    title: LEGAL_TITLES.terms,
    summary: `The terms for buying and using the courses of ${name}: access for ${access}, ${devices} devices, and how batches, certificates and refunds work.`,
    sections: [
      {
        heading: "Who we are",
        paragraphs: [
          `These terms are an agreement between you and ${legalName} ("we", "us"), ${address}. The courses are sold at ${hubHost} and on each course's own page at <course>.${DEFAULT_APEX_DOMAIN}.`,
          `By buying a course or booking a batch you accept these terms. Questions: ${wa}.`,
        ],
      },
      {
        heading: "The courses",
        paragraphs: [
          "A course is recorded video lessons you watch online, a batch of classes at our studio, or both. Each course page says which, what is included, the price, and the access period.",
        ],
      },
      {
        heading: "Prices and payment",
        items: [
          "Prices are in Indian rupees. The amount shown at checkout is the full amount you pay: nothing is added after it.",
          "Payments are processed by Razorpay. We never see or store your card number, UPI PIN or bank password.",
          "After a successful payment your receipt is shown on screen and sent to your email, with a link to open your course.",
          "A studio batch may be booked with a booking amount shown on the course page. The rest of the fee is paid at the studio before the batch starts.",
          "A coupon applies only as described on it, and only once per student unless it says otherwise.",
        ],
      },
      {
        heading: "Your access to recorded lessons",
        items: [
          `Access lasts ${access} from the date of purchase, unless the course page says otherwise.`,
          `Your access is for you alone. You can be signed in on up to ${devices} devices at a time; signing in on another device signs out the one used longest ago.`,
          "Please don't share your sign-in, or download, record, re-upload, sell or show the lessons to others. If we see misuse we may end the access after telling you why, without a refund.",
          "Your account is the email you give when you buy. To sign in on a device, enter that email and open the one-time link we send to it. If you can't reach that email, ask us on WhatsApp.",
        ],
      },
      {
        heading: "Studio batches",
        items: [
          `Classes take place at ${address}, on the dates and times shown for the batch.`,
          "If we have to cancel or move a batch, we tell you on WhatsApp as early as we can. You can then join another batch, or get a refund of what you paid for that batch.",
          "If you can't attend a batch you booked, ask us about moving to a later batch. Moving is possible when a seat is free; it is not guaranteed.",
          "Please follow the studio's instructions on hygiene and on the products and tools used in class.",
        ],
      },
      {
        heading: "Certificates",
        paragraphs: [
          "A course that offers a certificate gives it when you complete the course as its page describes. Every certificate has a public link anyone can use to check it. We may withdraw a certificate that was issued by mistake or obtained by misuse.",
        ],
      },
      {
        heading: "Refunds",
        paragraphs: [`You can ask for a refund within ${hours} of payment. The refund policy explains how and the few cases after that.`],
      },
      {
        heading: "Results",
        paragraphs: [
          "Makeup results depend on practice, skin type and the products you use. The courses teach techniques; they don't promise a job, an income or a particular result.",
        ],
      },
      {
        heading: "Our content",
        paragraphs: [`The lessons, notes, photos and videos belong to ${name}. Buying a course gives you a personal right to watch it, not to copy or reuse it.`],
      },
      {
        heading: "Liability",
        paragraphs: [
          "As far as the law allows, our total liability for a course is limited to the amount you paid for that course. Nothing in these terms takes away rights you have under the Consumer Protection Act, 2019.",
        ],
      },
      {
        heading: "Changes to these terms",
        paragraphs: ["We may update these terms. The version shown on the day you paid applies to that purchase."],
      },
      {
        heading: "Law, complaints and grievance officer",
        paragraphs: [
          "These terms are governed by the laws of India. Courts at Jamnagar, Gujarat have jurisdiction.",
          `Grievance officer: ${owner}, ${legalName}, ${address}. ${wa}. We acknowledge a complaint within 48 hours and aim to resolve it within one month.`,
        ],
      },
    ],
  };

  const refunds: LegalDoc = {
    page: "refunds",
    title: LEGAL_TITLES.refunds,
    summary: `Ask within ${hours} of payment for a full refund. How to ask, how long it takes, and the cases after ${hours}.`,
    sections: [
      {
        heading: `Full refund within ${hours}`,
        paragraphs: [
          `You can ask for a refund within ${hours} of your payment, for any reason. We refund the full amount you paid for that course or batch booking.`,
        ],
      },
      {
        heading: "How to ask",
        items: [
          `Send us a WhatsApp message at ${phone} with your name and the Razorpay payment ID from your receipt (it starts with "pay_").`,
          `The time of your message counts: a request sent within ${hours} of payment is accepted even if we reply later.`,
          "We confirm the refund to you on WhatsApp.",
        ],
      },
      {
        heading: "What happens after a refund",
        items: [
          "Access to the recorded lessons of that course ends.",
          "A booked studio seat is released.",
          "No certificate is issued for that course.",
        ],
      },
      {
        heading: `After ${hours}`,
        paragraphs: [`Payments are not refundable after ${hours}, except when:`],
        items: [
          "we cancel or move a studio batch and you can't attend the new dates: we refund what you paid for that batch;",
          "you were charged twice, or charged for an order that didn't go through: we refund the extra charge;",
          "a fault on our side stops you from using the course and we can't fix it within 7 days: we refund the amount paid.",
        ],
      },
      {
        heading: "When the money arrives",
        paragraphs: [
          "Refunds go back to the same card, UPI account or bank you paid from, through Razorpay. We start an approved refund within 2 working days; banks usually take 5 to 7 working days after that to show it in your account.",
          "With a coupon, the refund is the amount you actually paid. A free enrollment has nothing to refund.",
        ],
      },
      {
        heading: "Contact",
        paragraphs: [contact],
      },
    ],
  };

  const privacy: LegalDoc = {
    page: "privacy",
    title: LEGAL_TITLES.privacy,
    summary: `What ${name} collects when you buy or take a course, why, who sees it, how long it is kept, and your rights under India's DPDP Act, 2023.`,
    sections: [
      {
        heading: "Who is responsible",
        paragraphs: [
          `${legalName}, ${address}, decides how your personal data is used for the courses (the "data fiduciary" under the Digital Personal Data Protection Act, 2023). Contact for anything about your data: ${owner}, ${wa}.`,
        ],
      },
      {
        heading: "What we collect",
        items: [
          "When you buy: your name and your email (your account: we send your receipt and sign-in links to it), and your phone number if you give it.",
          "From Razorpay about your payment: the payment ID, amount, the kind of method (for example UPI or card) and its status. Never your card number, UPI PIN or bank password.",
          "When you study: which lessons you watched, how far, your certificates, and the name you want printed on them.",
          "To keep your account safe: the type of browser and the times of your sign-ins, so you can see and sign out your devices.",
          "For security: your internet (IP) address, kept only in short-lived records that limit repeated attempts. They are deleted within about two days.",
          "Page views are counted per day and course, without cookies and without anything that identifies you.",
        ],
      },
      {
        heading: "Why we use it",
        items: [
          "To sell you the course, take the payment and show and email your receipt.",
          "To give you access: we email you one-time sign-in links when you or we ask for one. We don't send marketing emails.",
          "To keep your place in the lessons and issue certificates.",
          "To answer you on WhatsApp and tell you about changes to a batch you booked.",
          "To prevent fraud and misuse of accounts.",
          "To keep the payment and accounting records the law requires.",
        ],
        note: "We don't use your data for advertising, and we don't sell it.",
      },
      {
        heading: "Cookies",
        paragraphs: [
          "We use only the cookies the site needs to work: one that keeps you signed in to your account and your lessons, and one for the course admin. There are no advertising or tracking cookies.",
        ],
      },
      {
        heading: "Who else sees it",
        items: [
          "Razorpay, to process payments and refunds.",
          "Cloudflare, which hosts the site, the database and the lesson videos, and sends our emails (receipts and sign-in links). Its servers may be outside India.",
          "WhatsApp (Meta), only for the messages you send us or we send you.",
          "Government authorities, only when the law requires it.",
        ],
      },
      {
        heading: "How long we keep it",
        items: [
          "Your account and course progress: while your access lasts, and until you ask us to erase it.",
          `Payment and receipt records: ${RECORD_YEARS} years, as accounting law requires. After an erase request we keep only these, without your name, phone or email.`,
          `Backup copies of the database: ${BACKUP_DAYS} days, then deleted.`,
        ],
      },
      {
        heading: "Your rights",
        paragraphs: ["Under the Digital Personal Data Protection Act, 2023 you can:"],
        items: [
          "ask what personal data we hold about you and how we use it;",
          "have it corrected or completed;",
          "have it erased (this ends access to your courses);",
          "withdraw your consent for future use;",
          "nominate someone to use these rights for you if you can't;",
          "complain to us, and then to the Data Protection Board of India if you aren't satisfied.",
        ],
      },
      {
        heading: "How to use your rights",
        paragraphs: [`Send a WhatsApp message to ${phone} with the email your account uses. We reply within 7 days and act within 30 days.`],
      },
      {
        heading: "Children",
        paragraphs: ["The courses are for adults. Anyone under 18 may join only when a parent or guardian buys the course and agrees to this policy for them."],
      },
      {
        heading: "Security",
        paragraphs: [
          "Every page is served over an encrypted connection. Sign-in tokens are stored only in a scrambled (hashed) form, payment checks use Razorpay's signatures, and only the owner can open the course admin.",
        ],
      },
      {
        heading: "Changes",
        paragraphs: ["If we change this policy we update the date at the top. If a change affects how we use data you already gave us, we tell you on WhatsApp."],
      },
    ],
  };

  const delivery: LegalDoc = {
    page: "delivery",
    title: LEGAL_TITLES.delivery,
    summary: "The courses are delivered online and at the studio: nothing is shipped. When you get access, your receipt and your certificate.",
    sections: [
      {
        heading: "Nothing is shipped",
        paragraphs: ["The courses are digital (recorded lessons) or held at our studio (batches). We don't ship any physical goods."],
      },
      {
        heading: "Recorded lessons",
        items: [
          "Access starts right after a successful payment: the course opens on the device you paid on (a first purchase), and a link to open it is sent to your email.",
          `On another device, sign in with your email: we send you a one-time link. You can be signed in on up to ${devices} devices at a time.`,
          `Access lasts ${access} from the date of purchase, unless the course page says otherwise.`,
        ],
      },
      {
        heading: "Studio batches",
        items: [
          "Your seat is confirmed on screen right after payment, with the batch dates.",
          `Classes are at ${address}.`,
          "If the course has a booking amount, the rest of the fee is paid at the studio before the batch starts.",
        ],
      },
      {
        heading: "Receipts",
        paragraphs: ["Your receipt is shown on screen after payment, sent to your email, and stays in your account."],
      },
      {
        heading: "Certificates",
        paragraphs: ["Certificates are pages you can print or save as PDF, each with a public link to check it. No printed copy is posted."],
      },
      {
        heading: "If something doesn't open",
        paragraphs: [
          `If your payment succeeded but the course doesn't open, send us your Razorpay payment ID on WhatsApp at ${phone}. If we can't give you access, you get a full refund (refund policy).`,
        ],
      },
    ],
  };

  const docs = { terms, refunds, privacy, delivery };
  // Every page in LEGAL_PAGES has a document (a new constant entry fails here, not on the site).
  for (const page of LEGAL_PAGES) if (!docs[page]) throw new Error(`legal: no document for ${page}`);
  return docs;
}
