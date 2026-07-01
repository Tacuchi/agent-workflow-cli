import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { type SelfMcpPrompts, selfMcpConfig } from "../../src/application/self/mcp-config.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EnvPort } from "../../src/ports/env.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";

class FakeEnv implements EnvPort {
  constructor(
    private readonly root: string,
    private readonly values: Record<string, string | undefined> = {},
  ) {}
  get(name: string) {
    return this.values[name];
  }
  homeDir() {
    return this.root;
  }
  cwd() {
    return this.root;
  }
}

function buildArgs(rest: string[], values: Record<string, string> = {}): ParsedArgs {
  return {
    rest,
    plugin: {},
    flags: new Set(),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(root: string, envValues: Record<string, string | undefined> = {}): CliContext {
  const ns = normalizeNamespace("workflow");
  const paths = new PathsService(ns, root, root);
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  const proc: ProcessPort = {
    async run() {
      throw new Error("process.run should not be called in this test");
    },
    async which() {
      return undefined;
    },
  };
  return {
    fs: {} as never,
    env: new FakeEnv(root, envValues),
    process: proc,
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths,
  };
}

function prompts(): SelfMcpPrompts {
  return {
    async select<T extends string>() {
      return "cancel" as T;
    },
    async input() {
      return "reporting";
    },
  };
}

describe("selfMcpConfig", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "self-mcp-config-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("registra una conexión con DSN env var existente y la lista lista para instalar", async () => {
    const ctx = buildCtx(root, { REPORTING_DATABASE_URL: "postgres://secret" });
    const result = await selfMcpConfig(
      buildArgs(["mcp", "use-env"], { name: "reporting", "dsn-var": "REPORTING_DATABASE_URL" }),
      ctx,
      prompts(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.connection?.server_name).toBe("reporting");
    expect(result.data.connection?.dsn_var).toBe("REPORTING_DATABASE_URL");
    expect(result.data.table).toContain("│ reporting │ REPORTING_DATABASE_URL │ –      │ –     │");
    expect(existsSync(ctx.paths.userMcpConnectionsFile())).toBe(true);
    expect(readFileSync(ctx.paths.userMcpConnectionsFile(), "utf-8")).not.toContain(
      "postgres://secret",
    );
  });

  it("instala en Codex usando el nombre agnóstico y la variable DSN registrada", async () => {
    const ctx = buildCtx(root, { REPORTING_DATABASE_URL: "postgres://secret" });
    await selfMcpConfig(
      buildArgs(["mcp", "use-env"], { name: "reporting", "dsn-var": "REPORTING_DATABASE_URL" }),
      ctx,
      prompts(),
    );

    const result = await selfMcpConfig(
      buildArgs(["mcp", "install-codex"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.setup?.applied[0]?.name).toBe("reporting");
    const config = readFileSync(join(root, ".codex", "config.toml"), "utf-8");
    expect(config).toContain("[mcp_servers.reporting]");
    expect(config).toContain('DBHUB_DSN_VAR = "REPORTING_DATABASE_URL"');
  });

  it("instala en Gemini (host nuevo) escribiendo su settings.json de workspace", async () => {
    const ctx = buildCtx(root, { REPORTING_DATABASE_URL: "postgres://secret" });
    await selfMcpConfig(
      buildArgs(["mcp", "use-env"], { name: "reporting", "dsn-var": "REPORTING_DATABASE_URL" }),
      ctx,
      prompts(),
    );

    const result = await selfMcpConfig(
      buildArgs(["mcp", "install-gemini"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.setup?.applied[0]?.name).toBe("reporting");
    const settings = readFileSync(join(root, ".gemini", "settings.json"), "utf-8");
    expect(settings).toContain("reporting");
    expect(settings).toContain("REPORTING_DATABASE_URL");
  });

  it("crear DSN env var sólo devuelve comandos de ayuda y no registra conexión", async () => {
    const ctx = buildCtx(root);
    const result = await selfMcpConfig(
      buildArgs(["mcp", "create-env"], { name: "sales-qa", "dsn-var": "SALES_QA_DSN" }),
      ctx,
      prompts(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.env_help?.variable).toBe("SALES_QA_DSN");
    expect(result.data.env_help?.next_step).toContain(
      "agent-workflow self mcp use-env --name sales-qa --dsn-var SALES_QA_DSN",
    );
    expect(existsSync(ctx.paths.userMcpConnectionsFile())).toBe(false);
  });
});
