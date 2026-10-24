/**
 * Errors the data layer throws. Expected business outcomes (a coupon that has expired, an order
 * that is already paid) are not errors: functions return `{ ok: false, reason }` for those.
 *
 * - ValidationError: the input is malformed (an endpoint answers 400 with `field` and `message`).
 * - ConflictError: a unique value is already taken, such as a course slug (an endpoint answers 409).
 */

export class ValidationError extends Error {
  readonly field: string;
  readonly code: string;

  constructor(field: string, message: string, code = "invalid") {
    super(message);
    this.name = "ValidationError";
    this.field = field;
    this.code = code;
  }
}

export class ConflictError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConflictError";
    this.code = code;
  }
}

/** The error's message, and its cause's (D1 sometimes wraps the SQLite error). */
function messages(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} ${cause.message}` : error.message;
}

/**
 * True for a UNIQUE (or PRIMARY KEY) violation. `target` narrows it to one column or index, as
 * SQLite names it: "courses.slug", or "coupon_redemptions.coupon_id" for a multi-column index.
 * Works with D1 ("D1_ERROR: UNIQUE constraint failed: courses.slug: SQLITE_CONSTRAINT") and node:sqlite.
 */
export function isUniqueViolation(error: unknown, target?: string): boolean {
  const text = messages(error);
  if (!/(UNIQUE|PRIMARY KEY) constraint failed/i.test(text)) return false;
  return target === undefined || text.includes(target);
}

/** True for a CHECK constraint violation. */
export function isCheckViolation(error: unknown): boolean {
  return /CHECK constraint failed/i.test(messages(error));
}

/** True for a FOREIGN KEY violation (a referenced row is missing, or still referenced). */
export function isForeignKeyViolation(error: unknown): boolean {
  return /FOREIGN KEY constraint failed/i.test(messages(error));
}
