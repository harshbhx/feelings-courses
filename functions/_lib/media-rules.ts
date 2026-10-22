/**
 * What the admin may upload (W4): the content types, extensions and sizes allowed per media kind,
 * the R2 key each upload gets, the multipart part plan, and a check of the file's first bytes.
 *
 * Pure functions, no bindings: used by functions/_lib/uploads.ts and by the tests.
 *
 * Why these types only:
 * - video: MP4 (H.264/AAC) and WebM play in every browser the students use. QuickTime .mov
 *   (the iPhone default) is refused with a clear message: it often won't play on Android or Windows.
 * - image: JPEG, PNG, WebP. Never SVG (it can carry scripts).
 * - captions: WebVTT, the only format <track> reads.
 * - file: PDF (lesson notes).
 */
import { UPLOAD_PART_SIZE } from "./config.ts";
import { extensionOf, MEDIA_FILE_TYPES, MEDIA_MAX_BYTES } from "../../src/shared/constants.ts";
import { ValidationError } from "./db/errors.ts";
import type { MediaKind } from "../../src/shared/types.ts";

const MiB = 1024 * 1024;

export interface KindRule {
  /** Content type → allowed file extensions (lowercase, without the dot). */
  types: Readonly<Record<string, readonly string[]>>;
  maxBytes: number;
  /** R2 key prefix. Never "backups/" (W7's dumps live there and are never served). */
  prefix: string;
  /** Shown when the type is refused. */
  hint: string;
}

export const MEDIA_RULES: Readonly<Record<MediaKind, KindRule>> = {
  video: {
    types: MEDIA_FILE_TYPES.video,
    maxBytes: MEDIA_MAX_BYTES.video,
    prefix: "videos",
    hint: "Upload an MP4 or WebM video. iPhone .mov files: export or share them as MP4 first.",
  },
  image: {
    types: MEDIA_FILE_TYPES.image,
    maxBytes: MEDIA_MAX_BYTES.image,
    prefix: "images",
    hint: "Upload a JPEG, PNG or WebP image.",
  },
  captions: {
    types: MEDIA_FILE_TYPES.captions,
    maxBytes: MEDIA_MAX_BYTES.captions,
    prefix: "captions",
    hint: "Upload captions as a WebVTT (.vtt) file.",
  },
  file: {
    types: MEDIA_FILE_TYPES.file,
    maxBytes: MEDIA_MAX_BYTES.file,
    prefix: "files",
    hint: "Upload a PDF.",
  },
};

export const MEDIA_KINDS = Object.keys(MEDIA_RULES) as MediaKind[];

/** Every key W4 creates: <prefix>/<yyyy>/<mm>/<16 hex>-<name>.<ext>. */
export const MEDIA_KEY_RE = /^(videos|images|captions|files)\/\d{4}\/\d{2}\/[0-9a-f]{16}-[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?\.[a-z0-9]{2,5}$/;

/** "video/mp4; codecs=..." → "video/mp4"; lowercased. */
export function baseContentType(value: string): string {
  return value.split(";")[0]!.trim().toLowerCase();
}

/** The file extension of a name, lowercase, or "" (one definition in src/shared/constants.ts). */
export { extensionOf };

/** A filename made safe for a key: ascii letters, digits and dashes, at most 60 characters. */
export function safeBaseName(filename: string): string {
  const base = filename.trim().replace(/\.[A-Za-z0-9]{1,8}$/, "");
  const ascii = base
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return ascii || "file";
}

export interface UploadPlan {
  kind: MediaKind;
  contentType: string;
  ext: string;
  size: number;
  originalName: string;
  partSize: number;
  partCount: number;
}

/**
 * Checks an upload request (kind, filename, size, content type) against MEDIA_RULES. Throws
 * ValidationError with field and code: "upload_invalid", or "upload_too_large" for the size.
 */
export function planUpload(input: { kind: unknown; filename: unknown; size: unknown; contentType: unknown }, partSize = UPLOAD_PART_SIZE): UploadPlan {
  if (typeof input.kind !== "string" || !(MEDIA_KINDS as string[]).includes(input.kind)) {
    throw new ValidationError("kind", "Choose what you are uploading: video, image, captions or file.", "upload_invalid");
  }
  const kind = input.kind as MediaKind;
  const rule = MEDIA_RULES[kind];
  if (typeof input.filename !== "string" || input.filename.trim().length < 1 || input.filename.length > 200 || /[\u0000-\u001f\u007f]/.test(input.filename)) {
    throw new ValidationError("filename", "The file name is missing or too long (200 characters at most).", "upload_invalid");
  }
  const originalName = input.filename.trim();
  if (typeof input.size !== "number" || !Number.isSafeInteger(input.size) || input.size < 1) {
    throw new ValidationError("size", "The file is empty.", "upload_invalid");
  }
  if (input.size > rule.maxBytes) {
    throw new ValidationError("size", `This file is too large. The limit for a ${kind} is ${formatBytes(rule.maxBytes)}.`, "upload_too_large");
  }
  const contentType = typeof input.contentType === "string" ? baseContentType(input.contentType) : "";
  const ext = extensionOf(originalName);
  if (kind === "video" && (contentType === "video/quicktime" || ext === "mov")) {
    throw new ValidationError("contentType", rule.hint, "upload_invalid");
  }
  const allowedExts = rule.types[contentType];
  if (!allowedExts) throw new ValidationError("contentType", rule.hint, "upload_invalid");
  if (!allowedExts.includes(ext)) {
    throw new ValidationError("filename", `The file name should end in .${allowedExts.join(" or .")} for this type.`, "upload_invalid");
  }
  if (!Number.isSafeInteger(partSize) || partSize < 5 * MiB) throw new Error("partSize must be at least 5 MiB (R2's minimum)");
  const partCount = Math.ceil(input.size / partSize);
  if (partCount > 10_000) throw new ValidationError("size", "This file is too large.", "upload_too_large");
  return { kind, contentType, ext: allowedExts[0] === "jpg" && ext === "jpeg" ? "jpg" : ext, size: input.size, originalName, partSize, partCount };
}

/** The exact byte length part `partNumber` (1-based) must have. R2 needs equal parts except the last. */
export function expectedPartSize(size: number, partSize: number, partNumber: number): number | null {
  const count = Math.ceil(size / partSize);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count) return null;
  return partNumber < count ? partSize : size - (count - 1) * partSize;
}

