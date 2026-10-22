// PUT /api/admin/uploads/:id/parts/:n : one part of a multipart upload (W4).
import { onUploadPart } from "../../../../../_lib/media-routes.ts";

export const onRequest = onUploadPart;
