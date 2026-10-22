/**
 * GET /receipt/:id?k=… (functions/receipt/[id].ts). Kept apart from receipts.ts so tests can call
 * it with a plain Request.
 */
import { config } from "./config.ts";
import { ConfigError } from "./config.ts";
import { unixNow } from "./db/d1.ts";
import { hasDb, type Env } from "./env.ts";
import { methodNotAllowed } from "./http.ts";
import { buildReceipt, checkReceiptKey, receiptHeaders, renderReceiptMissing, renderReceiptPage } from "./receipts.ts";

export async function handleReceipt(request: Request, env: Env, id: string, now = unixNow()): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed(["GET"]);
  const headers = await receiptHeaders();
  const missing = () => new Response(renderReceiptMissing(), { status: 404, headers });
  if (!/^\d{1,12}$/.test(id) || !hasDb(env)) return missing();
  const orderId = Number(id);
  const url = new URL(request.url);
  try {
    if (!(await checkReceiptKey(env, orderId, url.searchParams.get("k")))) return missing();
    const receipt = await buildReceipt(env.DB, orderId);
    if (!receipt) return missing();
    const html = renderReceiptPage(receipt, { shareUrl: `${url.origin}${url.pathname}${url.search}`, hubOrigin: config(env).hubOrigin, now });
    return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
  } catch (err) {
    if (!(err instanceof ConfigError)) console.error(`receipt: ${err instanceof Error ? err.message : "unknown error"}`);
    return missing();
  }
}
