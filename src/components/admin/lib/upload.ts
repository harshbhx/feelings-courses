/**
 * Upload checks and progress wording for the admin. The rules mirror W4's (functions/_lib/media-rules.ts)
 * so a wrong file is refused before a single byte is sent; the server checks everything again.
 */
import type { MediaKind } from "../../../shared/types.ts";
import { roughDuration } from "./time.ts";

const MiB = 1024 * 1024;

export const UPLOAD_RULES: Record<MediaKind, { types: Record<string, string[]>; maxBytes: number; accept: string; hint: string }> = {
  video: {
    types: { "video/mp4": ["mp4", "m4v"], "video/webm": ["webm"] },
    maxBytes: 4 * 1024 * MiB,
    accept: "video/mp4,video/webm,.mp4,.m4v,.webm",
    hint: "MP4 or WebM, up to 4 GB.",
  },
  image: {
    types: { "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/webp": ["webp"] },
    maxBytes: 10 * MiB,
    accept: "image/jpeg,image/png,image/webp",
    hint: "JPEG, PNG or WebP, up to 10 MB.",
  },
  captions: {
    types: { "text/vtt": ["vtt"] },
    maxBytes: 1 * MiB,
    accept: "text/vtt,.vtt",
    hint: "A WebVTT (.vtt) file, up to 1 MB.",
  },
  file: { types: { "application/pdf": ["pdf"] }, maxBytes: 50 * MiB, accept: "application/pdf,.pdf", hint: "A PDF, up to 50 MB." },
};

export const extensionOf = (name: string) => (/\.([A-Za-z0-9]{1,8})$/.exec(name.trim())?.[1] ?? "").toLowerCase();

/**
 * The content type to declare for a file. Browsers leave `type` empty for some files (.vtt on
 * Windows, .m4v), so the extension decides then. Null when the file isn't allowed for `kind`.
 */
export function contentTypeFor(file: { name: string; type: string }, kind: MediaKind): string | null {
  const rule = UPLOAD_RULES[kind];
  const ext = extensionOf(file.name);
  const type = file.type.split(";")[0]!.trim().toLowerCase();
  if (type && rule.types[type]?.includes(ext)) return type;
  // A known extension with an empty or generic type (application/octet-stream, video/x-m4v…).
  for (const [t, exts] of Object.entries(rule.types)) if (exts.includes(ext)) return t;
  return null;
}

/** Why `file` can't be uploaded as `kind`, or null when it can. */
export function fileProblem(file: { name: string; type: string; size: number }, kind: MediaKind): string | null {
  const ext = extensionOf(file.name);
  if (kind === "video" && (ext === "mov" || file.type === "video/quicktime"))
    return "iPhone .mov videos often don't play on Android or Windows. Export or share it as MP4 first (Photos → Share → Save as MP4, or any converter).";
  if (!contentTypeFor(file, kind)) return `That file type can't be used here. ${UPLOAD_RULES[kind].hint}`;
  if (file.size <= 0) return "That file is empty.";
  if (file.size > UPLOAD_RULES[kind].maxBytes) return `That file is ${formatBytes(file.size)}. ${UPLOAD_RULES[kind].hint}`;
  return null;
}

/** 1.2 GB, 640 MB, 12 KB. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MiB) return `${(bytes / (1024 * MiB)).toFixed(bytes >= 10 * 1024 * MiB ? 0 : 1)} GB`;
  if (bytes >= MiB) return `${Math.round(bytes / MiB)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * A progress line: "42% · 260 MB of 610 MB · about 3 minutes left". Speed is measured from the
 * bytes sent in this session (`sessionStart` = bytes already on the server when it started), so a
 * resumed upload doesn't claim to be impossibly fast.
 */
export function progressText(sent: number, total: number, startedAtMs: number, nowMs: number, sessionStart = 0): string {
  const pct = total > 0 ? Math.floor((sent / total) * 100) : 0;
  let line = `${pct}% · ${formatBytes(sent)} of ${formatBytes(total)}`;
  const elapsed = (nowMs - startedAtMs) / 1000;
  const moved = sent - sessionStart;
  if (elapsed >= 3 && moved > 0 && sent < total) {
    const rate = moved / elapsed;
    line += ` · ${roughDuration((total - sent) / rate)} left`;
  }
  return line;
}

/** The R2 key's file name without the random prefix: "videos/2026/10/ab12…-soft-glam.mp4" → "soft-glam.mp4". */
export function keyName(key: string): string {
  const last = key.split("/").pop() ?? key;
  return last.replace(/^[0-9a-f]{16}-/, "");
}

/** The public URL of an uploaded image (W4 serves /media/i/<key>). */
export const imageUrl = (key: string) => `/media/i/${key.split("/").map(encodeURIComponent).join("/")}`;
