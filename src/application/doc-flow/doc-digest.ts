import { createHash } from "node:crypto";
import type { FileSystemPort } from "../../ports/file-system.js";
import { digestOf } from "../byte-digest.js";

/** The read digest of a document that does not exist yet (spec-new, plan-new). */
export const ABSENT_DOCUMENT = "absent";

/** What one instance read: the bytes' SHA-256, or {@link ABSENT_DOCUMENT}. */
export async function readDigestOf(fs: FileSystemPort, absolute: string): Promise<string> {
  if (!(await fs.exists(absolute))) return ABSENT_DOCUMENT;
  return digestOf(await fs.readBytes(absolute));
}

/** SHA-256 of a text, the way the bytes on disk would hash once written. */
export function textDigest(text: string): string {
  return digestOf(new TextEncoder().encode(text));
}

/** A deterministic digest over labelled parts, used for approvals that live in the conversation. */
export function approvalDigest(parts: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const key of Object.keys(parts).sort()) hash.update(`${key}\u0000${parts[key]}\u0000`);
  return `sha256:${hash.digest("hex")}`;
}

export interface DocChangedFailure {
  code: "DOC_CHANGED_SINCE_READ";
  message: string;
  action: string;
}

/**
 * The guard every spec or plan write passes (spec 066, ID04): the bytes on disk
 * must still be the ones this instance read. The digest travels in the
 * conversation, never on disk, so two instances never share a lock to orphan.
 */
export async function guardUnchanged(
  fs: FileSystemPort,
  absolute: string,
  display: string,
  readDigest: string,
): Promise<DocChangedFailure | null> {
  const current = await readDigestOf(fs, absolute);
  if (current === readDigest) return null;
  return {
    code: "DOC_CHANGED_SINCE_READ",
    message: `'${display}' cambió desde que esta instancia lo leyó (leído ${readDigest}, ahora ${current}): no se escribe nada`,
    action: `volvé a leerlo con 'aw flow read' y rehacé el cambio sobre sus bytes actuales`,
  };
}
