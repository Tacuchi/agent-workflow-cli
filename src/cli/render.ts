import type { CommandResult } from "../domain/types.js";

export interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function renderResult<T>(result: CommandResult<T>): string {
  return `${JSON.stringify(result.data ?? { ok: result.ok, error: result.error }, null, 2)}\n`;
}

export function renderRaw(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function renderError(error: ErrorEnvelope): string {
  return `${JSON.stringify({ ok: false, error }, null, 2)}\n`;
}

export function writeStdout(text: string): void {
  process.stdout.write(text);
}

// `writeStderr` is reserved for relaying child-process stderr output (e.g.,
// `aw hook` running plugin scripts). Do NOT use it for CLI-formatted errors:
// those go through `emitError`, which writes a JSON envelope to stdout (post
// session012, RFC 002 G3).
export function writeStderr(text: string): void {
  process.stderr.write(text);
}

export function emitError(error: ErrorEnvelope): void {
  writeStdout(renderError(error));
}

export function formatUnknownCommand(command: string, availableCommands: string[]): ErrorEnvelope {
  return {
    code: "UNKNOWN_COMMAND",
    message: `Unknown command: ${command}`,
    details: {
      command,
      help_hint: "run 'agent-workflow --help' for the full command list",
      available_commands: availableCommands,
    },
  };
}

export function formatArgvError(message: string): ErrorEnvelope {
  return { code: "ARGS_INVALID", message };
}
