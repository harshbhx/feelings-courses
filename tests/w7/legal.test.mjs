// src/data/legal.ts: the policies say exactly what the platform enforces, and never show a GSTIN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { legalDocs, LEGAL_TITLES } from "../../src/data/legal.ts";
import { seedSnapshot } from "../../src/data/seed-snapshot.ts";
import { DEFAULT_ACCESS_DAYS, LEGAL_PAGES, MAX_DEVICES_PER_STUDENT, REFUND_WINDOW_HOURS } from "../../src/shared/constants.ts";
import { formatAccess } from "../../src/lib/course-view.ts";

const settings = seedSnapshot(0).settings;
const docs = legalDocs(settings);
const text = (doc) => [doc.title, doc.summary, ...doc.sections.flatMap((s) => [s.heading, ...(s.paragraphs ?? []), ...(s.items ?? []), s.note ?? ""])].join("\n");
const all = LEGAL_PAGES.map((p) => text(docs[p])).join("\n");

test("one document per legal page, with a title, summary and sections", () => {
  assert.deepEqual(Object.keys(docs).sort(), [...LEGAL_PAGES].sort());
  for (const page of LEGAL_PAGES) {
    const doc = docs[page];
    assert.equal(doc.page, page);
    assert.equal(doc.title, LEGAL_TITLES[page]);
    assert.ok(doc.summary.length > 40 && doc.summary.length <= 200, `${page} summary length ${doc.summary.length}`);
    assert.ok(doc.sections.length >= 4, page);
    for (const s of doc.sections) assert.ok(s.paragraphs?.length || s.items?.length, `${page}: "${s.heading}" is empty`);
  }
});

test("the refund window, access period and device limit come from the owner's constants", () => {
  assert.match(text(docs.refunds), new RegExp(`within ${REFUND_WINDOW_HOURS} hours of (your )?payment`));
  assert.match(text(docs.terms), new RegExp(`within ${REFUND_WINDOW_HOURS} hours`));
  assert.ok(text(docs.terms).includes(`Access lasts ${formatAccess(DEFAULT_ACCESS_DAYS)} from the date of purchase`));
  assert.ok(text(docs.terms).includes(`up to two devices`), `devices: ${MAX_DEVICES_PER_STUDENT}`);
  assert.ok(text(docs.delivery).includes("up to two devices"));
});

test("no GSTIN, no tax lines; the email is the account and the pages say so", () => {
  assert.doesNotMatch(all, /GST|gstin|tax invoice|\bVAT\b/i);
  assert.doesNotMatch(all, /\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/, "no GSTIN-shaped string");
  // Email identity (owner decision, 23 Oct 2026): collected, used for receipts and sign-in links, never marketing.
  assert.match(text(docs.privacy), /your email \(your account/);
  assert.match(text(docs.privacy), /We don't send marketing emails/);
  assert.match(text(docs.privacy), /sends our emails/, "Cloudflare named as the sender");
  assert.match(text(docs.delivery), /sent to your email/);
  assert.match(text(docs.terms), /Your account is the email you give/);
  assert.doesNotMatch(all, /payment ID, or ask us|We don't send emails|phone number or email you paid with/i, "no phone or payment-ID sign-in left");
});

test("business facts come from settings", () => {
  const custom = legalDocs({ ...settings, business: { ...settings.business, legalName: "Feelings Beauty Care (Prop. U. Mengar)", address: "Test Road, Jamnagar" } });
  const t = text(custom.terms);
  assert.ok(t.includes("Feelings Beauty Care (Prop. U. Mengar)"));
  assert.ok(t.includes("Test Road, Jamnagar"));
  assert.ok(text(custom.privacy).includes("Test Road, Jamnagar"));
});

test("required elements: grievance officer, governing law, DPDP rights, delivery mode", () => {
  assert.match(text(docs.terms), /Grievance officer: /);
  assert.match(text(docs.terms), /laws of India/);
  assert.match(text(docs.terms), /Consumer Protection Act, 2019/);
  assert.match(text(docs.privacy), /Digital Personal Data Protection Act, 2023/);
  assert.match(text(docs.privacy), /Data Protection Board of India/);
  assert.match(text(docs.delivery), /don't ship any physical goods/);
});
