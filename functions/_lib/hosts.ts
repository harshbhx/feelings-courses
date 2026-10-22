/**
 * Routing by Host (plan 1.3): course hosts (<slug>.feelingsbeautycare.in) are rewritten onto
 * /c/<slug>/, hub-only paths redirect to the hub, *.pages.dev gets noindex.
 *
 * W0 PLACEHOLDER, owned by W1: until W1 replaces the body, every request passes straight on, so
 * the site behaves exactly as before. The signature is frozen (functions/_middleware.ts calls it).
 */
import type { Env } from "./env.ts";

export interface MiddlewareContext {
  request: Request;
  env: Partial<Env>;
  data: Record<string, unknown>;
  next: () => Promise<Response>;
}

/** Routes the request by host; calls `next` for anything the hub serves as usual. */
export async function hostRouting(context: MiddlewareContext, next: () => Promise<Response>): Promise<Response> {
  return next();
}
