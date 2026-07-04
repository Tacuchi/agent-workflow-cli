/**
 * Parse a hook's JSON stdin payload. Returns null (callers treat it as
 * "allow") when stdin is empty, malformed, or not a JSON object.
 */
export function parseHookPayload(stdin: string): Record<string, unknown> | null {
  const raw = stdin.trim();
  if (raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
