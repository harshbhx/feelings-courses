// GET /api/learn/:slug. functions/_lib/student-api.ts.
import type { Env } from "../../../_lib/env.ts";
import { handleLearnCourse } from "../../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env, "slug"> = ({ request, env, params }) => handleLearnCourse(String(params.slug ?? ""))(request, env);
