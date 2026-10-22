// GET/HEAD /media/c/<lessonId>?e=&s=&sig= : a lesson's captions (WebVTT), behind a signed link (W4).
import type { Env } from "../../_lib/env.ts";
import { serveLessonMedia } from "../../_lib/media-serve.ts";

export const onRequest: PagesFunction<Env, "lessonId"> = ({ request, env, params }) =>
  serveLessonMedia(env, request, "c", String(params.lessonId));
