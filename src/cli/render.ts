import type { CommandResult } from "../domain/types.js";

export function renderResult<T>(result: CommandResult<T>): string {
  return `${JSON.stringify(result.data ?? { ok: result.ok, error: result.error }, null, 2)}\n`;
}

export function renderRaw(payload: unknown): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function writeStdout(text: string): void {
  process.stdout.write(text);
}

export function writeStderr(text: string): void {
  process.stderr.write(text);
}
