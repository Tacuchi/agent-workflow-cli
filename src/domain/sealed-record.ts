import { createHash } from "node:crypto";
import { canonicalJson } from "../application/semantic-operation/protocol.js";

/**
 * A sealed record's own digest, over its canonical JSON WITHOUT `digest`.
 *
 * Decision notes use the same canonical JSON as other sealed records. Two
 * implementations of "hash this record" could drift without an obvious error.
 *
 * Dropping `digest` is not a detail: a value cannot contain its own hash, so a
 * record that included it would be unverifiable by construction.
 */
export function sealedRecordDigest(record: Readonly<Record<string, unknown>>): string {
  const { digest: _drop, ...rest } = record;
  return `sha256:${createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex")}`;
}
