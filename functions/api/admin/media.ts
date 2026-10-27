// GET /api/admin/media[?kind=&status=&lessonId=] : the uploaded files, newest first (W4).
import { onListMedia } from "../../_lib/media-routes.ts";

export const onRequest = onListMedia;
