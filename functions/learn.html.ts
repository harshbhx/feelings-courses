// /learn.html, the dashboard's file name. Pages would redirect it to /learn, but neither the
// `/learn/*` rule nor the middleware matches it ("." is not a path separator), so it is gated here
// too rather than trusting that redirect. Lesson files (/learn/<slug>.html) are under /learn/* and
// go through the middleware.
import type { Env } from "./_lib/env.ts";
import { gate } from "./learn/_gate";

export const onRequest: PagesFunction<Env> = (context) => gate(context);