/** A new R2 key for the upload. `random` is 16 lowercase hex characters. */
export function mediaKey(plan: Pick<UploadPlan, "kind" | "originalName" | "ext">, now: number, random: string): string {
  if (!/^[0-9a-f]{16}$/.test(random)) throw new Error("random must be 16 hex characters");
  const d = new Date(now * 1000);
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${MEDIA_RULES[plan.kind].prefix}/${yyyy}/${mm}/${random}-${safeBaseName(plan.originalName)}.${plan.ext}`;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let out = "";
  for (let i = start; i < start + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/**
 * Checks that the file's first bytes match its declared type (so a renamed .exe or an HTML page
 * can't be stored as a "video"). Returns null when they match, else a message for the admin.
 * `bytes` is the first part of the upload (at least the first 16 bytes, or the whole file).
 */
export function sniffMismatch(contentType: string, bytes: Uint8Array): string | null {
  const type = baseContentType(contentType);
  switch (type) {
    case "video/mp4": {
      if (ascii(bytes, 4, 4) !== "ftyp") return "This file is not an MP4 video.";
      const brand = ascii(bytes, 8, 4);
      if (brand === "qt  ") return MEDIA_RULES.video.hint;
      return null;
    }
    case "video/webm":
      return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 ? null : "This file is not a WebM video.";
    case "image/jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? null : "This file is not a JPEG image.";
    case "image/png":
      return ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n" ? null : "This file is not a PNG image.";
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP" ? null : "This file is not a WebP image.";
    case "application/pdf":
      return ascii(bytes, 0, 5) === "%PDF-" ? null : "This file is not a PDF.";
    case "text/vtt": {
      const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
      if (ascii(bytes, start, 6) !== "WEBVTT") return "Captions must be a WebVTT file (it starts with WEBVTT).";
      const after = bytes[start + 6];
      if (after !== undefined && after !== 0x0a && after !== 0x0d && after !== 0x20 && after !== 0x09) {
        return "Captions must be a WebVTT file (it starts with WEBVTT).";
      }
      try {
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
      } catch {
        return "Captions must be saved as UTF-8 text.";
      }
      return null;
    }
    default:
      return "This file type is not allowed.";
  }
}

/** The content type to serve for a stored object, by kind, when R2 has none recorded. */
export function fallbackContentType(kind: "v" | "c" | "i"): string {
  return kind === "c" ? "text/vtt; charset=utf-8" : kind === "v" ? "video/mp4" : "application/octet-stream";
}

/** 4294967296 → "4 GB" (the admin reads it). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * MiB) return `${Math.round((bytes / (1024 * MiB)) * 10) / 10} GB`;
  if (bytes >= MiB) return `${Math.round((bytes / MiB) * 10) / 10} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
