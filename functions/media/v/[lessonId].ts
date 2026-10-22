// GET/HEAD /media/v/<lessonId>?e=&s=&sig= : a lesson's video, behind a signed link (W4, functions/_lib/media-serve.ts).
import type { Env } from "../../_lib/env.ts";
import { serveLessonMedia } from "../../_lib/media-serve.ts";

export const onRequest: PagesFunction<Env, "lessonId"> = ({ request, env, params }) =>
  serveLessonMedia(env, request, "v", String(params.lessonId));
