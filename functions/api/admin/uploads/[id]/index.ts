// DELETE /api/admin/uploads/:id[?force=1] : abort an unfinished upload or delete a file (W4).
import { onDeleteMedia } from "../../../../_lib/media-routes.ts";

export const onRequest = onDeleteMedia;
