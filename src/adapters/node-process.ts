import { spawn } from "node:child_process";
import type { ProcessPort, RunOptions, RunResult } from "../ports/process.js";

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
}
