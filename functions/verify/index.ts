// /verify: type a certificate code. functions/_lib/pages/verify.ts.
import type { Env } from "../_lib/env.ts";
import { handleVerifyPage } from "../_lib/pages/verify.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleVerifyPage(request, env, null);
