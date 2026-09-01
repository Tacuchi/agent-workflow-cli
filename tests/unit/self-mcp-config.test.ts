import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpHostReceiptFile } from "../../src/application/mcp-host-receipt-store.js";
import { PathsService } from "../../src/application/paths-service.js";
import { type SelfMcpPrompts, selfMcpConfig } from "../../src/application/self/mcp-config.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { ProcessPort } from "../../src/ports/process.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { readPackageVersion } from "../../src/runtime/version.js";
import { FakeEnv } from "../helpers/fake-env.js";

vi.mock("../../src/application/mcp-launch-probe-service.js", () => ({
  // The protocol probe itself is covered by its own unit tests. These tests
  // exercise user-scope descriptor persistence without spawning a child while
  // still asserting that the wizard projects its launch evidence.
  probePersistedMcpSetupEntries: async (
    _paths: unknown,
    _setup: unknown,
    targets: readonly Array<{ host: string; instance: string }>,
  ) => ({
    probes: targets.map((target) => ({
      host: target.host,
      instance: target.instance,
      outcome: "passed" as const,
      phase: "tools/list" as const,
    })),
    errors: [],
  }),
}));

vi.mock("../../src/application/mcp-native-host-check-service.js", () => ({
  // Native host binaries are verified by their dedicated unit tests. The
  // user-scope config suite must never invoke the developer's Claude/Codex.
  checkNativeMcpHosts: async (targets: readonly Array<{ host: string; instance: string }>) => ({
    checks: targets.flatMap((target) =>
      target.host === "claude" || target.host === "codex"
        ? [{ host: target.host, instance: target.instance, outcome: "passed" as const }]
        : [],
    ),
    errors: [],
  }),
  recordNativeMcpHostChecks: async () => {},
}));

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
  namespace = "workflow",
): CliContext {
  const ns = normalizeNamespace(namespace);
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

function expectReliableDescriptor(
  descriptor: { command?: unknown; args?: unknown; env?: unknown },
  host: string,
  namespace = "workflow",
) {
  expect(typeof descriptor.command).toBe("string");
  expect(isAbsolute(descriptor.command as string)).toBe(true);
  expect(Array.isArray(descriptor.args)).toBe(true);
  const args = descriptor.args as string[];
  expect(isAbsolute(args[0] ?? "")).toBe(true);
  expect(args).toEqual([
    args[0],
    "mcp",
    "serve-db",
    "--namespace",
    namespace,
    "--instance",
    "reporting",
    "--host",
    host,
    "--scope",
    "global",
    "--descriptor-generation",
    readPackageVersion(),
  ]);
  expect(descriptor.env).toEqual({});
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
    const registry = readFileSync(ctx.paths.userMcpConnectionsFile(), "utf-8");
    expect(registry).toContain('"provider": "postgres"');
    expect(registry).not.toContain("postgres://secret");
  });

  it("convierte un registro de conexiones corrupto en un diagnóstico accionable", async () => {
    const ctx = buildCtx(home, project);
    mkdirSync(ctx.paths.userDevDir(), { recursive: true });
    writeFileSync(ctx.paths.userMcpConnectionsFile(), "{registro roto", "utf-8");

    const result = await selfMcpConfig(buildArgs(["mcp", "list"]), ctx, prompts());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid registry result");
    expect(result.error?.code).toBe("MCP_CONNECTION_INVALID");
    expect(result.data.registry_error).toMatchObject({
      code: "MCP_CONNECTION_INVALID",
      path: ctx.paths.userMcpConnectionsFile(),
    });
    expect(result.data.summary).toContain("Restaurá mcp-connections.json");
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
    const claude = JSON.parse(globalConfig) as {
      mcpServers: Record<string, { command?: unknown; args?: unknown; env?: unknown }>;
    };
    expectReliableDescriptor(claude.mcpServers.reporting ?? {}, "claude");
    expect(globalConfig).not.toContain("REPORTING_DATABASE_URL");
    expect(globalConfig).not.toContain("postgres://secret");
    expect(existsSync(join(project, ".mcp.json"))).toBe(false);
    expect(result.data.connection?.instalado.claude).toBe("si");
    expect(result.data.setup?.receipts).toMatchObject([
      { host: "claude", instance: "reporting", reload_required: true },
    ]);
    expect(result.data.setup?.launch_probes).toEqual([
      { host: "claude", instance: "reporting", outcome: "passed", phase: "tools/list" },
    ]);
    expect(result.data.setup?.native_checks).toEqual([
      { host: "claude", instance: "reporting", outcome: "passed" },
    ]);
    expect(existsSync(mcpHostReceiptFile(ctx.paths))).toBe(true);
    expect(readFileSync(mcpHostReceiptFile(ctx.paths), "utf-8")).not.toContain("postgres://secret");
  });

  it("evalúa la instalación contra el descriptor global del host y namespace actual", async () => {
    const ctx = buildCtx(
      home,
      project,
      { REPORTING_DATABASE_URL: "postgres://secret" },
      "research",
    );
    await registerReporting(ctx);

    const install = await selfMcpConfig(
      buildArgs(["mcp", "install-gemini"], { name: "reporting" }),
      ctx,
      prompts(),
    );

    expect(install.ok).toBe(true);
    if (!install.ok) throw new Error("expected ok");
    const settings = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf-8")) as {
      mcpServers: Record<string, { command?: unknown; args?: unknown; env?: unknown }>;
    };
    expectReliableDescriptor(settings.mcpServers.reporting ?? {}, "gemini", "research");
    expect(install.data.connection?.instalado.gemini).toBe("si");
    expect(install.data.connection?.host_status.gemini.entry_state).toBe("current");
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
    const parsed = parseToml(config) as Record<string, unknown>;
    const server = (parsed.mcp_servers as Record<string, unknown> | undefined)?.reporting;
    expectReliableDescriptor(
      (server ?? {}) as { command?: unknown; args?: unknown; env?: unknown },
      "codex",
    );
    expect((server as Record<string, unknown> | undefined)?.required).toBe(false);
    expect(config).not.toContain("REPORTING_DATABASE_URL");
    expect(config).not.toContain("postgres://secret");
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
    const gemini = JSON.parse(settings) as {
      mcpServers: Record<string, { command?: unknown; args?: unknown; env?: unknown }>;
    };
    expectReliableDescriptor(gemini.mcpServers.reporting ?? {}, "gemini");
    expect(settings).not.toContain("REPORTING_DATABASE_URL");
    expect(settings).not.toContain("postgres://secret");
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

  it("no oculta un ledger de recibos corrupto: cada host queda failed y accionable", async () => {
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);
    mkdirSync(ctx.paths.userDevDir(), { recursive: true });
    writeFileSync(mcpHostReceiptFile(ctx.paths), "{recibo roto", "utf-8");

    const result = await selfMcpConfig(buildArgs(["mcp", "list"]), ctx, prompts());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.connections?.[0]?.host_status.claude).toMatchObject({
      state: "failed",
      entry_state: "missing",
      receipt_failure: { phase: "receipt", code: "MCP_RECEIPT_MALFORMED" },
    });
    expect(result.data.connections?.[0]?.host_status.codex.state).toBe("failed");
  });

  it("no presenta como configurado un descriptor actual que perdió su recibo", async () => {
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);
    await selfMcpConfig(
      buildArgs(["mcp", "install-claude"], { name: "reporting" }),
      ctx,
      prompts(),
    );
    rmSync(mcpHostReceiptFile(ctx.paths));

    const result = await selfMcpConfig(buildArgs(["mcp", "list"]), ctx, prompts());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.connections?.[0]?.host_status.claude).toMatchObject({
      state: "failed",
      entry_state: "current",
      launchable: false,
      reload_required: true,
      receipt_failure: { phase: "receipt", code: "MCP_RECEIPT_NOT_FOUND" },
    });
  });

  it("descarta evidencia de launch/load cuyo digest no coincide con el descriptor actual", async () => {
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);
    await selfMcpConfig(
      buildArgs(["mcp", "install-claude"], { name: "reporting" }),
      ctx,
      prompts(),
    );
    const receiptFile = mcpHostReceiptFile(ctx.paths);
    const book = JSON.parse(readFileSync(receiptFile, "utf-8")) as {
      receipts: Array<Record<string, unknown>>;
    };
    book.receipts[0] = {
      ...book.receipts[0],
      descriptor_digest: `sha256:${"0".repeat(64)}`,
    };
    writeFileSync(receiptFile, `${JSON.stringify(book, null, 2)}\n`, "utf-8");

    const result = await selfMcpConfig(buildArgs(["mcp", "list"]), ctx, prompts());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.connections?.[0]?.host_status.claude).toMatchObject({
      state: "failed",
      entry_state: "current",
      launchable: false,
      reload_required: true,
      receipt_failure: { phase: "descriptor", code: "MCP_RECEIPT_DESCRIPTOR_STALE" },
    });
  });

  it("expone un fallo nativo durable cuando el recibo corresponde al descriptor vigente", async () => {
    const ctx = buildCtx(home, project, { REPORTING_DATABASE_URL: "postgres://secret" });
    await registerReporting(ctx);
    await selfMcpConfig(
      buildArgs(["mcp", "install-claude"], { name: "reporting" }),
      ctx,
      prompts(),
    );
    const receiptFile = mcpHostReceiptFile(ctx.paths);
    const book = JSON.parse(readFileSync(receiptFile, "utf-8")) as {
      receipts: Array<Record<string, unknown>>;
    };
    book.receipts[0] = {
      ...book.receipts[0],
      last_native_check_failure: {
        observed_at: "2026-08-31T12:04:00.000Z",
        code: "HOST_ENTRY_NOT_VISIBLE",
      },
    };
    writeFileSync(receiptFile, `${JSON.stringify(book, null, 2)}\n`, "utf-8");

    const result = await selfMcpConfig(buildArgs(["mcp", "list"]), ctx, prompts());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.data.connections?.[0]?.host_status.claude).toMatchObject({
      state: "failed",
      entry_state: "current",
      native_check_failure: {
        observed_at: "2026-08-31T12:04:00.000Z",
        code: "HOST_ENTRY_NOT_VISIBLE",
      },
    });
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
    expect(readFileSync(mcpHostReceiptFile(ctx.paths), "utf-8")).not.toContain("reporting");
    expect(readFileSync(join(project, ".mcp.json"), "utf-8")).toBe(preexisting);
    expect(result.data.remove?.reload_required).toEqual([
      expect.objectContaining({ host: "claude", instance: "reporting", reload_required: true }),
      expect.objectContaining({ host: "codex", instance: "reporting", reload_required: true }),
    ]);
    expect(result.data.summary).toContain("Recarga requerida");
    expect(result.data.summary).toContain("Reconnect");
    expect(result.data.summary).toContain("Restart");
  });

  it("remove conserva una entrada global homónima ajena y reporta eliminación parcial", async () => {
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

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected partial failure");
    expect(result.error?.code).toBe("MCP_REMOVE_PARTIAL");
    expect(result.data.preserved_foreign).toEqual(["gemini"]);
    // The foreign entry survives with its relevant bytes intact; ours in claude is gone.
    const gemini = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf-8"));
    expect(gemini.mcpServers.reporting.args).toEqual(["my-server.js"]);
    expect(readFileSync(join(home, ".claude.json"), "utf-8")).not.toContain('"reporting"');
    // El registro no se borra mientras queda un host en conflicto: así la TUI y
    // el CLI pueden mostrar exactamente qué configuración debe resolver la persona.
    expect(readFileSync(ctx.paths.userMcpConnectionsFile(), "utf-8")).toContain("reporting");
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
