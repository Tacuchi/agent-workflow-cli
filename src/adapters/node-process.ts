import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenCommand } from "../application/open-external.js";
import {
  LINUX_TERMINALS,
  type WrapperSpec,
  abortFileFor,
  buildNixWrapper,
  buildTerminalCommand,
  buildWinCommandBody,
  buildWinHops,
} from "../application/terminal-launch.js";
import type {
  ProcessPort,
  RunOptions,
  RunResult,
  SpawnDetachedOptions,
  SpawnDetachedResult,
  SpawnInTerminalOptions,
  SpawnInTerminalResult,
} from "../ports/process.js";

const WIN_SHELL_CMDS = new Set(["npm", "npx", "yarn", "pnpm", "node-gyp", "gradle", "mvn"]);

/**
 * How long `openPath` watches a freshly-spawned opener for an early failure.
 * macOS `open -a <bad app>` (and xdg-open on a bad handler) exits non-zero within
 * a few hundred ms; a GUI editor that stays open never exits, so once this window
 * elapses with the process still alive we treat the launch as successful.
 */
const OPEN_PROBE_MS = 600;

/** Windows: .bat/.cmd shims (and the known CLI shims above) only run under a shell (Node ≥20 EINVAL otherwise). */
function needsWinShell(cmd: string): boolean {
  return WIN_SHELL_CMDS.has(cmd) || /\.(bat|cmd)$/i.test(cmd);
}

/** Monotonic suffix for ephemeral wrapper/pid files (avoids Date.now/random). */
let terminalSeq = 0;

/** How long a terminal attempt waits for the wrapper-reported pid (*nix: single attempt). */
const NIX_PIDFILE_TIMEOUT_MS = 10000;
/** Windows waits less per attempt — up to two hops run before the background fallback. */
const WIN_HOP_PIDFILE_TIMEOUT_MS = 7000;

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

/** Outcome of one terminal-launcher attempt: the reported pid, or why it failed. */
interface LauncherAttempt {
  pid: number | null;
  error?: string | undefined;
  /** True when the launcher looked fine but the pidfile never appeared (the console may still be coming). */
  timedOut?: boolean | undefined;
}

