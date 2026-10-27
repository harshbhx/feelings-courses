// An in-memory Cloudflare R2Bucket stand-in, for tests.
//
//   import { FakeR2, createFakeR2 } from "../helpers/r2.mjs";
//   const bucket = createFakeR2({ minPartSize: 4 });       // small parts allowed in multipart tests
//   await bucket.put("videos/a.mp4", "hello", { httpMetadata: { contentType: "video/mp4" } });
//   const obj = await bucket.get("videos/a.mp4", { range: request.headers, onlyIf: request.headers });
//   if (obj && "body" in obj) return new Response(obj.body, { status: obj.range ? 206 : 200 });
//   bucket.objects.get("videos/a.mp4");                    // stored record, for assertions
//
// It implements the R2Bucket API as typed in @cloudflare/workers-types, with R2's rules:
// - put(key, value, { httpMetadata, customMetadata, onlyIf }) takes string / ArrayBuffer / typed
//   array / ReadableStream / Blob / null and returns an R2Object (null if onlyIf fails);
// - get(key, { range, onlyIf }) returns an R2ObjectBody, null when missing, or an R2Object WITHOUT
//   a `body` property when the precondition fails (as real R2 does);
// - range: { offset, length } | { offset } | { length } | { suffix } | Headers ("Range: bytes=a-b",
//   "bytes=a-", "bytes=-n"); the returned object's `range` is the resolved { offset, length };
//   an offset at/after the end throws (R2 error 10039, range not satisfiable);
// - onlyIf: { etagMatches, etagDoesNotMatch, uploadedBefore, uploadedAfter } | Headers
//   (If-Match, If-None-Match, If-Modified-Since, If-Unmodified-Since);
// - etag = hex md5 of the content, httpEtag = the quoted etag;
// - list({ prefix, limit, cursor, delimiter, include }) sorted by key, with an opaque cursor;
// - multipart: createMultipartUpload / resumeMultipartUpload → { key, uploadId, uploadPart,
//   abort, complete }; complete() checks every part exists (and its etag) and that every part but
//   the last is at least `minPartSize` (default 5 MiB); finished or aborted uploads throw on use.
//
// `bucket.objects` (Map key → record) and `bucket.uploads` (Map uploadId → upload) are exposed.

import { createHash, randomUUID } from "node:crypto";

const MiB = 1024 * 1024;

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");
const unquote = (etag) => String(etag).trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");

/** Reads any supported R2 value into a fresh Uint8Array. */
async function toBytes(value) {
  if (value === null || value === undefined) return new Uint8Array(0);
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (typeof Blob !== "undefined" && value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  throw new TypeError(`FakeR2: unsupported value type ${Object.prototype.toString.call(value)}`);
}

/** Accepts R2HTTPMetadata or a Headers object (R2 accepts both on put). */
function normalizeHttpMetadata(meta) {
  if (!meta) return {};
  if (meta instanceof Headers) {
    const out = {};
    const map = {
      "content-type": "contentType",
      "content-language": "contentLanguage",
      "content-disposition": "contentDisposition",
      "content-encoding": "contentEncoding",
      "cache-control": "cacheControl",
      expires: "cacheExpiry",
    };
    for (const [header, field] of Object.entries(map)) {
      const v = meta.get(header);
      if (v !== null) out[field] = field === "cacheExpiry" ? new Date(v) : v;
    }
    return out;
  }
  return { ...meta };
}

/** Parses a `Range: bytes=...` header into an R2Range, or undefined when absent/unsupported. */
function rangeFromHeaders(headers) {
  const value = headers.get("range");
  if (!value) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!m || (m[1] === "" && m[2] === "")) throw new Error(`FakeR2: invalid Range header "${value}" (10039)`);
  if (m[1] === "") return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (m[2] === "") return { offset };
  const end = Number(m[2]);
  if (end < offset) throw new Error(`FakeR2: invalid Range header "${value}" (10039)`);
  return { offset, length: end - offset + 1 };
}

/** Resolves an R2Range against an object size into { offset, length }. */
function resolveRange(range, size) {
  if ("suffix" in range && range.suffix !== undefined) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  if (offset < 0 || (offset >= size && size > 0) || (size === 0 && offset > 0)) {
    throw new Error("FakeR2: get: The requested range is not satisfiable (10039)");
  }
  const length = Math.min(range.length ?? size - offset, size - offset);
  return { offset, length };
}

