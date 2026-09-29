/** Canonical criterion and digest spellings shared by decision notes and lineage. */
export const CRITERION_GLOBAL = /S\d{3}\/AC-(?:[A-Z]+-)?\d+/g;

export function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
