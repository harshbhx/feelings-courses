// Loaded with `node --import ./tests/helpers/register.mjs` (npm test does this).
//
// Node's type stripping runs the project's .ts files, but it only resolves imports that spell out
// the extension. Astro and some Functions write `import { course } from "./course"`. This resolve
// hook retries such relative imports with ".ts" (then "/index.ts"), so tests can import any source
// file as it is. Nothing else changes.

import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    if (!relative || err?.code !== "ERR_MODULE_NOT_FOUND" || /\\.[cm]?[jt]s$/.test(specifier)) throw err;
    for (const suffix of [".ts", "/index.ts"]) {
      const url = new URL(specifier + suffix, context.parentURL);
      if (existsSync(fileURLToPath(url))) return next(url.href, context);
    }
    throw err;
  }
}
`),
  import.meta.url,
);
