// GET /api/certificates/:code: the public certificate check. functions/_lib/student-api.ts.
import type { Env } from "../../_lib/env.ts";
import { handleCertificateCheck } from "../../_lib/student-api.ts";

export const onRequest: PagesFunction<Env, "code"> = ({ request, env, params }) => handleCertificateCheck(String(params.code ?? ""))(request, env);
