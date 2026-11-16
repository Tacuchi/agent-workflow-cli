/** Exact runner-reported file (or JVM class) and full case name; no wildcard exemptions. */
export interface TestFailure {
  file: string;
  case: string;
}

export function isTestFailure(value: unknown): value is TestFailure {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return [entry.file, entry.case].every(
    (part) => typeof part === "string" && part.trim().length > 0,
  );
}