export class NodeProcess implements ProcessPort {
  /** Platform/env are injectable so the terminal-launch fallback is testable without opening
   * real windows; `pidfilePollMs` overrides the per-attempt pidfile wait (tests only). */
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly pidfilePollMs?: number,
  ) {}

  async run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const useShell = this.platform === "win32" && needsWinShell(cmd);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? this.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: useShell,
      });

      let stdout = "";
      let stderr = "";
      let timer: NodeJS.Timeout | undefined;

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? 0, stdout, stderr });
      });

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Process ${cmd} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }

      if (opts.stdin) {
        child.stdin.end(opts.stdin);
      } else {
        child.stdin.end();
      }
    });
  }

  async which(cmd: string): Promise<string | undefined> {
    const lookup = this.platform === "win32" ? "where" : "which";
    const result = await this.run(lookup, [cmd]);
    if (result.code !== 0) {
      return undefined;
    }
    const first = result.stdout.split("\n")[0]?.trim();
    return first && first.length > 0 ? first : undefined;
  }

  async spawnDetached(
    cmd: string,
    args: string[],
    opts: SpawnDetachedOptions,
  ): Promise<SpawnDetachedResult> {
    const useShell = this.platform === "win32" && needsWinShell(cmd);
    // Open the log in append mode and hand the fd to the child for stdout+stderr.
    const fd = openSync(opts.logPath, "a");
    try {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? this.env,
        detached: true,
        stdio: ["ignore", fd, fd],
        windowsHide: true,
        shell: useShell,
      });
      // Async spawn failures (e.g. ENOENT) surface as an 'error' event; swallow
      // it so it never crashes the parent — liveness/the log reveal the failure.
      child.on("error", () => {});
      if (child.pid === undefined) {
        throw new Error(`Failed to spawn detached process: ${cmd}`);
      }
      // Let the child outlive this process.
      child.unref();
      return { pid: child.pid };
    } finally {
      // The child inherited its own copy of the fd; close ours.
      closeSync(fd);
    }
  }

  async spawnInTerminal(
    cmd: string,
    args: string[],
    opts: SpawnInTerminalOptions,
  ): Promise<SpawnInTerminalResult> {
    // A terminal window needs a launcher — Terminal.app (macOS), an emulator
    // (Linux) or the Windows hop cascade (a `detached` spawn alone gets
    // DETACHED_PROCESS — no console, no window). The launcher runs an ephemeral
    // wrapper (*nix: a bash file; Windows: an inline -Command body — no file,
    // so GPO ExecutionPolicy and unlink races don't apply) that captures the
    // real app pid into a pidfile we read back (on Windows, the visible
    // console's own $PID).
    if (this.platform === "win32") return this.spawnInWindowsTerminal(cmd, args, opts);
    const hasDisplay =
      this.platform === "darwin" || Boolean(this.env.DISPLAY || this.env.WAYLAND_DISPLAY);
    const linuxTerminals =
      this.platform === "linux" && hasDisplay ? await this.resolveLinuxTerminals() : [];
    const seq = terminalSeq++;
    const wrapperPath = join(tmpdir(), `aw-launch-${process.pid}-${seq}.sh`);
    const pidFile = `${wrapperPath}.pid`;
    const plan = buildTerminalCommand(this.platform, { wrapperPath, linuxTerminals, hasDisplay });
    // No terminal available at all (headless/CI): expected, not an error.
    if (plan.kind !== "terminal") return this.backgroundFallback(cmd, args, opts);
    let attempt: LauncherAttempt;
    try {
      writeFileSync(wrapperPath, buildNixWrapper(this.wrapperSpec(cmd, args, opts, pidFile)), {
        mode: 0o700,
      });
      attempt = await this.spawnLauncherAndPoll(
        plan,
        pidFile,
        opts,
        this.pidfilePollMs ?? NIX_PIDFILE_TIMEOUT_MS,
      );
    } catch (err) {
      attempt = { pid: null, error: (err as Error).message };
    }
    // A timed-out fallback cannot double-launch on *nix: unlinking the wrapper
    // stops a not-yet-started bash; an already-started one keeps the unlinked
    // script fd open and has already written (or is about to write) the pidfile.
    safeUnlink(wrapperPath);
    safeUnlink(pidFile);
    if (attempt.pid !== null) return { pid: attempt.pid, mode: "terminal" };
    const fallback = await this.backgroundFallback(cmd, args, opts);
    return { ...fallback, terminalError: attempt.error };
  }

  /**
   * Windows: try each launcher hop (see buildWinHops) with its OWN pidfile and
   * inline body, then fall back to a background process carrying the per-hop
   * failure reasons (surfaced in the TUI + operational log).
   */
  private async spawnInWindowsTerminal(
    cmd: string,
    args: string[],
    opts: SpawnInTerminalOptions,
  ): Promise<SpawnInTerminalResult> {
    const errors: string[] = [];
    // Bounded by buildWinHops' list (each attempt needs its own pidfile → body → hops).
    for (let hopIndex = 0; ; hopIndex++) {
      const seq = terminalSeq++;
      const pidFile = join(tmpdir(), `aw-launch-${process.pid}-${seq}.pid`);
      const body = buildWinCommandBody(this.wrapperSpec(cmd, args, opts, pidFile));
      const hop = buildWinHops(body, opts.cwd)[hopIndex];
      if (!hop) break;
      const attempt = await this.spawnLauncherAndPoll(
        hop,
        pidFile,
        opts,
        this.pidfilePollMs ?? WIN_HOP_PIDFILE_TIMEOUT_MS,
      );
      if (attempt.pid !== null) {
        // Consumed: a leftover pidfile would be read as a FUTURE launch's console
        // under a recycled process.pid + restarted seq (→ taskkill on a foreign pid).
        safeUnlink(pidFile);
        this.markTerminalLog(opts.logPath);
        return { pid: attempt.pid, mode: "terminal" };
      }
      // A very late console must NOT start the app after we move on (double
      // launch): the marker makes ITS body self-abort right before launching.
      if (attempt.timedOut) {
        try {
          writeFileSync(abortFileFor(pidFile), "1");
        } catch {
          // best-effort — worst case the late console still opens and runs the app
        }
      }
      safeUnlink(pidFile);
      errors.push(`${hop.label}: ${attempt.error}`);
    }
    const fallback = await this.backgroundFallback(cmd, args, opts);
    return { ...fallback, terminalError: errors.join(" · ") };
  }

  /** The launch description every wrapper/body builder consumes. */
  private wrapperSpec(
    cmd: string,
    args: string[],
    opts: SpawnInTerminalOptions,
    pidFile: string,
  ): WrapperSpec {
    return {
      cwd: opts.cwd,
      mode: opts.mode,
      build: opts.build,
      command: cmd,
      args,
      envDelta: opts.envDelta,
      pidFile,
      logPath: opts.logPath,
      title: opts.title,
    };
  }

  /** Spawn a terminal launcher and wait for the wrapper-reported pid; on failure, say why. */
  private async spawnLauncherAndPoll(
    plan: { cmd: string; args: string[] },
    pidFile: string,
    opts: SpawnInTerminalOptions,
    timeoutMs: number,
  ): Promise<LauncherAttempt> {
    // Stale files from an old session under a recycled process.pid (seq restarts
    // at 0) would be read as THIS attempt's: a stale pidfile registers a foreign
    // pid; a stale abort marker makes a healthy console self-abort. Clean first.
    safeUnlink(pidFile);
    safeUnlink(abortFileFor(pidFile));
    // Track launcher failure so we can fall back fast (osascript with no GUI, an
    // emulator that can't open a display, a blocked hop — all exit non-zero or
    // error), WITHOUT mistaking a slow-but-succeeding cold start for "no terminal".
    let failure: string | null = null;
    // The full launch env (params + PROFILE + secrets) rides the launcher spawn:
    // on Windows the whole chain (hop → console) inherits it.
    const child = spawn(plan.cmd, plan.args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      failure = `${plan.cmd}: ${err.message}`;
    });
    // Launchers exit right after handoff; a NON-zero exit means the window never opened.
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) failure ??= `${plan.cmd} salió con código ${code}`;
    });
    child.unref();
    // The window may cold-start slowly, so poll generously — but bail early the
    // moment the launcher itself failed.
    const pid = await this.readPidFile(pidFile, timeoutMs, () => failure !== null);
    if (pid !== null) return { pid };
    if (failure !== null) return { pid: null, error: failure };
    return {
      pid: null,
      error: `timeout esperando el pid de la consola (${Math.round(timeoutMs / 1000)}s)`,
      timedOut: true,
    };
  }

  /** Terminal mode doesn't tee on Windows (see buildWinCommandBody): leave a
   * marker so "Ver log" never presents a previous run's output as current. */
  private markTerminalLog(logPath: string): void {
    try {
      writeFileSync(logPath, "[lanzado en consola — la salida vive en la ventana]\n");
    } catch {
      // best-effort
    }
  }

  /** Fall back to a detached background process (spawnDetached semantics + log). */
  private async backgroundFallback(
    cmd: string,
    args: string[],
    opts: SpawnInTerminalOptions,
  ): Promise<SpawnInTerminalResult> {
    // Build first (best-effort) so the headless run executes fresh output.
    if (opts.build) {
      try {
        await this.run(opts.build.command, opts.build.args, { cwd: opts.cwd, env: opts.env });
      } catch {
        // build unavailable/failed — proceed; the app spawn surfaces it in the log.
      }
    }
    const { pid } = await this.spawnDetached(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      logPath: opts.logPath,
    });
    return { pid, mode: "background" };
  }

  /** Poll `pidFile` for the app pid the wrapper wrote; null on timeout or abort. */
  private async readPidFile(
    pidFile: string,
    timeoutMs: number,
    shouldAbort?: () => boolean,
  ): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (shouldAbort?.()) return null;
      try {
        const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        if (Number.isInteger(pid) && pid > 0) return pid;
      } catch {
        // not written yet
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  /** Linux terminal emulator basenames present on PATH, in priority order. */
  private async resolveLinuxTerminals(): Promise<string[]> {
    const found: string[] = [];
    for (const t of LINUX_TERMINALS) {
      if (await this.which(t.bin)) found.push(t.bin);
    }
    return found;
  }

  async openPath(path: string, opts: { app?: string } = {}): Promise<void> {
    const plan = buildOpenCommand(this.platform, opts.app ? { path, app: opts.app } : { path });
    const child = spawn(plan.cmd, plan.args, {
      detached: true,
      stdio: "ignore",
      // GUI openers may want a window; do not hide it on Windows.
      windowsHide: false,
    });
    // Make failure OBSERVABLE: reject on a spawn 'error' (ENOENT — opener missing)
    // or a fast non-zero exit (bad app), so the caller can show a real error and
    // NOT persist an invalid app. If the opener is still running after a short
    // probe window (a GUI editor holding the file), the launch succeeded → unref
    // and let it outlive us.
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      child.on("error", (err) => finish(() => reject(err)));
      child.on("exit", (code) =>
        finish(() =>
          code && code !== 0 ? reject(new Error(`opener exited with code ${code}`)) : resolve(),
        ),
      );
      // Handlers above only fire on later ticks, by which point `timer` is set.
      const timer = setTimeout(
        () =>
          finish(() => {
            child.unref();
            resolve();
          }),
        OPEN_PROBE_MS,
      );
    });
  }

  async killTree(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (this.platform === "win32") {
      // Kill the process and its child tree, forcefully.
      await this.run("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
      return;
    }
    // *nix: a detached child is a process-group leader (pgid === pid), so a
    // negative pid signals the whole group. Fall back to the lone pid if the
    // group is already gone or the pid is not a leader.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already dead — nothing to do.
      }
    }
  }

  async isAlive(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      // Signal 0 performs existence/permission checks without delivering a signal.
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM → the process exists but is owned by another user → still alive.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
