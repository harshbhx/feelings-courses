// /verify/<code>: the public, printable certificate. functions/_lib/pages/verify.ts.
import type { Env } from "../_lib/env.ts";
import { handleVerifyPage } from "../_lib/pages/verify.ts";

export const onRequest: PagesFunction<Env, "code"> = ({ request, env, params }) =>
  handleVerifyPage(request, env, String(params.code ?? ""));
