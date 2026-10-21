// Runs for every request. Pages routes Functions by the raw path but serves static files by the
// decoded path, so /%6cearn or /learn%2Fsoft-glam would reach the course pages without passing
// functions/learn/_middleware.ts. This sends any path that resolves to the course area through
// the same gate (functions/learn/_gate.ts); every other request passes straight on.
//
// Being at the root, it makes the whole site run through Functions (_routes.json becomes "/*").
// Requests that are not for the course do one string check and go on to the static files.
import type { EnrollEnv } from "./_lib/enrollment";
import { siteMiddleware } from "./learn/_gate";

export const onRequest: PagesFunction<EnrollEnv> = (context) => siteMiddleware(context);
