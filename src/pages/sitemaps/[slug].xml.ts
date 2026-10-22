// /sitemaps/<slug>.xml: one course host's sitemap, served there as /sitemap.xml by
// functions/_lib/hosts.ts. Empty until the course's domain is active and the course is real.
import type { APIRoute, GetStaticPaths } from "astro";
import { courses, snapshot } from "../../data/snapshot";
import { buildEnv } from "../../lib/build-env";
import { courseSitemapUrls, sitemapXml } from "../../lib/seo";
import type { PublicCourse } from "../../shared/types";

export const getStaticPaths: GetStaticPaths = () => courses.map((course) => ({ params: { slug: course.slug }, props: { course } }));

export const GET: APIRoute = ({ props }) => {
  const { course } = props as { course: PublicCourse };
  return new Response(sitemapXml(courseSitemapUrls(course, snapshot, buildEnv)), {
    headers: { "Content-Type": "application/xml; charset=utf-8" },
  });
};
