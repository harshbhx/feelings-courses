// Runs for every request. The order (plan W0):
//
//   0. screen       refuse obviously bad requests (odd methods, huge URLs or bodies, NUL bytes) before
//                   any work (functions/_lib/abuse.ts, W7).
//   1. migrate      when the D1 binding exists, bring the database up to date (once per isolate,
//                   functions/_lib/migrate.ts). Without a DB (before the owner runs setup) it is
//                   skipped, so the demo keeps working exactly as before.
//   2. hostRouting  course hosts → the static /c/<slug> page, hub-only paths → the hub, security
//                   headers on every response (functions/_lib/hosts.ts, W1; docs/platform/HOSTS.md).
//   3. siteMiddleware  the course-area gate. Pages routes Functions by the raw path but serves static
//                   files by the decoded path, so /%6cearn or /learn%2Fsoft-glam would reach the
//                   course pages without passing functions/learn/_middleware.ts. This sends any path
//                   that resolves to the course area through the same gate (functions/learn/_gate.ts);
//                   every other request passes straight on.
//
// Being at the root, it makes the whole site run through Functions (_routes.json becomes "/*").
// public/_routes.json (W1) keeps hashed assets and icons out of Functions.
import { siteMiddleware } from "./learn/_gate";
import { screenRequest } from "./_lib/abuse.ts";
import { hasDb, type Env } from "./_lib/env.ts";
import { finish, hostRouting, type MiddlewareContext } from "./_lib/hosts.ts";
import { ensureMigrated } from "./_lib/migrate.ts";

/** The composition. Tests call onRequest with a fake context (tests/foundation/middleware.test.mjs). */
async function rootMiddleware(context: MiddlewareContext): Promise<Response> {
  const { env } = context;
  const refused = screenRequest(context.request);
  if (refused) return finish(refused);
  if (hasDb(env)) {
    try {
      await ensureMigrated(env.DB);
    } catch (err) {
      // Each migration is atomic, so the database is at a consistent earlier version. Static pages
      // keep working; the next request retries. Endpoints that need the new schema fail on their own.
      console.error(`migrate: ${err instanceof Error ? err.message : "unknown error"}`);
    }
  }
  return hostRouting(context, () => siteMiddleware(context));
}

export const onRequest: PagesFunction<Env> = (context) => rootMiddleware(context);