/** Turns If-* request headers into an R2Conditional (seconds granularity, as HTTP dates are). */
function conditionalFromHeaders(headers) {
  const cond = { secondsGranularity: true };
  const ifMatch = headers.get("if-match");
  const ifNoneMatch = headers.get("if-none-match");
  const ifModifiedSince = headers.get("if-modified-since");
  const ifUnmodifiedSince = headers.get("if-unmodified-since");
  if (ifMatch) cond.etagMatches = ifMatch;
  if (ifNoneMatch) cond.etagDoesNotMatch = ifNoneMatch;
  // HTTP: If-Modified-Since is ignored when If-None-Match is present.
  if (ifModifiedSince && !ifNoneMatch) cond.uploadedAfter = new Date(ifModifiedSince);
  if (ifUnmodifiedSince && !ifMatch) cond.uploadedBefore = new Date(ifUnmodifiedSince);
  return cond;
}

/** Does `etag` match an etag list such as `"abc", W/"def"` or `*`? */
function etagListMatches(list, etag) {
  return String(list)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((candidate) => candidate === "*" || unquote(candidate) === etag);
}

/** True when the precondition holds for the record. */
function conditionPasses(onlyIf, record) {
  if (!onlyIf) return true;
  const cond = onlyIf instanceof Headers ? conditionalFromHeaders(onlyIf) : onlyIf;
  const trunc = (d) => (cond.secondsGranularity ? Math.floor(new Date(d).getTime() / 1000) * 1000 : new Date(d).getTime());
  const uploaded = trunc(record.uploaded);
  if (cond.etagMatches !== undefined && !etagListMatches(cond.etagMatches, record.etag)) return false;
  if (cond.etagDoesNotMatch !== undefined && etagListMatches(cond.etagDoesNotMatch, record.etag)) return false;
  if (cond.uploadedBefore !== undefined && !(uploaded < trunc(cond.uploadedBefore) || (cond.secondsGranularity && uploaded <= trunc(cond.uploadedBefore)))) return false;
  if (cond.uploadedAfter !== undefined && !(uploaded > trunc(cond.uploadedAfter))) return false;
  return true;
}

function writeHttpMetadata(httpMetadata, headers) {
  const m = httpMetadata ?? {};
  if (m.contentType) headers.set("content-type", m.contentType);
  if (m.contentLanguage) headers.set("content-language", m.contentLanguage);
  if (m.contentDisposition) headers.set("content-disposition", m.contentDisposition);
  if (m.contentEncoding) headers.set("content-encoding", m.contentEncoding);
  if (m.cacheControl) headers.set("cache-control", m.cacheControl);
  if (m.cacheExpiry) headers.set("expires", new Date(m.cacheExpiry).toUTCString());
}

/** An R2Object (metadata only) built from a stored record. */
function makeObject(record, { includeHttp = true, includeCustom = true } = {}) {
  const httpMetadata = includeHttp ? { ...record.httpMetadata } : {};
  return {
    key: record.key,
    version: record.version,
    size: record.size,
    etag: record.etag,
    httpEtag: `"${record.etag}"`,
    checksums: { md5: Buffer.from(record.etag, "hex").buffer },
    uploaded: new Date(record.uploaded),
    httpMetadata,
    customMetadata: includeCustom ? { ...record.customMetadata } : {},
    storageClass: "Standard",
    writeHttpMetadata(headers) {
      writeHttpMetadata(httpMetadata, headers);
    },
  };
}

/** An R2ObjectBody: metadata plus a one-shot body (backed by a Response for bodyUsed semantics). */
function makeObjectBody(record, range) {
  const obj = makeObject(record);
  const resolved = range ? resolveRange(range, record.size) : undefined;
  const bytes = resolved ? record.bytes.slice(resolved.offset, resolved.offset + resolved.length) : record.bytes.slice();
  const response = new Response(bytes);
  return Object.assign(obj, {
    range: resolved,
    get body() {
      return response.body;
    },
    get bodyUsed() {
      return response.bodyUsed;
    },
    arrayBuffer: () => response.arrayBuffer(),
    bytes: async () => new Uint8Array(await response.arrayBuffer()),
    text: () => response.text(),
    json: () => response.json(),
    blob: () => response.blob(),
  });
}

export class FakeR2 {
  /** @param {{ minPartSize?: number, now?: () => Date }} [options] */
  constructor({ minPartSize = 5 * MiB, now = () => new Date() } = {}) {
    this.minPartSize = minPartSize;
    this.now = now;
    /** @type {Map<string, {key, bytes: Uint8Array, size, etag, version, uploaded: Date, httpMetadata, customMetadata}>} */
    this.objects = new Map();
    /** @type {Map<string, {key, uploadId, parts: Map<number, {etag, bytes}>, httpMetadata, customMetadata}>} */
    this.uploads = new Map();
  }

