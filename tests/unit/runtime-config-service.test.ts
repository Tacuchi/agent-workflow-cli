import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { RuntimeConfigService } from "../../src/runtime/config-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const HOME = "/home/test";
const USER_CONFIG = join(HOME, ".workflow", "agent-workflow", "runtime.json");

function makeQtcPathsForTest(home: string): PathsService {
  return new PathsService(normalizeNamespace("workflow"), home, "/cwd");
}

describe("RuntimeConfigService.resolveRuntime", () => {
  let fs: MemFs;
  let env: FakeEnv;
  let paths: PathsService;

  beforeEach(() => {
    fs = new MemFs();
    env = new FakeEnv(HOME, "/cwd");
    paths = makeQtcPathsForTest(HOME);
  });

  it("returns default when no env and no user config", async () => {
    const service = new RuntimeConfigService(fs, env, paths);

    const resolved = await service.resolveRuntime();

    expect(resolved).toEqual({
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      source: "default",
    });
  });

  it("uses env override over any config file", async () => {
    env = new FakeEnv(HOME, "/cwd", { AW_AGENT_WORKFLOW_BIN: "aw-custom" });
    fs = new MemFs().file(
      USER_CONFIG,
      JSON.stringify({ packageName: "x", binName: "ignored", envOverride: "Y" }),
    );
    const service = new RuntimeConfigService(fs, env, paths);

    const resolved = await service.resolveRuntime();

    expect(resolved.binName).toBe("aw-custom");
    expect(resolved.source).toBe("env");
    expect(resolved.packageName).toBe("@tacuchi/agent-workflow-cli");
  });

  it("uses user config when env is absent (envOverride not required in the file)", async () => {
    fs = new MemFs().file(
      USER_CONFIG,
      JSON.stringify({
        packageName: "@tacuchi/agent-workflow-cli",
        binName: "user-bin",
      }),
    );
    const service = new RuntimeConfigService(fs, env, paths);

    const resolved = await service.resolveRuntime();

    expect(resolved.binName).toBe("user-bin");
    expect(resolved.source).toBe("user-config");
    expect(resolved.configPath).toBe(USER_CONFIG);
  });

  it("ignores empty env override", async () => {
    env = new FakeEnv(HOME, "/cwd", { AW_AGENT_WORKFLOW_BIN: "   " });
    const service = new RuntimeConfigService(fs, env, paths);

    const resolved = await service.resolveRuntime();

    expect(resolved.source).toBe("default");
    expect(resolved.binName).toBe("agent-workflow");
  });

  it("throws on invalid JSON in config file", async () => {
    fs = new MemFs().file(USER_CONFIG, "{ not json");
    const service = new RuntimeConfigService(fs, env, paths);

    await expect(service.resolveRuntime()).rejects.toThrow(/Invalid JSON in runtime config/);
  });

  it("throws when config is missing required field", async () => {
    fs = new MemFs().file(USER_CONFIG, JSON.stringify({ packageName: "x" }));
    const service = new RuntimeConfigService(fs, env, paths);

    await expect(service.resolveRuntime()).rejects.toThrow(
      /missing or invalid string field 'binName'/,
    );
  });

  it("loads extended schema with displayName, mcpGuards, expectedMcpServers, slashCommands", async () => {
    const fullConfig = {
      packageName: "@tacuchi/agent-workflow-cli",
      binName: "agent-workflow",
      displayName: "Acme Workflow",
      mcpGuards: {
        sqlMutation: {
          toolPattern: "^mcp__plugin.*(cert|prod).*__execute_sql$",
          serverPattern: "(cert|prod)",
        },
      },
      expectedMcpServers: ["cert", "prod"],
      // `session` (like the other retired hint keys) is ignored: only
      // `migrate` has consumers.
      slashCommands: { migrate: "/acme-core:migrate", session: "/acme-core:session" },
    };
    fs = new MemFs().file(USER_CONFIG, JSON.stringify(fullConfig));
    const service = new RuntimeConfigService(fs, env, paths);
    const resolved = await service.resolveRuntime();

    expect(resolved.displayName).toBe("Acme Workflow");
    expect(resolved.mcpGuards?.sqlMutation?.toolPattern).toContain("(cert|prod)");
    expect(resolved.expectedMcpServers).toEqual(["cert", "prod"]);
    expect(resolved.slashCommands).toEqual({ migrate: "/acme-core:migrate" });
  });

  it("ignores malformed extended fields gracefully", async () => {
    const config = {
      packageName: "x",
      binName: "y",
      envOverride: "Z",
      mcpGuards: "not-an-object",
      expectedMcpServers: "also-not-array",
      slashCommands: 42,
    };
    fs = new MemFs().file(USER_CONFIG, JSON.stringify(config));
    const service = new RuntimeConfigService(fs, env, paths);
    const resolved = await service.resolveRuntime();

    expect(resolved.mcpGuards).toBeUndefined();
    expect(resolved.expectedMcpServers).toBeUndefined();
    expect(resolved.slashCommands).toBeUndefined();
  });
});
