import type { EnvPort } from "../../src/ports/env.js";

/** Shared EnvPort stub — covers every per-file FakeEnv/TestEnv variant (home, cwd, vars). */
export class FakeEnv implements EnvPort {
  constructor(
    private readonly home: string = "/home/u",
    private readonly workdir: string = home,
    private readonly vars: Record<string, string | undefined> = {},
  ) {}
  get(name: string): string | undefined {
    return this.vars[name];
  }
  homeDir(): string {
    return this.home;
  }
  cwd(): string {
    return this.workdir;
  }
}
