# Media on R2 (W4)

Recorded lessons, captions, course images and PDFs live in the R2 bucket bound as `MEDIA`. No Cloudflare Stream: R2 storage and reads stay in the free tier, and Functions serve the bytes.

## Keys

`<prefix>/<yyyy>/<mm>/<16 hex>-<name>.<ext>`, made by `media-rules.ts mediaKey()`:

| Kind | Prefix | Types | Max size |
|---|---|---|---|
| video | `videos/` | MP4 (`.mp4`, `.m4v`), WebM | 4 GB (`MAX_UPLOAD_BYTES`) |
| image | `images/` | JPEG, PNG, WebP (never SVG) | 10 MB |
| captions | `captions/` | WebVTT | 1 MB |
| file | `files/` | PDF | 50 MB |

QuickTime `.mov` (the iPhone default) is refused with a hint to export as MP4: it often won't play on Android or Windows. W7's backups live under `backups/` and no media route can reach them (`MEDIA_KEY_RE`).

## Playback

1. W3's `GET /api/learn/:slug/lessons/:lessonId/play` calls `requireEnrollment()` and then `playLesson(env, enrollment, lessonId)`, which returns `PlayInfo`: signed `src` (and `captions`), `expiresAt`, `resumeAt`, and the `watermark` (name and masked phone).
2. Links look like `/media/v/12?e=<exp>&s=<sidTag>&sig=<hmac>`; `sig = HMAC-SHA256(APP_SECRET, "v|12|<exp>|<sidTag>")`. They last 2 hours (`MEDIA_URL_TTL`) and can't be signed for longer.
3. `functions/media/v/[lessonId].ts` and `functions/media/c/[lessonId].ts` (`media-serve.ts`) check, in order:
   - GET or HEAD;
   - no hotlinking: `Sec-Fetch-Site: cross-site`, a `Referer` from a host that isn't the hub or a course subdomain, or a `Sec-Fetch-Dest` other than video/audio/empty (track/empty for captions) gets 403. Every answer has `Cross-Origin-Resource-Policy: same-site`;
   - the link: shape, expiry, HMAC (constant time);
   - student links: the `__Host-fbc_s` cookie must hash to `sidTag`, then one D1 query confirms the session is live and the student still has an active enrollment in the lesson's course (not revoked, not expired, not a test-mode enrollment once payments are live). A pass is reused by the isolate for 60 s (`LIVE_CHECK_TTL`), so a revoked device or a refund stops playback within a minute;
   - public links (`s=public`, from `GET /api/public/preview/:lessonId`): the lesson must be a free preview of a published course.
4. The object streams from R2 with byte ranges: `206` with `Content-Range` for seeking, `416` for a range past the end, `If-Range` and `If-None-Match` honoured. `Cache-Control: private, max-age=<seconds left>, no-transform`.

**The player** should ask the play endpoint again when the video errors or `expiresAt` is near (a link copied to another browser, or kept past 2 hours, gets 403).

## Uploads (admin)

| Endpoint | Body | Answer |
|---|---|---|
| `POST /api/admin/uploads` | `{ kind, lessonId?, filename, size, contentType }` | `201 UploadInit` (`id`, `uploadId`, `key`, `partSize` = 10 MiB) |
| `PUT /api/admin/uploads/:id/parts/:n` | the part's bytes, `application/octet-stream`, with `Content-Length` | `{ etag }` |
| `POST /api/admin/uploads/:id/complete` | `{ parts: [{ partNumber, etag }] }` (every part once) | `MediaItem` |
| `DELETE /api/admin/uploads/:id[?force=1]` | | `204` |
| `GET /api/admin/media[?kind=&status=&lessonId=]` | | `MediaItem[]` (newest first, at most 500) |

- **Checks:** kind, content type, extension and size before anything is stored; every part exactly the planned size (R2 needs equal parts but the last); part 1's first bytes must match the type (an HTML page renamed `.mp4` is refused); the finished object must be the declared size.
- **Resumable:** `src/lib/media-upload.ts` `uploadMedia(file, { kind, lessonId, onProgress, signal })` keeps `{ id, uploadId, key, etags }` in localStorage and, for the same file, sends only the parts without an etag. Parts retry on network errors, 408, 429 and 5xx. `complete` is idempotent, so a lost answer is just asked again. If the server has forgotten the upload (cancelled, or aborted by W7's daily job after a day without parts), it starts again once. `cancelUpload(file, …)` aborts and forgets.
- **Lessons:** an upload started with `lessonId` is attached on completion (`lessons.video_provider = 'r2'`, `video_ref = key`, or `captions_key`); the lesson's previous media row is detached (kept, deletable).
- **Delete:** an unfinished upload is aborted. A finished file used by a lesson (video or captions) or a course (cover or social image) answers 409 unless `?force=1`; with force the lesson loses its video or captions, the course its image (content version bumped so the site rebuilds). D1 is updated before R2, so a failed R2 delete leaves an unused object, never a lesson pointing at nothing. Every change is in the audit log (`media.upload_start`, `media.upload_complete`, `media.upload_abort`, `media.delete`).

### Admin authentication

These handlers refuse with 401 unless `context.data.admin` is an object. **W5's admin middleware (`functions/api/admin/_middleware.ts`) must set it** after checking the admin cookie, for example `context.data.admin = { sessionId }`. Until W5 is merged the endpoints are closed, never open.

## Images

`GET /media/i/<key>` serves an image whose `media` row is `kind = 'image'` and `status = 'ready'`, with `Cache-Control: public, max-age=31536000, immutable` (keys never repeat). W1 builds these URLs (`mediaImagePath()` in `snapshot.ts`, the same as `uploads.ts`).

## Tests

`tests/w4/`: `media-rules.test.mjs` (signing, link checks, upload rules, byte sniffing), `media-serve.test.mjs` (serving, ranges, session binding, revocation, hotlinking, previews, `playLesson`, images), `uploads.test.mjs` (admin endpoints end to end on D1 and the R2 fake), `media-upload.test.mjs` (the browser uploader against the real endpoints: resume, retry, pause, lost answers, cancel).
