// GET /api/learn/:slug/lessons/:lessonId/play: the enrollment check (W3), then W4's playLesson().
import type { Env } from "../../../../../_lib/env.ts";
import { handlePlay } from "../../../../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env, "slug" | "lessonId"> = ({ request, env, params }) =>
  handlePlay(String(params.slug ?? ""), String(params.lessonId ?? ""))(request, env);
