import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import type {
  ProcessPort,
  RunOptions,
  RunResult,
  SpawnDetachedOptions,
  SpawnDetachedResult,
} from "../ports/process.js";

const WIN_SHELL_CMDS = new Set(["npm", "npx", "yarn", "pnpm", "node-gyp"]);

export class NodeProcess implements ProcessPort {
  async run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const useShell = process.platform === "win32" && WIN_SHELL_CMDS.has(cmd);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
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
    const lookup = process.platform === "win32" ? "where" : "which";
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
    const useShell = process.platform === "win32" && WIN_SHELL_CMDS.has(cmd);
    // Open the log in append mode and hand the fd to the child for stdout+stderr.
    const fd = openSync(opts.logPath, "a");
    try {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
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

  async killTree(pid: number): Promise<void> {
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (process.platform === "win32") {
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
