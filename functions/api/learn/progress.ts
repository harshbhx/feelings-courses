// PUT /api/learn/progress. A GET here is GET /api/learn/:slug for a course whose slug is "progress"
// (Pages prefers this static route over [slug]). functions/_lib/student-api.ts.
import type { Env } from "../../_lib/env.ts";
import { handleLearnCourse, handleProgress } from "../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) =>
  request.method === "GET" || request.method === "HEAD" ? handleLearnCourse("progress")(request, env) : handleProgress(request, env);
