/**
 * The build's environment (Cloudflare Pages sets CF_PAGES_BRANCH; the owner may set HUB_HOST).
 * Read at build time only, without Node typings, so it type-checks in the Astro project.
 */
import type { BuildEnv } from "./seo.ts";

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export const buildEnv: BuildEnv = { CF_PAGES_BRANCH: env.CF_PAGES_BRANCH, HUB_HOST: env.HUB_HOST };
export const buildCommit: string | null = env.CF_PAGES_COMMIT_SHA?.trim() || null;
