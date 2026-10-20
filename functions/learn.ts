// The bare /learn (the course dashboard, dist/learn.html).
//
// functions/learn/_middleware.ts becomes the `/learn/*` rule in the generated _routes.json. Pages
// documents that rule as matching /learn too, but this file makes the bare path a Functions route
// in its own right, so it can never be served straight from the static files.
//
// Why one export per method rather than `onRequest`: wrangler merges a plain onRequest here with
// the middleware's onRequest (same path, same method) into one entry, and an entry with middleware
// only yields `/learn/*`. Method-specific exports stay separate entries and add `/learn` itself.
//
// The middleware has usually checked the cookie already; gate() then skips straight to the page.
import type { EnrollEnv } from "./_lib/enrollment";
import { gate } from "./learn/_gate";

const handler: PagesFunction<EnrollEnv> = (context) => gate(context);

export const onRequestGet = handler;
export const onRequestHead = handler;
export const onRequestPost = handler;
export const onRequestPut = handler;
export const onRequestPatch = handler;
export const onRequestDelete = handler;
export const onRequestOptions = handler;
