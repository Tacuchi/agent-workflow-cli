import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { type SelfMcpPrompts, selfMcpConfig } from "../../src/application/self/mcp-config.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";

// home ≠ cwd on purpose: install/remove/doctor operate on the user scope (home),
// so a write landing under the project dir is a regression these tests catch.
function buildArgs(rest: string[], values: Record<string, string> = {}): ParsedArgs {
  return {
    rest,
    plugin: {},
    flags: new Set(),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(
  home: string,
  project: string,
  envValues: Record<string, string | undefined> = {},
): CliContext {
  const ns = normalizeNamespace("workflow");
  const paths = new PathsService(ns, home, project);
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
    env: new FakeEnv(home, project, envValues),
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

async function registerReporting(ctx: CliContext) {
  await selfMcpConfig(
    buildArgs(["mcp", "use-env"], { name: "reporting", "dsn-var": "REPORTING_DATABASE_URL" }),
    ctx,
    prompts(),
  );
}

describe("selfMcpConfig", () => {
  let root: string;
  let home: string;
  let project: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "self-mcp-config-"));
    home = join(root, "home");
    project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    // Pin every global-path override so opencode/crush/warp resolve under the
    // sandbox home — never the developer's real config (CRUSH_GLOBAL_CONFIG
    // short-circuits crushGlobalMcpFile; LOCALAPPDATA feeds the win32 paths).
    vi.stubEnv("XDG_CONFIG_HOME", "");
    vi.stubEnv("CRUSH_GLOBAL_CONFIG", "");
    vi.stubEnv("LOCALAPPDATA", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("registra una conexión con DSN env var existente y la lista lista para instalar", async () => {
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
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

  it("instala en Claude en el scope de usuario (~/.claude.json) sin tocar el .mcp.json del proyecto", async () => {
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);

    const result = await selfMcpConfig(
      buildArgs(["mcp", "install-claude"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const globalConfig = readFileSync(join(home, ".claude.json"), "utf-8");
    expect(globalConfig).toContain('"reporting"');
    expect(existsSync(join(project, ".mcp.json"))).toBe(false);
    expect(result.data.connection?.instalado.claude).toBe("si");
  });

  it("no migra ni toca un .mcp.json de proyecto preexistente al instalar", async () => {
    const preexisting = `${JSON.stringify(
      { mcpServers: { legacy: { command: "npx", args: [], env: {} } } },
      null,
      2,
    )}\n`;
    writeFileSync(join(project, ".mcp.json"), preexisting, "utf-8");
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);

    await selfMcpConfig(
      buildArgs(["mcp", "install-claude"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    expect(readFileSync(join(project, ".mcp.json"), "utf-8")).toBe(preexisting);
  });

  it("instala en Codex escribiendo el config.toml global del home, no el del proyecto", async () => {
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);

    const result = await selfMcpConfig(
      buildArgs(["mcp", "install-codex"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.setup?.applied[0]?.name).toBe("reporting");
    const config = readFileSync(join(home, ".codex", "config.toml"), "utf-8");
    expect(config).toContain("[mcp_servers.reporting]");
    expect(config).toContain('DBHUB_DSN_VAR = "REPORTING_DATABASE_URL"');
    expect(existsSync(join(project, ".codex", "config.toml"))).toBe(false);
  });

  it("instala en Gemini escribiendo el settings.json global del home", async () => {
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);

    const result = await selfMcpConfig(
      buildArgs(["mcp", "install-gemini"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    const settings = readFileSync(join(home, ".gemini", "settings.json"), "utf-8");
    expect(settings).toContain("reporting");
    expect(settings).toContain("REPORTING_DATABASE_URL");
    expect(existsSync(join(project, ".gemini", "settings.json"))).toBe(false);
  });

  it("tras install-opencode (XDG global), la tabla de estado reporta opencode como instalado (si)", async () => {
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);

    const result = await selfMcpConfig(
      buildArgs(["mcp", "install-opencode"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // Read-back path: connectionView -> installStatus -> readMcpEntry must SEE the
    // opencode entry it just wrote (global XDG file), else the wizard lies.
    expect(existsSync(join(home, ".config", "opencode", "opencode.json"))).toBe(true);
    expect(result.data.connection?.instalado.opencode).toBe("si");
  });

  it("reporta drift cuando la entrada global difiere del shape esperado", async () => {
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);
    writeFileSync(
      join(home, ".claude.json"),
      `${JSON.stringify(
        { mcpServers: { reporting: { command: "other-cmd", args: [], env: {} } } },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const result = await selfMcpConfig(buildArgs(["mcp", "list"]), ctx, prompts());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.connections?.[0]?.instalado.claude).toBe("drift");
  });

  it("remove elimina la entrada de los configs globales y conserva intacto el proyecto", async () => {
    const preexisting = `${JSON.stringify(
      { mcpServers: { legacy: { command: "npx", args: [], env: {} } } },
      null,
      2,
    )}\n`;
    writeFileSync(join(project, ".mcp.json"), preexisting, "utf-8");
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);
    await selfMcpConfig(
      buildArgs(["mcp", "install-claude"], { name: "reporting" }),
      ctx,
      prompts(),
    );
    await selfMcpConfig(buildArgs(["mcp", "install-codex"], { name: "reporting" }), ctx, prompts());

    const result = await selfMcpConfig(
      buildArgs(["mcp", "remove"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(readFileSync(join(home, ".claude.json"), "utf-8")).not.toContain('"reporting"');
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf-8")).not.toContain(
      "mcp_servers.reporting",
    );
    expect(existsSync(ctx.paths.userMcpConnectionsFile())).toBe(true);
    expect(readFileSync(ctx.paths.userMcpConnectionsFile(), "utf-8")).not.toContain("reporting");
    expect(readFileSync(join(project, ".mcp.json"), "utf-8")).toBe(preexisting);
  });

  it("remove conserva una entrada global homónima ajena (guard de ownership)", async () => {
    // The user has THEIR OWN 'reporting' server in Gemini's global settings —
    // this tool never wrote it. Remove must not touch it.
    const foreign = {
      mcpServers: { reporting: { command: "node", args: ["my-server.js"], env: {} } },
    };
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "settings.json"),
      `${JSON.stringify(foreign, null, 2)}\n`,
      "utf-8",
    );
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);
    await selfMcpConfig(
      buildArgs(["mcp", "install-claude"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    const result = await selfMcpConfig(
      buildArgs(["mcp", "remove"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.preserved_foreign).toEqual(["gemini"]);
    // The foreign entry survives with its relevant bytes intact; ours in claude is gone.
    const gemini = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf-8"));
    expect(gemini.mcpServers.reporting.args).toEqual(["my-server.js"]);
    expect(readFileSync(join(home, ".claude.json"), "utf-8")).not.toContain('"reporting"');
  });

  it("crear DSN env var sólo devuelve comandos de ayuda y no registra conexión", async () => {
    const ctx = buildCtx(home, project);
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
