// POST /api/learn/:slug/certificate. functions/_lib/student-api.ts.
import type { Env } from "../../../_lib/env.ts";
import { handleCertificateClaim } from "../../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env, "slug"> = ({ request, env, params }) =>
  handleCertificateClaim(String(params.slug ?? ""))(request, env);
