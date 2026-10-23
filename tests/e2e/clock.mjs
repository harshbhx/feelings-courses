// The e2e server's clock. Imported first by server.mjs, so every Date the Functions create follows
// it: `advance(seconds)` moves "now" forward (the 24-hour refund window, sign-in link expiry,
// rate-limit windows) without waiting. Time still flows normally between advances.

const RealDate = globalThis.Date;
let offsetMs = 0;

class E2EDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + offsetMs);
    else super(...args);
  }
  static now() {
    return RealDate.now() + offsetMs;
  }
}

globalThis.Date = E2EDate;

export const clock = {
  /** Unix seconds, as the Functions see it. */
  now: () => Math.floor(E2EDate.now() / 1000),
  advance(seconds) {
    offsetMs += Math.round(seconds * 1000);
    return clock.now();
  },
};
