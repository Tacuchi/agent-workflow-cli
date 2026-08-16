import { createHash } from "node:crypto";
import { canonicalJson } from "../application/semantic-operation/protocol.js";

/**
 * A sealed record's own digest, over its canonical JSON WITHOUT `digest`.
 *
 * Extracted so the two kinds of record that need it — a design governance
 * record and a decision note — seal by the SAME code and not merely by the same
 * described rule. Two implementations of "hash this record" drift the day one of
 * them changes, and the failure is silent: both sides keep producing a digest
 * and only their comparison stops matching.
 *
 * Dropping `digest` is not a detail: a value cannot contain its own hash, so a
 * record that included it would be unverifiable by construction.
 */
export function sealedRecordDigest(record: Readonly<Record<string, unknown>>): string {
  const { digest: _drop, ...rest } = record;
  return `sha256:${createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex")}`;
}
