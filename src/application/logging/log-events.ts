import type { ParsedArgs } from "../../cli/parser.js";

/**
 * Human-readable one-line rendering of a command invocation for the operational
 * log. Secret values are NOT masked here — the `Logger` redacts the final line
 * (see `redactSecrets`), so this stays a faithful reconstruction.
 */
export function formatCommandInvocation(parsed: ParsedArgs): string {
  if (parsed.command === "tool")
    return "tool request --connection=<redacted> --input-json=<redacted>";
  // MCP descriptors and probes may receive arbitrary flags before validation.
  // Do not let an accidental libpq DSN, SQL, JSON payload, or host diagnostic
  // become telemetry just because it was attached to an otherwise valid mcp
  // command. The operation name is sufficient for an operational audit trail.
  if (parsed.command === "mcp") return "mcp request --arguments=<redacted>";
  const parts: string[] = [];
  if (parsed.command) parts.push(parsed.command);
  parts.push(...parsed.rest);
  for (const flag of parsed.flags) parts.push(`--${flag}`);
  for (const [key, value] of parsed.values) {
    parts.push(`--${key}=${redactedInvocationValue(key, value)}`);
  }
  for (const [key, values] of parsed.valuesMulti) {
    for (const value of values) parts.push(`--${key}=${redactedInvocationValue(key, value)}`);
  }
  return parts.join(" ");
}

/** `<command> → exit <code>` for a completed dispatch. */
export function formatCommandOutcome(command: string, exitCode: number): string {
  return `${command} → exit ${exitCode}`;
}

/** `<command> → error: <message>` for a thrown dispatch. */
export function formatCommandError(command: string, err: unknown): string {
  if (command === "tool" || command === "mcp") return `${command} → error: solicitud MCP/DB falló`;
  const message = err instanceof Error ? err.message : String(err);
  return `${command} → error: ${message}`;
}

function redactedInvocationValue(key: string, value: string): string {
  // SQL and arbitrary tool arguments may contain personal or proprietary data.
  // They are a direct request payload, never operational telemetry.
  return key === "input-json" ? "<redacted>" : value;
}

/**
 * `tui: <action>` (optionally `→ <outcome>` or `→ <outcome>: <detail>`) for a
 * TUI-originated event in the operational log. Mirrors the `<command> → …` shape
 * used for CLI dispatches so both read the same when grepping the daily log.
 */
export function formatTuiEvent(action: string, outcome?: string, detail?: string): string {
  if (!outcome) return `tui: ${action}`;
  return `tui: ${action} → ${detail ? `${outcome}: ${detail}` : outcome}`;
}
