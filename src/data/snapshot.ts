/**
 * Build-time content loader (plan 1.1). Pages read published courses from here, never from D1.
 *
 * Source, decided by scripts/snapshot.mjs before `astro build`:
 * - src/generated/snapshot.json (gitignored), fetched from the live site's /api/public/snapshot;
 * - otherwise the seed snapshot built from src/data/course.ts (src/data/seed-snapshot.ts).
 *
 * Today's pages still read course.ts directly; W1 moves the landing pages onto `snapshot`.
 */
import type { PublicCourse, Snapshot } from "../shared/types.ts";
import { seedSnapshot } from "./seed-snapshot.ts";

export type SnapshotSource = "live" | "url" | "seed";

interface GeneratedFile {
  source: Exclude<SnapshotSource, "seed">;
  snapshot: Snapshot;
}

// Vite resolves the glob at build time; a missing file just gives an empty object.
const generated = Object.values(
  import.meta.glob<GeneratedFile>("../generated/snapshot.json", { eager: true, import: "default" }),
)[0];

export const snapshotSource: SnapshotSource = generated ? generated.source : "seed";
export const snapshot: Snapshot = generated ? generated.snapshot : seedSnapshot();

/** Published courses, in the admin's order. */
export const courses: readonly PublicCourse[] = snapshot.courses;

export function getCourse(slug: string): PublicCourse | undefined {
  return courses.find((c) => c.slug === slug);
}
