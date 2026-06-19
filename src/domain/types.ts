/**
 * Session type in the redesigned model — sessions are internal/ephemeral process
 * state created by loops (Layer 2), never by the user. Replaces the old `Flow`.
 * `control` is a synonym of the canonical `refine` (the loop-owner session).
 */
export type SessionType = "research" | "refine" | "exec" | "quick";

export type SessionState = "active" | "closed";

export type ExitCode = 0 | 1 | 2;

export interface QtcError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface CommandResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: QtcError;
  exitCode: ExitCode;
}
