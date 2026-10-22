/**
 * Resumable uploads from the admin to R2 (W4), for the admin UI (W6).
 *
 *   const item = await uploadMedia(file, { kind: "video", lessonId: 12, onProgress: (sent, total) => … });
 *
 * - Splits the file into the server's parts (10 MiB) and sends up to 3 at a time.
 * - Remembers the upload in localStorage ({ id, key, uploadId, etags }) under a fingerprint of
 *   the file (name, size, last modified, kind, lesson). Picking the same file again after a dropped
 *   connection, a reload or a closed laptop sends only the parts the server hasn't confirmed.
 * - Retries a part on network errors, 408, 429 and 5xx with growing waits; other errors stop.
 * - If the server has forgotten the upload (cancelled, or aborted by the daily cleanup after a
 *   day), starts again from zero once.
 * - `signal` pauses: the saved state stays, so the next call resumes.
 */
import type { MediaItem, MediaKind, UploadInit } from "../shared/types.ts";
import { api, ApiError } from "./api-client.ts";

/** A File, or anything with the same shape (tests use a Blob with a name). */
export interface UploadSource {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly lastModified?: number;
  slice(start?: number, end?: number, contentType?: string): Blob;
}

export interface UploadOptions {
  kind: MediaKind;
  lessonId?: number;
  /** Parts in flight at once (default 3). */
  concurrency?: number;
  /** Attempts per part before giving up (default 6). */
  attempts?: number;
  /** Called after each confirmed part with bytes confirmed so far and the total. */
  onProgress?: (sent: number, total: number) => void;
  /** Abort to pause; the next uploadMedia() with the same file resumes. */
  signal?: AbortSignal;
  /** Where the resume state lives (default localStorage when available). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** For tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SavedUpload {
  v: 1;
  id: number;
  key: string;
  uploadId: string;
  partSize: number;
  size: number;
  /** partNumber → etag, for parts the server confirmed. */
  etags: Record<string, string>;
}

const PART_TIMEOUT_MS = 5 * 60_000;
const STORAGE_PREFIX = "fbc-upload:";

/** The localStorage key for this file and destination. */
export function uploadFingerprint(file: UploadSource, kind: MediaKind, lessonId?: number): string {
  return `${STORAGE_PREFIX}${kind}:${lessonId ?? "-"}:${file.size}:${file.lastModified ?? 0}:${file.name}`;
}

function defaultStorage(): UploadOptions["storage"] {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function load(storage: UploadOptions["storage"], key: string, size: number): SavedUpload | null {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return null;
    const saved = JSON.parse(raw) as SavedUpload;
    if (saved?.v !== 1 || saved.size !== size || !Number.isInteger(saved.id) || !saved.partSize || typeof saved.etags !== "object") return null;
    return saved;
  } catch {
    return null;
  }
}

function save(storage: UploadOptions["storage"], key: string, state: SavedUpload): void {
  try {
    storage?.setItem(key, JSON.stringify(state));
  } catch {
    /* storage full or blocked: the upload still works, it just can't resume */
  }
}

function forget(storage: UploadOptions["storage"], key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Whether an error is worth retrying (network, timeout, rate limit, server error). */
export function isRetryable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false;
  return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
}

/** The server no longer has this upload: start over. */
function isGone(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || (err.status === 409 && err.code === "conflict"));
}

function partSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(PART_TIMEOUT_MS);
  if (!signal) return timeout;
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return any ? any([signal, timeout]) : signal;
}

class Paused extends Error {
  constructor() {
    super("Upload paused.");
    this.name = "AbortError";
  }
}

/** Uploads (or resumes) `file` and returns the finished MediaItem. */
export async function uploadMedia(file: UploadSource, options: UploadOptions): Promise<MediaItem> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const fingerprint = uploadFingerprint(file, options.kind, options.lessonId);
  try {
    return await attempt(file, options, storage, fingerprint);
  } catch (err) {
    if (!isGone(err) || !load(storage, fingerprint, file.size)) throw err;
    forget(storage, fingerprint);
    return attempt(file, options, storage, fingerprint);
  }
}

async function start(file: UploadSource, options: UploadOptions): Promise<UploadInit> {
  return api<UploadInit>("/api/admin/uploads", {
    method: "POST",
    json: {
      kind: options.kind,
      ...(options.lessonId !== undefined ? { lessonId: options.lessonId } : {}),
      filename: file.name,
      size: file.size,
      contentType: file.type,
    },
    signal: options.signal,
  });
}

async function attempt(file: UploadSource, options: UploadOptions, storage: UploadOptions["storage"], fingerprint: string): Promise<MediaItem> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let state = load(storage, fingerprint, file.size);
  if (!state) {
    const init = await start(file, options);
    state = { v: 1, id: init.id, key: init.key, uploadId: init.uploadId, partSize: init.partSize, size: file.size, etags: {} };
    save(storage, fingerprint, state);
  }
  const current = state;
  const count = Math.ceil(file.size / current.partSize);
  const partBytes = (n: number) => Math.min(current.partSize, file.size - (n - 1) * current.partSize);
  let sent = 0;
  for (let n = 1; n <= count; n++) if (current.etags[n]) sent += partBytes(n);
  options.onProgress?.(sent, file.size);

  const queue: number[] = [];
  for (let n = 1; n <= count; n++) if (!current.etags[n]) queue.push(n);

  /** Runs `fn` until it succeeds, retrying network errors, 408, 429 and 5xx with growing waits. */
  const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
    const attempts = Math.max(1, options.attempts ?? 6);
    for (let i = 1; ; i++) {
      if (options.signal?.aborted) throw new Paused();
      try {
        return await fn();
      } catch (err) {
        if (options.signal?.aborted) throw new Paused();
        if (!isRetryable(err) || i >= attempts) throw err;
        const retryAfter = err instanceof ApiError && err.retryAfter ? err.retryAfter * 1000 : 0;
        await sleep(Math.max(retryAfter, Math.min(30_000, 1000 * 2 ** (i - 1))));
      }
    }
  };

  const sendPart = async (n: number): Promise<void> => {
    const start = (n - 1) * current.partSize;
    const res = await withRetry(() =>
      api<{ etag: string }>(`/api/admin/uploads/${current.id}/parts/${n}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: file.slice(start, start + partBytes(n)),
        signal: partSignal(options.signal),
      }),
    );
    current.etags[n] = res.etag;
    save(storage, fingerprint, current);
    sent += partBytes(n);
    options.onProgress?.(sent, file.size);
  };

  const workers = Array.from({ length: Math.min(Math.max(1, options.concurrency ?? 3), queue.length) }, async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) await sendPart(n);
  });
  await Promise.all(workers);

  const parts = Array.from({ length: count }, (_, i) => ({ partNumber: i + 1, etag: current.etags[i + 1]! }));
  // complete is idempotent on the server, so a lost answer is simply asked again.
  const item = await withRetry(() =>
    api<MediaItem>(`/api/admin/uploads/${current.id}/complete`, { method: "POST", json: { parts }, signal: options.signal }),
  );
  forget(storage, fingerprint);
  return item;
}

/** Cancels an upload (or deletes a finished file) and forgets its resume state. */
export async function cancelUpload(file: UploadSource, options: Pick<UploadOptions, "kind" | "lessonId" | "storage">): Promise<void> {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const fingerprint = uploadFingerprint(file, options.kind, options.lessonId);
  const state = load(storage, fingerprint, file.size);
  if (state) await api<void>(`/api/admin/uploads/${state.id}`, { method: "DELETE" });
  forget(storage, fingerprint);
}
