// POST /api/admin/uploads : start a resumable upload (W4, functions/_lib/uploads.ts).
import { onStartUpload } from "../../../_lib/media-routes.ts";

export const onRequest = onStartUpload;
