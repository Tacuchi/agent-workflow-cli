import { createHash } from "node:crypto";
import { canonicalEol } from "../../domain/proposal.js";

/** The same byte digest used by published design files and the CLI distribution. */
export function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Compare a published raw-byte seal without changing the seal format. */
export function compareDesignDigest(
  bytes: Uint8Array,
  expected: string,
): { kind: "equal" | "eol-only" | "different"; matchingBytes?: Uint8Array } {
  if (digestOf(bytes) === expected) return { kind: "equal", matchingBytes: bytes };
  let lf: string;
  try {
    lf = canonicalEol(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return { kind: "different" };
  }
  for (const text of [lf, lf.replace(/\n/g, "\r\n")]) {
    const candidate = new TextEncoder().encode(text);
    if (digestOf(candidate) === expected) return { kind: "eol-only", matchingBytes: candidate };
  }
  return { kind: "different" };
}

export function designDigestMismatch(path: string) {
  return {
    code: "DESIGN_DIGEST_MISMATCH",
    artifact: path,
    message: `los bytes de '${path}' no coinciden con el digest publicado`,
    action:
      "restaurá los bytes sellados o publicá una revisión nueva; no alteres una revisión publicada",
  };
}

export function designEolWarning(path: string) {
  return {
    code: "DESIGN_EOL_CHANGED",
    artifact: path,
    message: `sólo cambió el fin de línea de '${path}' respecto del digest publicado`,
    action: "conservá el sello original; no hace falta publicar otra revisión",
  };
}
