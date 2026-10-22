// /learn/logout. With D1: POST revokes this device's session and clears the cookies; GET only offers
// the button (functions/_lib/pages/auth.ts). Without D1 (the demo): clears the demo's enrollment
// cookie and goes home. The middleware lets it through without an enrollment either way.
import type { Env } from "../_lib/env.ts";
import { hasDb } from "../_lib/env.ts";
import { handleLogout } from "../_lib/pages/auth.ts";
import { logout } from "./_gate";

export const onRequest: PagesFunction<Env> = ({ request, env }) => (hasDb(env) ? handleLogout(request, env) : logout(request));
