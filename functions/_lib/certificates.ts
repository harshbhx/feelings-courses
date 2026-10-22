/**
 * Certificates (plan 1.11). STUB: signature frozen by W0, body by W3.
 * Code: 10 Crockford base32 characters (crypto.ts randomCrockford). Wording from
 * courses.certificate_title, never invented. A reissue replaces name_on_cert and issued_at.
 */
import type { Certificate } from "../../src/shared/types.ts";
import type { Env } from "./env.ts";
import { notImplemented } from "./stub.ts";

export async function issueCertificate(
  env: Env,
  input: { studentId: number; courseId: number; name: string },
): Promise<Certificate> {
  return notImplemented("issueCertificate", "W3");
}
