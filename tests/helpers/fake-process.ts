import type { ProcessPort, RunResult } from "../../src/ports/process.js";

/**
 * Shared ProcessPort stub: canned run/which, recorded calls, throwing spawns.
 * Behavioral fakes (spawn recording, pid allocation, alive/killed sets) stay
 * per-test-file — this covers only the plain stub variants.
 */
export class FakeProcess implements ProcessPort {
  readonly calls: { cmd: string; args: string[] }[] = [];
  constructor(
    private readonly opts: {
      run?: (cmd: string, args: string[]) => RunResult;
      which?: (cmd: string) => string | undefined;
    } = {},
  ) {}
  async run(cmd: string, args: string[] = []): Promise<RunResult> {
    this.calls.push({ cmd, args });
    return this.opts.run?.(cmd, args) ?? { code: 1, stdout: "", stderr: "" };
  }
  async which(cmd: string): Promise<string | undefined> {
    return this.opts.which?.(cmd);
  }
  async spawnDetached(): Promise<never> {
    throw new Error("spawnDetached not implemented in this fake");
  }
  async spawnInTerminal(): Promise<never> {
    throw new Error("spawnInTerminal not implemented in this fake");
  }
  async openPath(): Promise<void> {}
  async killTree(): Promise<void> {}
  async isAlive(): Promise<boolean> {
    return false;
  }
}
