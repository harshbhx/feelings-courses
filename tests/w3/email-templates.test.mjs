// The emails (functions/_lib/email-templates.ts): plain text first, escaped HTML, our links only,
// no GSTIN or tax lines, and the sign-in wording the pages use (once, 15 minutes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { adminLinkEmail, enrolledEmail, receiptEmail, signInEmail } from "../../functions/_lib/email-templates.ts";

const brand = { name: "Feelings Beauty Care", whatsappUrl: "https://wa.me/918000661578?text=Hi" };
const LINK = "https://courses.feelingsbeautycare.in/auth/continue?t=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde";

test("sign-in email: the link in text and HTML, once for 15 minutes, safe to ignore", () => {
  const m = signInEmail(brand, "asha@example.com", LINK);
  assert.equal(m.to, "asha@example.com");
  assert.match(m.subject, /sign-in link/);
  assert.ok(m.text.includes(LINK));
  assert.ok(m.html.includes(LINK));
  assert.match(m.text, /works once, for 15 minutes/);
  assert.match(m.text, /ignore this email/);
  assert.ok(m.text.includes("wa.me/918000661578"));
});

test("receipt email: course, amount, number, payment ID, receipt link and sign-in link; no tax lines", () => {
  const m = receiptEmail(brand, "asha@example.com", {
    courseTitle: "Online Basics",
    amount: "₹1,499.99",
    paidOn: "23 Oct 2026, 11:30 am",
    paymentId: "pay_Paid00000001",
    invoiceNo: "FBC/26-27/00001",
    receiptUrl: "https://courses.feelingsbeautycare.in/receipt/1?k=" + "a".repeat(32),
    signInUrl: LINK,
  });
  for (const s of ["Online Basics", "₹1,499.99", "FBC/26-27/00001", "pay_Paid00000001", "/receipt/1?k=", LINK]) assert.ok(m.text.includes(s), s);
  assert.equal(/gst|tax/i.test(m.text + m.html), false);
  const noLinks = receiptEmail(brand, "asha@example.com", { courseTitle: "X", amount: "₹1", paidOn: "today", paymentId: "pay_x", invoiceNo: null, receiptUrl: null, signInUrl: null });
  assert.equal(noLinks.text.includes("/auth/continue"), false);
  assert.equal(noLinks.text.includes("Receipt no."), false);
});

test("emails escape everything typed by people (names, course titles)", () => {
  const evil = `<img src=x onerror=alert(1)>"'&`;
  const a = adminLinkEmail(brand, "asha@example.com", evil, LINK);
  const b = enrolledEmail({ ...brand, name: evil }, "asha@example.com", evil, LINK);
  assert.ok(b.html.includes("&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;"));
  for (const m of [a, b]) {
    assert.equal(m.html.includes("<img src=x"), false);
    assert.ok(m.html.includes("&lt;img"));
  }
  assert.match(a.text, /expires in 24 hours/);
  assert.equal(/[\r\n]/.test(a.subject + b.subject), false);
});
