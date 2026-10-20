/**
 * The course area's lessons (/learn and /learn/<slug>).
 *
 * Titles, minutes and the module order come from src/data/course.ts and are never retyped here.
 * This file only adds what the course area needs on top, one entry per lesson in
 * `course.modules`, in the same order:
 *
 *   slug      The lesson's URL (/learn/<slug>) and its key in the saved progress
 *             (localStorage `fbc-progress`). Keep a slug when a title changes, or buyers lose
 *             that lesson's tick.
 *   videoId   The lesson video, once it exists: a YouTube id, played through youtube-nocookie
 *             only after a tap. Until then the page says "Lesson video coming soon" and plays one
 *             of `course.glimpses` as a clearly labelled demo clip.
 *   vertical  true when the lesson video is filmed upright (9:16) rather than 16:9.
 *
 * DEMO: no lesson has a video yet. When the client confirms the modules in course.ts, line this
 * list up with them; the build stops with a clear message if the two disagree.
 */
import { course } from "./course";

interface LessonSetup {
  slug: string;
  videoId?: string;
  vertical?: boolean;
}

const setup: readonly (readonly LessonSetup[])[] = [
  // Skin prep and base
  [{ slug: "know-your-skin-type" }, { slug: "prep-and-priming" }, { slug: "foundation-shade-matching" }],
  // Eyes
  [{ slug: "brushes-and-blending" }, { slug: "everyday-eyes" }, { slug: "party-eyes" }],
  // Complete looks
  [{ slug: "soft-glam" }, { slug: "evening-party-look" }, { slug: "touch-ups" }],
];

/** Paths the course area uses for itself, so no lesson may take them. */
const RESERVED = new Set(["logout", "index"]);

export interface LessonVideo {
  id: string;
  vertical: boolean;
  /** true while the lesson has no video of its own and a studio clip stands in. */
  demo: boolean;
  /** What the stand-in clip shows (from course.glimpses), for its caption. */
  label?: string;
}

export interface Lesson {
  slug: string;
  href: string;
  title: string;
  minutes: number;
  /** 1-based, across the whole course. */
  number: number;
  /** 1-based, inside its module. */
  numberInModule: number;
  moduleNumber: number;
  moduleTitle: string;
  video: LessonVideo;
}

export interface LessonModule {
  number: number;
  title: string;
  minutes: number;
  lessons: Lesson[];
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`src/data/lessons.ts: ${message}`);
}

check(
  setup.length === course.modules.length,
  `course.ts has ${course.modules.length} modules but this file lists ${setup.length}. Line them up.`,
);

const seen = new Set<string>();
let counter = 0;

export const modules: LessonModule[] = course.modules.map((mod, m) => {
  const entries = setup[m]!;
  check(
    entries.length === mod.lessons.length,
    `module ${m + 1} ("${mod.title}") has ${mod.lessons.length} lessons in course.ts but ${entries.length} here. Line them up.`,
  );

  const lessons = mod.lessons.map((lesson, l): Lesson => {
    const { slug, videoId, vertical } = entries[l]!;
    check(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug), `"${slug}" is not a valid slug (lowercase words joined by hyphens).`);
    check(!RESERVED.has(slug), `"${slug}" is reserved by the course area.`);
    check(!seen.has(slug), `the slug "${slug}" is used twice.`);
    seen.add(slug);

    const index = counter++;
    const glimpse = course.glimpses[index % course.glimpses.length]!;
    const video: LessonVideo = videoId
      ? { id: videoId, vertical: vertical ?? false, demo: false }
      : // Stand-in: the studio's Shorts are upright.
        { id: glimpse.id, vertical: true, demo: true, label: glimpse.label };

    return {
      slug,
      href: `/learn/${slug}`,
      title: lesson.title,
      minutes: lesson.minutes,
      number: index + 1,
      numberInModule: l + 1,
      moduleNumber: m + 1,
      moduleTitle: mod.title,
      video,
    };
  });

  return {
    number: m + 1,
    title: mod.title,
    minutes: lessons.reduce((sum, lesson) => sum + lesson.minutes, 0),
    lessons,
  };
});

export const lessons: Lesson[] = modules.flatMap((mod) => mod.lessons);

/** "6 min", "1 h", "1 h 28 min". */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
