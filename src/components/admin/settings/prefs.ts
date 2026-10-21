/**
 * Settings (DEMO): the notification choices and the "Reset demo data" sweep. Used by the Astro
 * components (at build time, for the defaults) and by settings.ts in the browser.
 */
import { SESSION_KEY } from "../../../lib/demo-store";

/** Notification choices are saved here. Like every admin demo key, it starts with DEMO_PREFIX. */
export const PREFS_KEY = "fbc-admin-demo-settings-v1";

/** Every admin demo key in localStorage starts with this (see src/components/admin/README.md).
 *  The demo sign-in flag (SESSION_KEY, sessionStorage) does too; reset leaves it alone. */
export const DEMO_PREFIX = "fbc-admin-demo-";

export interface NotifyOption {
  key: string;
  title: string;
  text: string;
  on: boolean;
}

export const NOTIFY: NotifyOption[] = [
  { key: "sale", title: "New sale", text: "A message each time someone buys a course.", on: true },
  { key: "failed", title: "Failed payment", text: "When a payment fails, so you can help the buyer finish.", on: true },
  { key: "coupon", title: "Weekly coupon report", text: "Which code sold the most this week.", on: true },
  { key: "daily", title: "Daily summary", text: "The day's sales and visitors, at 9 pm.", on: false },
  { key: "finished", title: "Course finished", text: "When a student completes every lesson.", on: false },
];

export type Prefs = Record<string, boolean>;

export const defaultPrefs = (): Prefs => Object.fromEntries(NOTIFY.map((n) => [n.key, n.on]));

let memory: Prefs | null = null;

export function loadPrefs(): Prefs {
  if (memory) return { ...memory };
  const prefs = defaultPrefs();
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const saved: unknown = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === "object") {
      for (const n of NOTIFY) {
        const v = (saved as Record<string, unknown>)[n.key];
        if (typeof v === "boolean") prefs[n.key] = v;
      }
    }
  } catch {
    /* blocked or unreadable: the defaults */
  }
  memory = prefs;
  return { ...prefs };
}

/** Saves the choices. False when the browser blocks storage (they last until the page is left). */
export function savePrefs(prefs: Prefs): boolean {
  memory = { ...prefs };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

/** The admin demo's saved keys on this browser (localStorage, plus sessionStorage but sign-in). */
export function demoKeys(): { local: string[]; session: string[] } {
  const local: string[] = [];
  const session: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(DEMO_PREFIX)) local.push(key);
    }
  } catch {
    /* blocked: nothing saved */
  }
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(DEMO_PREFIX) && key !== SESSION_KEY) session.push(key);
    }
  } catch {
    /* blocked */
  }
  return { local, session };
}

/** Removes every admin demo key (every screen's, not only Settings'). Keeps the sign-in. */
export function clearDemoKeys(): number {
  const { local, session } = demoKeys();
  for (const key of local) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* blocked */
    }
  }
  for (const key of session) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* blocked */
    }
  }
  memory = null;
  return local.length + session.length;
}
