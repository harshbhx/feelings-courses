// W6: guards on the admin's source. The real admin must not fall back to the demo store, must not
// build HTML from strings (names, codes and titles are typed by people), and must not show a GSTIN
// anywhere except the settings form (owner decision).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

function files(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) files(rel, out);
    else if (/\.(ts|astro)$/.test(name)) out.push(rel);
  }
  return out;
}

// The public demo catalog still uses these until W1 replaces it; the admin must not.
const PUBLIC_DEMO = new Set(["src/components/admin/client/catalog.ts", "src/components/admin/client/course-page.ts", "src/components/admin/client/covers.ts"]);
const adminFiles = [...files("src/pages/admin"), ...files("src/components/admin"), "src/layouts/Admin.astro"].filter((f) => !PUBLIC_DEMO.has(f));

test("the admin never reads the demo store", () => {
  for (const f of adminFiles) assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /demo-store/, f);
});

test("no HTML from strings and no inline handlers in the admin", () => {
  for (const f of adminFiles) {
    const src = readFileSync(join(ROOT, f), "utf8");
    assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=/, f);
    assert.doesNotMatch(src, /\son[a-z]+="/, f);
    assert.doesNotMatch(src, /javascript:/, f);
  }
});

test("the GSTIN appears only in the settings form", () => {
  const allowed = new Set(["src/pages/admin/settings.astro", "src/components/admin/client/settings.ts", "src/components/admin/lib/settings.ts"]);
  for (const f of adminFiles) {
    if (allowed.has(f)) continue;
    assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /gstin/i, f);
  }
});

test("every admin page uses the admin layout and is never indexed", () => {
  const layout = readFileSync(join(ROOT, "src/layouts/Admin.astro"), "utf8");
  assert.match(layout, /<meta name="robots" content="noindex, nofollow"/);
  for (const f of files("src/pages/admin")) assert.match(readFileSync(join(ROOT, f), "utf8"), /layouts\/Admin\.astro/, f);
});
