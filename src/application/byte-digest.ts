import { createHash } from "node:crypto";

/** SHA-256 of original bytes, shared by distribution integrity checks. */
export function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
