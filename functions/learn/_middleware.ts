// Gates the course area: every request under /learn must carry a valid enrollment cookie.
// Pages runs this for /learn/* and, as wrangler's routing documents it, for /learn too;
// functions/learn.ts and functions/learn.html.ts make sure of the bare path and its .html twin.
import type { EnrollEnv } from "../_lib/enrollment";
import { learnMiddleware } from "./_gate";

export const onRequest: PagesFunction<EnrollEnv> = (context) => learnMiddleware(context);
