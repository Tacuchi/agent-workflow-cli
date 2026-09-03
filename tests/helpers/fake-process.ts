import type { ProcessPort, RunBinaryResult, RunResult } from "../../src/ports/process.js";

/**
 * Shared ProcessPort stub: canned run/which, recorded calls, throwing spawns.
 * Behavioral fakes (spawn recording, pid allocation, alive/killed sets) stay
 * per-test-file — this covers only the plain stub variants.
 */
export class FakeProcess implements ProcessPort {
  readonly calls: { cmd: string; args: string[] }[] = [];
  /** Cada corrida que heredó la terminal, en orden —con su cwd—. Vacío = ninguna. */
  readonly interactive: { cmd: string; args: string[]; cwd?: string | undefined }[] = [];
  constructor(
    private readonly opts: {
      run?: (cmd: string, args: string[]) => RunResult;
      which?: (cmd: string) => string | undefined;
      /** Por defecto NO hay terminal: un fake que la finge deja pasar el camino bloqueado. */
      tty?: boolean;
      interactive?: (cmd: string, args: string[]) => { code: number };
    } = {},
  ) {}
  async run(cmd: string, args: string[] = []): Promise<RunResult> {
    this.calls.push({ cmd, args });
    return this.opts.run?.(cmd, args) ?? { code: 1, stdout: "", stderr: "" };
  }
  async runBinary(cmd: string, args: string[] = []): Promise<RunBinaryResult> {
    const { code, stdout, stderr } = await this.run(cmd, args);
    return { code, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
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
  hasTty(): boolean {
    return this.opts.tty === true;
  }
  async runInteractive(
    cmd: string,
    args: string[] = [],
    opts: { cwd?: string } = {},
  ): Promise<{ code: number }> {
    this.interactive.push({ cmd, args, cwd: opts.cwd });
    return this.opts.interactive?.(cmd, args) ?? { code: 0 };
  }
}