  _store(key, bytes, httpMetadata, customMetadata, etag = md5(bytes)) {
    const record = {
      key,
      bytes,
      size: bytes.byteLength,
      etag,
      version: randomUUID().replaceAll("-", ""),
      uploaded: this.now(),
      httpMetadata: normalizeHttpMetadata(httpMetadata),
      customMetadata: { ...(customMetadata ?? {}) },
    };
    this.objects.set(key, record);
    return record;
  }

  async head(key) {
    const record = this.objects.get(key);
    return record ? makeObject(record) : null;
  }

  async get(key, options = {}) {
    const record = this.objects.get(key);
    if (!record) return null;
    if (!conditionPasses(options.onlyIf, record)) return makeObject(record); // no `body` property
    let range = options.range;
    if (range instanceof Headers) range = rangeFromHeaders(range);
    return makeObjectBody(record, range);
  }

  async put(key, value, options = {}) {
    const existing = this.objects.get(key);
    if (options.onlyIf && existing && !conditionPasses(options.onlyIf, existing)) return null;
    const bytes = await toBytes(value);
    return makeObject(this._store(key, bytes, options.httpMetadata, options.customMetadata));
  }

  async delete(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }

  async list(options = {}) {
    const { prefix = "", limit = 1000, cursor, delimiter, include = [] } = options;
    let keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (cursor) {
      const after = Buffer.from(cursor, "base64url").toString("utf8");
      keys = keys.filter((k) => k > after);
    }
    const objects = [];
    const delimitedPrefixes = [];
    let lastKey;
    for (const key of keys) {
      if (objects.length + delimitedPrefixes.length >= limit) break;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i !== -1) {
          const p = prefix + rest.slice(0, i + delimiter.length);
          if (!delimitedPrefixes.includes(p)) delimitedPrefixes.push(p);
          lastKey = key;
          continue;
        }
      }
      objects.push(
        makeObject(this.objects.get(key), {
          includeHttp: include.includes("httpMetadata"),
          includeCustom: include.includes("customMetadata"),
        }),
      );
      lastKey = key;
    }
    const truncated = lastKey !== undefined && keys.some((k) => k > lastKey && !(delimiter && delimitedPrefixes.some((p) => k.startsWith(p))));
    const result = { objects, truncated, delimitedPrefixes };
    if (truncated) result.cursor = Buffer.from(lastKey, "utf8").toString("base64url");
    return result;
  }

  async createMultipartUpload(key, options = {}) {
    const uploadId = `fake-upload-${randomUUID()}`;
    this.uploads.set(uploadId, {
      key,
      uploadId,
      parts: new Map(),
      httpMetadata: normalizeHttpMetadata(options.httpMetadata),
      customMetadata: { ...(options.customMetadata ?? {}) },
    });
    return this._multipart(key, uploadId);
  }

  resumeMultipartUpload(key, uploadId) {
    // Like real R2, resuming does not validate; using an unknown upload id throws.
    return this._multipart(key, uploadId);
  }

  _openUpload(key, uploadId) {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.key !== key) {
      throw new Error(`FakeR2: The specified multipart upload does not exist (10024): ${uploadId}`);
    }
    return upload;
  }

  _multipart(key, uploadId) {
    const bucket = this;
    return {
      key,
      uploadId,
      async uploadPart(partNumber, value) {
        const upload = bucket._openUpload(key, uploadId);
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
          throw new Error(`FakeR2: invalid part number ${partNumber}`);
        }
        const bytes = await toBytes(value);
        const etag = md5(bytes);
        upload.parts.set(partNumber, { etag, bytes });
        return { partNumber, etag };
      },
      async abort() {
        bucket._openUpload(key, uploadId);
        bucket.uploads.delete(uploadId);
      },
      async complete(parts) {
        const upload = bucket._openUpload(key, uploadId);
        if (!Array.isArray(parts) || parts.length === 0) throw new Error("FakeR2: complete() needs at least one part");
        const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        const chunks = sorted.map(({ partNumber, etag }, i) => {
          const part = upload.parts.get(partNumber);
          if (!part) throw new Error(`FakeR2: part ${partNumber} was not uploaded (10025)`);
          if (etag !== undefined && unquote(etag) !== part.etag) throw new Error(`FakeR2: part ${partNumber} etag mismatch (10025)`);
          if (i < sorted.length - 1 && part.bytes.byteLength < bucket.minPartSize) {
            throw new Error(`FakeR2: part ${partNumber} is smaller than the minimum part size (10011)`);
          }
          return part.bytes;
        });
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.byteLength;
        }
        bucket.uploads.delete(uploadId);
        return makeObject(bucket._store(key, bytes, upload.httpMetadata, upload.customMetadata));
      },
    };
  }
}

/** @param {{ minPartSize?: number, now?: () => Date }} [options] */
export const createFakeR2 = (options) => new FakeR2(options);
