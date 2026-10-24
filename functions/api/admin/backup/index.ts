// GET /api/admin/backup: the newest dump. functions/_lib/admin/routes.ts (W7 backup.ts).
import { backupDownloadRoute } from "../../../_lib/admin/routes.ts";

export const onRequest = backupDownloadRoute;
