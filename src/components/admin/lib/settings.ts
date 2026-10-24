/** Settings checks that match the API: the GSTIN format and the admin password rules. */
import { GSTIN_RE } from "../../../shared/constants.ts";

/** null when the GSTIN is empty (it's optional) or valid. */
export function gstinProblem(value: string): string | null {
  const v = value.trim().toUpperCase();
  if (!v) return null;
  return GSTIN_RE.test(v) ? null : "Enter a 15-character GSTIN, like 24ABCDE1234F1Z5.";
}

/** Why a new admin password can't be used, or null. Same rules as functions/_lib/admin/auth.ts. */
export function passwordProblem(next: string, current: string, again: string): { field: "next" | "again"; message: string } | null {
  if (next.length < 14) return { field: "next", message: "Use at least 14 characters." };
  if (next.length > 200) return { field: "next", message: "Use at most 200 characters." };
  if (next.trim() !== next) return { field: "next", message: "The password can't start or end with a space." };
  if (new Set(next).size < 6) return { field: "next", message: "Use at least 6 different characters." };
  if (next === current) return { field: "next", message: "The new password must be different." };
  if (next !== again) return { field: "again", message: "The two new passwords don't match." };
  return null;
}
