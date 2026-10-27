// POST /api/admin/uploads/:id/complete : finish a multipart upload (W4).
import { onCompleteUpload } from "../../../../_lib/media-routes.ts";

export const onRequest = onCompleteUpload;
