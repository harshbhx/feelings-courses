// GET /api/public/preview/:lessonId : signed public links for a free-preview lesson (W4).
import type { Env } from "../../../_lib/env.ts";
import { error, errorResponse, json, methodNotAllowed } from "../../../_lib/http.ts";
import { previewLesson } from "../../../_lib/play.ts";

export const onRequest: PagesFunction<Env, "lessonId"> = async ({ request, env, params }) => {
  if (request.method !== "GET") return methodNotAllowed(["GET"]);
  const raw = String(params.lessonId);
  try {
    const media = /^[1-9]\d{0,11}$/.test(raw) ? await previewLesson(env, Number(raw)) : null;
    return media ? json(media) : error(404, "not_found", "This lesson has no free preview.");
  } catch (err) {
    return errorResponse(err);
  }
};
