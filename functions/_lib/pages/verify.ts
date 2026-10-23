/**
 * /verify/<code>: the public certificate page (W3). It is both the printable certificate (the
 * student prints it or saves it as a PDF from the browser) and the proof anyone can check: the
 * page is rendered live from D1, so a withdrawn certificate stops showing at once.
 *
 *   /verify             a form to type a code
 *   /verify?code=…      → /verify/<CODE> (normalised: case, hyphens, I/L → 1, O → 0)
 *   /verify/<code>      the certificate, or "not found" / "withdrawn"
 *
 * Rate limited per IP (RATE_LIMITS.certificate_ip) together with GET /api/certificates/:code.
 * Shows only the name, course, wording and date: no contact details, no student id.
 */
import { checkCertificate, normalizeCertificateCode, type CertificateView } from "../certificates.ts";
import { config } from "../config.ts";
import { unixNow } from "../db/d1.ts";
import type { Env } from "../env.ts";
import { clientIp } from "../http.ts";
import { hit } from "../ratelimit.ts";
import { callout, formatLongDate, html, icon, layout, loadBusiness, messagePage, page, pageRedirect, raw, type Business, type Raw } from "./html.ts";

function lookupForm(business: Business, error: string | null): Raw {
  return layout(
    { title: "Check a certificate", business },
    html`<section class="card narrow">
  <span class="state-icon">${icon("seal-check")}</span>
  <h1>Check a certificate</h1>
  <p>Enter the 10-character code printed on the certificate. We'll show who it was issued to, for which course and when.</p>
  ${error ? callout("alert", error, "code-error") : ""}
  <form method="get" action="/verify" class="form">
    <label for="code">Certificate code</label>
    <input id="code" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="20" required placeholder="For example 7K3M9QX2PA"${error ? raw(` aria-invalid="true" aria-describedby="code-error"`) : ""}>
    <button type="submit" class="btn">${icon("magnifying-glass")}Check</button>
  </form>
</section>`,
  );
}

function certificateMarkup(business: Business, view: CertificateView, verifyUrl: string): Raw {
  return layout(
    { title: `Certificate: ${view.name}`, business, bodyClass: "certificate-page", wide: true },
    html`<p class="verified no-print" role="status">${icon("seal-check")}<span>✓ Verified: this certificate was issued by ${business.name}.</span></p>
<h1 class="visually-hidden">Certificate: ${view.name}, ${view.course}</h1>
<article class="certificate" aria-label="Certificate">
  <span class="cert-seal">${icon("seal-check")}</span>
  <p class="cert-org">${business.name}<span class="bindi" aria-hidden="true"></span></p>
  <p class="cert-kicker">Certificate</p>
  <p class="cert-intro">This is to certify that</p>
  <p class="cert-name">${view.name}</p>
  <p class="cert-intro">has completed</p>
  <p class="cert-course">${view.course}</p>
  <p class="cert-title">${view.title}</p>
  <div class="cert-foot">
    <div><p class="cert-label">Teacher</p><p>${view.teacher}</p></div>
    <div><p class="cert-label">Date</p><p>${view.issuedAt !== null ? formatLongDate(view.issuedAt) : ""}</p></div>
    <div><p class="cert-label">Certificate code</p><p><code>${view.code}</code></p></div>
  </div>
  <p class="cert-verify">Check it at ${verifyUrl}</p>
</article>
<p class="no-print center muted small">Use your browser's Print or Share menu to print it or save it as a PDF.</p>`,
  );
}

export async function handleVerifyPage(request: Request, env: Env, rawCode: string | null, now = unixNow()): Promise<Response> {
  const business = await loadBusiness(env.DB ?? null);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return page(messagePage({ title: "Not allowed", business }, "Not allowed", "This page can't be used that way.", undefined, { icon: "warning-circle", tone: "warn" }), 405);
  }
  if (!env.DB) return page(messagePage({ title: "Check a certificate", business }, "Not available yet", "Certificate checks aren't set up yet.", undefined, { icon: "clock", tone: "info" }), 503);

  if (rawCode === null) {
    const typed = new URL(request.url).searchParams.get("code");
    if (typed === null) return page(lookupForm(business, null), 200, [], request.method);
    const code = normalizeCertificateCode(typed);
    if (!code) return page(lookupForm(business, "That doesn't look like a certificate code. It has 10 letters and digits."), 400, [], request.method);
    return pageRedirect(`/verify/${code}`, [], 302);
  }

  const limit = await hit(env.DB, "certificate_ip", clientIp(request), { now });
  if (!limit.allowed) {
    const response = page(messagePage({ title: "Please wait", business }, "Please wait a minute", "Too many certificate checks from this connection.", undefined, { icon: "clock", tone: "warn" }), 429);
    response.headers.set("Retry-After", String(limit.retryAfter));
    return response;
  }

  const code = normalizeCertificateCode(rawCode);
  // A code typed in lower case or with hyphens moves to its canonical address (one URL per certificate).
  if (code && code !== rawCode) return pageRedirect(`/verify/${code}`, [], 301);
  const view = await checkCertificate(env.DB, code);
  if (!view.valid) {
    return page(
      messagePage(
        { title: "Certificate not found", business },
        view.revoked ? "This certificate was withdrawn" : "Certificate not found",
        view.revoked
          ? "It is no longer valid."
          : "No certificate has this code. Check the code on the certificate, letter by letter.",
        { href: "/verify", label: "Check another code" },
        { icon: view.revoked ? "x-circle" : "magnifying-glass", tone: view.revoked ? "warn" : "info" },
      ),
      404,
      [],
      request.method,
    );
  }
  const url = `${config(env).hubOrigin}/verify/${view.code}`;
  return page(certificateMarkup(business, view, url), 200, [], request.method);
}
