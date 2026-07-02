import type { ParsedArgs } from "../../cli/parser.js";

/**
 * Human-readable one-line rendering of a command invocation for the operational
 * log. Secret values are NOT masked here — the `Logger` redacts the final line
 * (see `redactSecrets`), so this stays a faithful reconstruction.
 */
export function formatCommandInvocation(parsed: ParsedArgs): string {
  const parts: string[] = [];
  if (parsed.command) parts.push(parsed.command);
  parts.push(...parsed.rest);
  for (const flag of parsed.flags) parts.push(`--${flag}`);
  for (const [key, value] of parsed.values) parts.push(`--${key}=${value}`);
  for (const [key, values] of parsed.valuesMulti) {
    for (const value of values) parts.push(`--${key}=${value}`);
  }
  return parts.join(" ");
}

/** `<command> → exit <code>` for a completed dispatch. */
export function formatCommandOutcome(command: string, exitCode: number): string {
  return `${command} → exit ${exitCode}`;
}

/** `<command> → error: <message>` for a thrown dispatch. */
export function formatCommandError(command: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${command} → error: ${message}`;
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
