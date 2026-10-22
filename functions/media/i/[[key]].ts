// GET/HEAD /media/i/<key> : a course image the admin uploaded (public, W4).
import type { Env } from "../../_lib/env.ts";
import { serveImage } from "../../_lib/media-serve.ts";

export const onRequest: PagesFunction<Env> = ({ request, env }) => serveImage(env, request);
