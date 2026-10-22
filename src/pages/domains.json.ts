// /domains.json (DomainsManifest): course slugs whose subdomain is active. The hub's router
// (functions/_lib/hosts.ts) reads it once per deployment to 301 /c/<slug> to <slug>.<apex>/.
import type { APIRoute } from "astro";
import { courses } from "../data/snapshot";
import type { DomainsManifest } from "../shared/types";

export const GET: APIRoute = () => {
  const manifest: DomainsManifest = { active: courses.filter((c) => c.domainActive).map((c) => c.slug) };
  return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } });
};
