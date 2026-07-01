import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";

export type LogLevel = "info" | "warn" | "error";

export interface LoggerDeps {
  fs: FileSystemPort;
  paths: PathsService;
  /** Injected clock; defaults to the wall clock. The daily file uses its LOCAL date. */
  now?: () => Date;
}

/**
 * Operational logger: appends one line per event to the GLOBAL, user-level daily
 * log (`~/.${ns}/logs/agent-workflow-YYYY-MM-DD.log`), the same file regardless of
 * the cwd. Best-effort: a write failure never propagates (logging must not crash
 * the CLI). Secret-looking values are redacted before writing.
 */
export class Logger {
  private readonly fs: FileSystemPort;
  private readonly paths: PathsService;
  private readonly now: () => Date;

  constructor(deps: LoggerDeps) {
    this.fs = deps.fs;
    this.paths = deps.paths;
    this.now = deps.now ?? (() => new Date());
  }

  info(message: string): Promise<void> {
    return this.log("info", message);
  }
  warn(message: string): Promise<void> {
    return this.log("warn", message);
  }
  error(message: string): Promise<void> {
    return this.log("error", message);
  }

  async log(level: LogLevel, message: string): Promise<void> {
    const at = this.now();
    const line = `${at.toISOString()} ${level.toUpperCase()} ${redactSecrets(message)}\n`;
    try {
      await this.fs.appendText(this.paths.userDailyLogFile(at), line);
    } catch {
      // Logging is best-effort — never let it crash the CLI.
    }
  }
}

/**
 * Mask values of secret-looking flags (`--token X`, `--password=X`, …) and common
 * credential shapes, so tokens/passwords never land in the log. Deliberately
 * conservative: it targets named secret flags + Bearer tokens.
 */
export function redactSecrets(text: string): string {
  const SECRET_FLAG = /(--?(?:token|secret|password|passwd|pwd|api[-_]?key|key|auth)[=\s]+)(\S+)/gi;
  return text.replace(SECRET_FLAG, "$1***").replace(/\bBearer\s+\S+/gi, "Bearer ***");
}
