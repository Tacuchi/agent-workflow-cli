export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnDetachedOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** File to which stdout+stderr are redirected (opened in append mode). */
  logPath: string;
}

export interface SpawnDetachedResult {
  pid: number;
}

export interface ProcessPort {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  which(cmd: string): Promise<string | undefined>;
  /**
   * Launch a process fully detached from the current process: its own
   * group/session, stdout+stderr redirected to `logPath`, no stdin. The child
   * survives the parent exiting (the parent `unref`s it). Returns the child PID.
   */
  spawnDetached(
    cmd: string,
    args: string[],
    opts: SpawnDetachedOptions,
  ): Promise<SpawnDetachedResult>;
  /**
   * Terminate a process and its whole tree/group. Best-effort: resolves even if
   * the process is already gone.
   */
  killTree(pid: number): Promise<void>;
  /** Whether a process with the given PID is currently alive (best-effort). */
  isAlive(pid: number): Promise<boolean>;
}
