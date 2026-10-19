import { defineConfig } from "astro/config";

// Static site. Cloudflare Pages builds it from GitHub; Pages Functions in functions/ handle the
// checkout (functions/api/*) and gate the course area (functions/learn/_middleware.ts).
export default defineConfig({
  site: "https://courses.feelingsbeautycare.in",
  trailingSlash: "never",
  // CSS goes into each page's HTML, so no stylesheet request blocks the first paint.
  build: { format: "file", inlineStylesheets: "always" },
  compressHTML: true,
  image: { responsiveStyles: false },
});
