import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { EnvPort } from "../../src/ports/env.js";
import type { DirEntry, FileSystemPort } from "../../src/ports/file-system.js";
import { RuntimeConfigService } from "../../src/runtime/config-service.js";

const HOME = "/home/test";
const USER_CONFIG = join(HOME, ".qtc", "agent-workflow", "runtime.json");
const CORE_CONFIG = "/repo/core-workflow-plugin/config/agent-workflow-runtime.json";

class FakeEnv implements EnvPort {
  constructor(private readonly vars: Record<string, string | undefined> = {}) {}
  get(name: string): string | undefined {
    return this.vars[name];
  }
  homeDir(): string {
    return HOME;
  }
  cwd(): string {
    return "/cwd";
  }
}

class FakeFs implements FileSystemPort {
  constructor(private readonly files: Map<string, string>) {}
  async readText(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) {
      throw new Error(`Missing fixture for ${path}`);
    }
    return content;
  }
  async writeText(): Promise<void> {
    throw new Error("not implemented");
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async list(): Promise<DirEntry[]> {
    throw new Error("not implemented");
  }
  async mkdirp(): Promise<void> {
    throw new Error("not implemented");
  }
}

describe("RuntimeConfigService.resolveRuntime", () => {
  let fs: FakeFs;
  let env: FakeEnv;

  beforeEach(() => {
    fs = new FakeFs(new Map());
    env = new FakeEnv();
  });

  it("returns default when no env, no user config, no core config", async () => {
    const service = new RuntimeConfigService(fs, env);

    const resolved = await service.resolveRuntime();

    expect(resolved).toEqual({
      packageName: "@tacuchi/agent-workflow",
      binName: "agent-workflow",
      source: "default",
    });
  });

  it("uses env override over any config file", async () => {
    env = new FakeEnv({ QTC_AGENT_WORKFLOW_BIN: "aw-custom" });
    fs = new FakeFs(
      new Map([
        [USER_CONFIG, JSON.stringify({ packageName: "x", binName: "ignored", envOverride: "Y" })],
      ]),
    );
    const service = new RuntimeConfigService(fs, env);

    const resolved = await service.resolveRuntime();

    expect(resolved.binName).toBe("aw-custom");
    expect(resolved.source).toBe("env");
    expect(resolved.packageName).toBe("@tacuchi/agent-workflow");
  });

  it("uses user config when env is absent", async () => {
    fs = new FakeFs(
      new Map([
        [
          USER_CONFIG,
          JSON.stringify({
            packageName: "@tacuchi/agent-workflow",
            binName: "user-bin",
            envOverride: "QTC_AGENT_WORKFLOW_BIN",
          }),
        ],
      ]),
    );
    const service = new RuntimeConfigService(fs, env);

    const resolved = await service.resolveRuntime();

    expect(resolved.binName).toBe("user-bin");
    expect(resolved.source).toBe("user-config");
    expect(resolved.configPath).toBe(USER_CONFIG);
  });

  it("falls back to core config when env and user config are absent", async () => {
    fs = new FakeFs(
      new Map([
        [
          CORE_CONFIG,
          JSON.stringify({
            packageName: "@tacuchi/agent-workflow",
            binName: "core-bin",
            envOverride: "QTC_AGENT_WORKFLOW_BIN",
          }),
        ],
      ]),
    );
    const service = new RuntimeConfigService(fs, env, { coreConfigPath: CORE_CONFIG });

    const resolved = await service.resolveRuntime();

    expect(resolved.binName).toBe("core-bin");
    expect(resolved.source).toBe("core-config");
    expect(resolved.configPath).toBe(CORE_CONFIG);
  });

  it("ignores empty env override", async () => {
    env = new FakeEnv({ QTC_AGENT_WORKFLOW_BIN: "   " });
    const service = new RuntimeConfigService(fs, env);

    const resolved = await service.resolveRuntime();

    expect(resolved.source).toBe("default");
    expect(resolved.binName).toBe("agent-workflow");
  });

  it("throws on invalid JSON in config file", async () => {
    fs = new FakeFs(new Map([[USER_CONFIG, "{ not json"]]));
    const service = new RuntimeConfigService(fs, env);

    await expect(service.resolveRuntime()).rejects.toThrow(/Invalid JSON in runtime config/);
  });

  it("throws when config is missing required field", async () => {
    fs = new FakeFs(new Map([[USER_CONFIG, JSON.stringify({ packageName: "x" })]]));
    const service = new RuntimeConfigService(fs, env);

    await expect(service.resolveRuntime()).rejects.toThrow(
      /missing or invalid string field 'binName'/,
    );
  });
});
