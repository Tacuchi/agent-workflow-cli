import { spawn } from "node:child_process";
import { buildOpenCommand } from "../application/open-external.js";
import type {
  InteractiveOptions,
  ProcessPort,
  RunBinaryResult,
  RunOptions,
  RunResult,
} from "../ports/process.js";

const WIN_SHELL_CMDS = new Set(["npm", "npx", "yarn", "pnpm", "node-gyp", "gradle", "mvn"]);

/** How long to watch a GUI opener for an early failure. */
const OPEN_PROBE_MS = 600;

function needsWinShell(cmd: string): boolean {
  return WIN_SHELL_CMDS.has(cmd) || /\.(bat|cmd)$/i.test(cmd);
}

export class NodeProcess implements ProcessPort {
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
    const result = await this.runBinary(cmd, args, opts);
    return {
      code: result.code,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  }

  /** Join bytes before decoding, so a multibyte sequence split across chunks survives. */
  async runBinary(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunBinaryResult> {
    const useShell = this.platform === "win32" && needsWinShell(cmd);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env ?? this.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: useShell,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.on("error", (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? 0, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Process ${cmd} timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs);
      }
      child.stdin.end(opts.stdin);
    });
  }

  async which(cmd: string): Promise<string | undefined> {
    const lookup = this.platform === "win32" ? "where" : "which";
    const result = await this.run(lookup, [cmd]);
    if (result.code !== 0) return undefined;
    const first = result.stdout.split("\n")[0]?.trim();
    return first && first.length > 0 ? first : undefined;
  }

  async openPath(path: string, opts: { app?: string } = {}): Promise<void> {
    const plan = buildOpenCommand(this.platform, opts.app ? { path, app: opts.app } : { path });
    const child = spawn(plan.cmd, plan.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
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

  hasTty(): boolean {
    return process.stdin.isTTY === true && process.stdout.isTTY === true;
  }

  /** An inherited-stdio authentication run never captures credentials. */
  async runInteractive(
    cmd: string,
    args: string[],
    opts: InteractiveOptions = {},
  ): Promise<{ code: number }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: this.env,
        stdio: "inherit",
        shell: false,
      });
      child.on("error", () => resolve({ code: 127 }));
      child.on("close", (code) => resolve({ code: code ?? 1 }));
    });
  }
}
