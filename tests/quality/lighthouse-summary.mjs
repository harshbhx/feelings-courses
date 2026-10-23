// Turns the Lighthouse results of one run (.lighthouseci/lhr-*.json, written by `lhci collect`)
// into a Markdown table (stdout, for the job summary) and a JSON file (for docs/QUALITY.md).
//
//   node tests/quality/lighthouse-summary.mjs <label> [lhciDir] [outJson]
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { PAGES } from "./pages.mjs";

const label = process.argv[2] ?? "mobile";
const dir = process.argv[3] ?? ".lighthouseci";
const outJson = process.argv[4] ?? `quality-report/lighthouse-${label}.json`;

const nameOf = (url) => PAGES.find((p) => p.url === url || p.url === url.replace(/\/$/, ""))?.name ?? url;
const score = (lhr, id) => (lhr.categories[id]?.score == null ? null : Math.round(lhr.categories[id].score * 100));
const num = (lhr, id) => lhr.audits[id]?.numericValue ?? null;
const scriptBytes = (lhr) => lhr.audits["resource-summary"]?.details?.items?.find((i) => i.resourceType === "script")?.transferSize ?? 0;

const rows = [];
for (const file of readdirSync(dir).filter((f) => /^lhr-.*\.json$/.test(f))) {
  const lhr = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  const url = lhr.requestedUrl ?? lhr.finalDisplayedUrl;
  rows.push({
    page: nameOf(url),
    url,
    finalUrl: lhr.finalDisplayedUrl ?? lhr.finalUrl,
    performance: score(lhr, "performance"),
    accessibility: score(lhr, "accessibility"),
    bestPractices: score(lhr, "best-practices"),
    seo: score(lhr, "seo"),
    lcpMs: Math.round(num(lhr, "largest-contentful-paint") ?? 0),
    cls: Number((num(lhr, "cumulative-layout-shift") ?? 0).toFixed(3)),
    tbtMs: Math.round(num(lhr, "total-blocking-time") ?? 0),
    scriptKb: Math.round(scriptBytes(lhr) / 102.4) / 10,
    failing: Object.values(lhr.audits)
      .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "informative" && a.scoreDisplayMode !== "manual")
      .map((a) => a.id),
  });
}
const order = (r) => {
  const i = PAGES.findIndex((p) => p.name === r.page);
  return i === -1 ? 999 : i;
};
rows.sort((a, b) => order(a) - order(b));

mkdirSync(path.dirname(outJson), { recursive: true });
writeFileSync(outJson, JSON.stringify({ label, generatedAt: new Date().toISOString(), rows }, null, 2));

const cell = (v) => (v === null ? "n/a" : v < 95 ? `**${v}**` : String(v));
console.log(`### Lighthouse, ${label}\n`);
console.log("| Page | Perf | A11y | Best pr. | SEO | LCP ms | CLS | TBT ms | JS KB | Below 0.9 |");
console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
for (const r of rows) {
  console.log(
    `| ${r.page} | ${cell(r.performance)} | ${cell(r.accessibility)} | ${cell(r.bestPractices)} | ${cell(r.seo)} | ${r.lcpMs} | ${r.cls} | ${r.tbtMs} | ${r.scriptKb} | ${r.failing.join(", ") || "none"} |`,
  );
}
if (rows.some((r) => r.finalUrl && r.finalUrl.replace(/\/$/, "") !== r.url.replace(/\/$/, ""))) {
  console.log("\nRedirected:");
  for (const r of rows.filter((x) => x.finalUrl && x.finalUrl.replace(/\/$/, "") !== x.url.replace(/\/$/, ""))) console.log(`- ${r.url} → ${r.finalUrl}`);
}
