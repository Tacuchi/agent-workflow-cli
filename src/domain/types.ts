export type Flow = "core" | "dev" | "design" | "analyze";

export type Phase = "planning" | "execution" | "validation" | "closure";

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
