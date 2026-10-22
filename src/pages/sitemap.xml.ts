// /sitemap.xml on the hub: the catalog, hub-hosted courses and legal pages (src/lib/seo.ts).
// Course hosts get /sitemaps/<slug>.xml instead (functions/_lib/hosts.ts serves it at /sitemap.xml).
import type { APIRoute } from "astro";
import { snapshot } from "../data/snapshot";
import { buildEnv } from "../lib/build-env";
import { hubSitemapUrls, sitemapXml } from "../lib/seo";

export const GET: APIRoute = () =>
  new Response(sitemapXml(hubSitemapUrls(snapshot, buildEnv)), { headers: { "Content-Type": "application/xml; charset=utf-8" } });
