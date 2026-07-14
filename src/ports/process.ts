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
  /** `interactive` runs the app in the foreground owning the TTY (TUIs); `server` (default) backgrounds + logs it. */
  mode?: "interactive" | "server" | undefined;
  /** Optional build/compile step run (from `cwd`) before the launch command. */
  build?: { command: string; args: string[] } | undefined;
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
  /** Why the terminal attempt failed (spawn error · launcher exit code · pidfile timeout; per-hop on Windows). Only when mode is "background" AND a terminal was actually tried. */
  terminalError?: string | undefined;
}

// SpawnDetachedOptions/Result describe NodeProcess.spawnDetached — an adapter
// method used only as spawnInTerminal's internal headless fallback, so it is
// deliberately NOT part of the port.
export interface ProcessPort {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
  which(cmd: string): Promise<string | undefined>;
  /**
   * Launch a process in a *visible, persistent* OS terminal window (macOS
   * Terminal.app · Windows PowerShell console · Linux emulator): it stays open to
   * monitor the app live, and closing the window stops the app. Falls back to a
   * detached background process (+ log) when no terminal is available
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
   * Failure is observable: rejects if the opener can't be launched (missing
   * binary) or exits non-zero quickly (e.g. macOS `open -a <bad app>`); resolves
   * once the opener is running.
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
