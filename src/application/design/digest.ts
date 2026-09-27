import { createHash } from "node:crypto";

/** The same byte digest used by published design files and the CLI distribution. */
export function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
