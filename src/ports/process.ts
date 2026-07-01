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

export interface SpawnInTerminalOptions {
  cwd: string;
  /** Full child environment (base + params + PROFILE) — used for the background fallback and Windows console inheritance. */
  env: Record<string, string>;
  /** Deltas over the inherited base env (params + PROFILE) — baked into the *nix wrapper so they survive terminals that don't inherit our env. */
  envDelta: Record<string, string>;
  /** Log file: the fallback writes here; the *nix terminal tee's here too (so "Ver log" keeps working). */
  logPath: string;
  /** Window title / exit-line label. */
  title: string;
}

export interface SpawnInTerminalResult {
  pid: number;
  /** "terminal" when a visible window was opened; "background" when it fell back to a detached process (no terminal available). */
  mode: "terminal" | "background";
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
   * Launch a process in a *visible, persistent* OS terminal window (macOS
   * Terminal.app · Windows PowerShell console · Linux emulator): it stays open to
   * monitor the app live, and closing the window stops the app. Falls back to
   * {@link spawnDetached} (background + log) when no terminal is available
   * (headless/CI). The returned `pid` is the real app pid on *nix and the console
   * pid on Windows; `mode` says which path was taken.
   */
  spawnInTerminal(
    cmd: string,
    args: string[],
    opts: SpawnInTerminalOptions,
  ): Promise<SpawnInTerminalResult>;
  /**
   * Open a file in an EXTERNAL application — the OS default text editor, or
   * `opts.app` when given — spawned detached so it never captures the TUI's TTY.
   * Best-effort: resolves even if the opener can't be launched (the caller
   * surfaces failure, e.g. checks the file exists first).
   */
  openPath(path: string, opts?: { app?: string }): Promise<void>;
  /**
   * Terminate a process and its whole tree/group. Best-effort: resolves even if
   * the process is already gone.
   */
  killTree(pid: number): Promise<void>;
  /** Whether a process with the given PID is currently alive (best-effort). */
  isAlive(pid: number): Promise<boolean>;
}
