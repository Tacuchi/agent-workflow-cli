import type { SessionResolutionError } from "../application/session-resolver.js";
import type { CliError, CommandResult } from "../domain/types.js";

export interface ErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Standard command error result. `emit()` in main.ts rebuilds the stdout
 * payload from field values, so this is byte-identical to the inline literals
 * it replaces. `data` is attached only when provided (error context payloads).
 */
export function fail<T = never>(
  code: string,
  message: string,
  data?: T,
  exitCode: 1 | 2 = 1,
): CommandResult<T> {
  return {
    ok: false,
    error: { code, message },
    ...(data !== undefined ? { data } : {}),
    exitCode,
  };
}

/**
 * Canonical envelope for a failed session resolution: the stable `code`, the
 * human message, and — in `data` — the relevant candidates plus one valid next
 * action. Every session-scoped command reports the failure this way, so the
 * shape never depends on which command hit it.
 */
export function failSessionResolution(error: SessionResolutionError): CommandResult {
  return fail(error.code, error.message, {
    candidates: error.candidates,
    action: error.action,
  });
}

/**
 * Canonical failure of a hybrid operation: the stable code, the message, and
 * the next valid action in `data` — the same shape `failSessionResolution`
 * established, so every command's errors read the same way.
 *
 * The single cast lives here on purpose. On the failure path `data` carries the
 * next action, never the command's success payload, and `renderHumanError`
 * reads it structurally rather than through `T`. Three copies of this cast is
 * what it replaces.
 */
export function failSemantic<T>(failure: {
  code: string;
  message: string;
  action: string;
}): CommandResult<T> {
  return {
    ok: false,
    error: { code: failure.code, message: failure.message },
    data: { action: failure.action } as unknown as T,
    exitCode: 1,
  };
}

export function renderRaw(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Human projection of a failed result: the stable code, the message, and the
 * next valid action when the command supplied one.
 *
 * It reads `action` out of the SAME `data` the JSON envelope carries (the shape
 * `failSessionResolution` already produces), so the two projections cannot
 * disagree about what to do next. The exit code is decided elsewhere and is
 * untouched by which projection printed.
 */
export function renderHumanError(error: CliError | undefined, data?: unknown): string {
  const code = error?.code ?? "UNKNOWN";
  const lines = [`✗ ${code}`, error?.message ?? "el comando falló sin detallar la causa"];
  const action = readNextAction(data);
  if (action !== undefined) lines.push("", `Siguiente acción: ${action}`);
  return `${lines.join("\n")}\n`;
}

function readNextAction(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const action = (data as { action?: unknown }).action;
  return typeof action === "string" && action.length > 0 ? action : undefined;
}

export function renderError(error: ErrorEnvelope): string {
  return `${JSON.stringify({ ok: false, error }, null, 2)}\n`;
}

export function writeStdout(text: string): void {
  process.stdout.write(text);
}

// `writeStderr` is reserved for relaying child-process stderr output (e.g.,
// `aw hook` running plugin scripts) and for the host-facing notice of a held
// compaction (a blocking PreCompact shows a person stderr, never stdout). Do
// NOT use it for CLI-formatted errors: those go through `emitError`, which
// writes a JSON envelope to stdout (post session012, Propuesta 002 G3).
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
