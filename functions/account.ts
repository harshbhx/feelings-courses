// /account: the student's courses, devices, payments and name. functions/_lib/pages/account.ts.
import type { Env } from "./_lib/env.ts";
import { handleAccount } from "./_lib/pages/account.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => handleAccount(request, env);
