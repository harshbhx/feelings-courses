/**
 * Marks a W0 stub: a module whose signature is frozen by the foundation and whose body belongs to
 * a later workstream. Calling one throws NotImplementedError (http.ts answers 501).
 * The integration PR removes every reachable stub (plan 7.2 step 9).
 */
export class NotImplementedError extends Error {
  readonly owner: string;
  constructor(what: string, owner: string) {
    super(`not implemented: ${what} (owner ${owner})`);
    this.name = "NotImplementedError";
    this.owner = owner;
  }
}

export function notImplemented(what: string, owner: string): never {
  throw new NotImplementedError(what, owner);
}

/** The part of a Pages EventContext that background work needs. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}
