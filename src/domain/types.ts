/**
 * Session type — sessions are internal/ephemeral process state created by loops
 * (Layer 2), never by the user.
 * `control` is a synonym of the canonical `refine` (the loop-owner session).
 */
export type SessionType = "research" | "refine" | "exec" | "quick";

export type SessionState = "active" | "closed";

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
