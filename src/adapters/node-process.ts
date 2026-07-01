import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildOpenCommand } from "../application/open-external.js";
import {
  LINUX_TERMINALS,
  buildNixWrapper,
  buildTerminalCommand,
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

const WIN_SHELL_CMDS = new Set(["npm", "npx", "yarn", "pnpm", "node-gyp"]);

/** Monotonic suffix for ephemeral wrapper/pid files (avoids Date.now/random). */
let terminalSeq = 0;

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

export class NodeProcess implements ProcessPort {
  /** Platform/env are injectable so the terminal-launch fallback is testable without opening real windows. */
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const useShell = this.platform === "win32" && WIN_SHELL_CMDS.has(cmd);
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
    const useShell = this.platform === "win32" && WIN_SHELL_CMDS.has(cmd);
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
    if (this.platform === "win32") {
      const plan = buildTerminalCommand("win32", {
        wrapperPath: "",
        cwd: opts.cwd,
        command: cmd,
        args,
        title: opts.title,
        linuxTerminals: [],
        hasDisplay: true,
      });
      if (plan.kind === "terminal") {
        // `detached` gives the child its own console window; `windowsHide:false`
        // (unlike spawnDetached) keeps it visible; secrets ride in via `env`
        // (inherited), never the command line.
        const child = spawn(plan.cmd, plan.args, {
          cwd: opts.cwd,
          env: opts.env,
          detached: true,
          windowsHide: false,
          stdio: "ignore",
        });
        child.on("error", () => {});
        if (child.pid !== undefined) {
          child.unref();
          return { pid: child.pid, mode: "terminal" };
        }
      }
      return this.backgroundFallback(cmd, args, opts);
    }

    // *nix — Terminal.app (macOS) or an emulator (Linux) runs an ephemeral
    // wrapper that captures the real app pid into a pidfile we read back.
    const hasDisplay =
      this.platform === "darwin" || Boolean(this.env.DISPLAY || this.env.WAYLAND_DISPLAY);
    const linuxTerminals =
      this.platform === "linux" && hasDisplay ? await this.resolveLinuxTerminals() : [];
    const seq = terminalSeq++;
    const wrapperPath = join(tmpdir(), `aw-launch-${process.pid}-${seq}.sh`);
    const pidFile = `${wrapperPath}.pid`;
    const plan = buildTerminalCommand(this.platform, {
      wrapperPath,
      cwd: opts.cwd,
      command: cmd,
      args,
      title: opts.title,
      linuxTerminals,
      hasDisplay,
    });
    if (plan.kind === "terminal") {
      try {
        writeFileSync(
          wrapperPath,
          buildNixWrapper({
            cwd: opts.cwd,
            command: cmd,
            args,
            envDelta: opts.envDelta,
            pidFile,
            logPath: opts.logPath,
            title: opts.title,
          }),
          { mode: 0o700 },
        );
        // Track launcher failure so we can fall back fast (e.g. osascript with no
        // GUI, or an emulator that can't open a display, exit non-zero), WITHOUT
        // mistaking a slow-but-succeeding cold start for "no terminal".
        let launcherFailed = false;
        const child = spawn(plan.cmd, plan.args, {
          cwd: opts.cwd,
          env: opts.env,
          detached: true,
          stdio: "ignore",
        });
        child.on("error", () => {
          launcherFailed = true;
        });
        // Launchers like osascript / the gnome-terminal client exit right after
        // handoff; a NON-zero exit means the window never opened.
        child.on("exit", (code) => {
          if (code !== 0 && code !== null) launcherFailed = true;
        });
        child.unref();
        // Wait for the wrapper to report the real app pid. The window may cold-start
        // slowly (Terminal.app / a fresh emulator), so poll generously — but bail
        // early the moment the launcher itself failed. If no pid ever appears AND the
        // launcher didn't fail, the wrapper never got to run the app, so falling back
        // cannot double-launch it. (bash keeps the unlinked script fd open → safe.)
        const pid = await this.readPidFile(pidFile, 10000, () => launcherFailed);
        safeUnlink(wrapperPath);
        safeUnlink(pidFile);
        if (pid !== null) return { pid, mode: "terminal" };
      } catch {
        safeUnlink(wrapperPath);
        safeUnlink(pidFile);
      }
    }
    // No terminal opened (headless/CI, or it failed): the app MUST still run.
    return this.backgroundFallback(cmd, args, opts);
  }

  /** Fall back to a detached background process (spawnDetached semantics + log). */
  private async backgroundFallback(
    cmd: string,
    args: string[],
    opts: SpawnInTerminalOptions,
  ): Promise<SpawnInTerminalResult> {
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
    try {
      const child = spawn(plan.cmd, plan.args, {
        detached: true,
        stdio: "ignore",
        // GUI openers may want a window; do not hide it on Windows.
        windowsHide: false,
      });
      // Best-effort: swallow async spawn failures (e.g. ENOENT) so opening never
      // crashes the TUI — the caller surfaces failure by other means.
      child.on("error", () => {});
      child.unref();
    } catch {
      // Synchronous spawn failure — also best-effort.
    }
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
