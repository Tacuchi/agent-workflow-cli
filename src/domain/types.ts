export type SessionState = "active" | "closed" | "paused" | "abandoned";

export type ExitCode = 0 | 1 | 2;

export interface CliError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CommandResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: CliError;
  exitCode: ExitCode;
  /** A stdio protocol command reserves stdout for protocol frames only. */
  suppressOutput?: boolean;
}
