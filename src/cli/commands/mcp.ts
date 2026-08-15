import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runHarness } from "../../application/dev-only-services.js";
import {
  type StoredMcpConnection,
  resolveMcpConnectionSelection,
} from "../../application/mcp-connections-service.js";
import { DbhubLauncherError, runDbhubLauncher } from "../../application/mcp-dbhub-launcher.js";
import { runMcpDoctor } from "../../application/mcp-doctor-service.js";
import { runMcpRemove } from "../../application/mcp-remove-service.js";
import { runMcpSetup } from "../../application/mcp-setup-service.js";
import {
  type WarpPostInstallHint,
  buildWarpPostInstallHint,
  formatWarpPostInstallHint,
} from "../../application/mcp-warp-postinstall-hint.js";
import {
  resolveWarpGlobalMcpPath,
  resolveWarpProjectMcpPath,
} from "../../application/multiroot/warp.js";
import { MCP_FILE_HOSTS, harnessById } from "../../domain/harnesses.js";
import { type McpHost, type McpInstance, mcpEntryNameFor } from "../../domain/mcp-entry.js";
import type { CommandResult, ExitCode } from "../../domain/types.js";
import type { ParsedArgs } from "../parser.js";
import type { CliCommand } from "../registry.js";
import { fail } from "../render.js";
import type { CliContext } from "../types.js";

// File-writing hosts — single source in the domain (excludes oz, which has no
// file writer). The TUI's host picker reads the same list.
const FILE_HOSTS: readonly McpHost[] = MCP_FILE_HOSTS;
const HOST_VALUES: ReadonlySet<string> = new Set([...FILE_HOSTS, "all"]);

export const mcpCommand: CliCommand = {
  name: "mcp",
  describe:
    "MCP server tooling. Connections come from mcp-connections.json. Subcomandos: dbhub [--instance i] | setup/remove/doctor [--host h] [--instance i|--all-connections] [--workspace dir] [--global] [--dry-run] [--force] | warp-status.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (
      (subcommand === "setup" ||
        subcommand === "remove" ||
        subcommand === "doctor" ||
        subcommand === "warp-status") &&
      args.rest.length > 1
    ) {
      return fail(
        "INVALID_INPUT",
        "Los subcomandos MCP no aceptan una conexión posicional. Usá --instance <nombre> o --all-connections cuando el subcomando permite fan-out.",
      );
    }
    if (subcommand === "dbhub") return runDbhubSub(args, ctx);
    if (subcommand === "setup") return runSetupSub(args, ctx);
    if (subcommand === "remove") return runRemoveSub(args, ctx);
    if (subcommand === "doctor") return runDoctorSub(args, ctx);
    if (subcommand === "warp-status") return runWarpStatusSub(args, ctx);
    return fail(
      "INVALID_INPUT",
      "mcp requiere subcomando: dbhub [--instance <nombre>] | setup | remove | doctor | warp-status",
    );
  },
};

async function runDbhubSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  if (args.rest[1] !== undefined) {
    return fail(
      "INVALID_INPUT",
      "mcp dbhub no acepta una conexión posicional. Usá --instance <nombre>.",
    );
  }
  const connections = resolveConnections(args, ctx, false);
  if (!("value" in connections)) return connections;
  const connection = connections.value[0];
  if (connection === undefined) {
    return fail("NO_MCP_CONNECTIONS", "No hay conexiones MCP seleccionadas para dbhub.");
  }
  try {
    const result = await runDbhubLauncher({
      instance: connection.name,
      deps: {
        env: { ...process.env },
        paths: ctx.paths,
        platform: process.platform,
      },
    });
    return { ok: true, data: undefined, exitCode: clampExit(result.exitCode) };
  } catch (err) {
    if (err instanceof DbhubLauncherError) {
      return fail("DBHUB_LAUNCHER_FAILED", err.message);
    }
    throw err;
  }
}

async function runSetupSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const hosts = resolveHosts(args, ctx);
  if (!("value" in hosts)) return hosts;
  const connections = resolveConnections(args, ctx, true);
  if (!("value" in connections)) return connections;

  const workspace = args.values.get("workspace");
  const scope: "workspace" | "global" = args.flags.has("--global") ? "global" : "workspace";
  const result = runMcpSetup(ctx.env, {
    hosts: hosts.value,
    connections: connections.value,
    scope,
    ...(workspace !== undefined ? { workspace } : {}),
    dryRun: args.flags.has("--dry-run"),
    force: args.flags.has("--force"),
  });

  if ("ok" in result) {
    return fail("GLOBAL_REQUIRES_FORCE", result.hint, result, result.exitCode);
  }

  const hasErrors = result.errors.length > 0;
  const warpHints = !hasErrors
    ? buildWarpHintsFor(
        hosts.value,
        connections.value.map((connection) => connection.name),
        scope,
        ctx,
        workspace,
      )
    : [];
  return {
    ok: !hasErrors,
    data: { ...result, ...(warpHints.length > 0 ? { warp_hints: warpHints } : {}) },
    ...(hasErrors
      ? {
          error: {
            code: "MCP_SETUP_PARTIAL",
            message: `${result.errors.length} error(es) durante setup; ver data.errors`,
          },
        }
      : {}),
    exitCode: hasErrors ? 1 : 0,
  };
}

function buildWarpHintsFor(
  hosts: McpHost[],
  instances: McpInstance[],
  scope: "workspace" | "global",
  ctx: CliContext,
  workspace: string | undefined,
): WarpPostInstallHint[] {
  if (!hosts.includes("warp")) return [];
  const file =
    scope === "global"
      ? (resolveWarpGlobalMcpPath() ?? "~/.warp/.mcp.json")
      : resolveWarpProjectMcpPath(resolve(workspace ?? ctx.env.cwd()));
  return instances.map((instance) =>
    buildWarpPostInstallHint(mcpEntryNameFor(instance), scope, file),
  );
}

async function runWarpStatusSub(_args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const projectFile = resolveWarpProjectMcpPath(resolve(ctx.env.cwd()));
  const globalFile = resolveWarpGlobalMcpPath() ?? `${homedir()}/.warp/.mcp.json`;
  const sources = [
    { scope: "workspace" as const, file: projectFile },
    { scope: "global" as const, file: globalFile },
  ];
  const reports = sources.map(({ scope, file }) => {
    const exists = existsSync(file);
    const servers = exists ? readMcpServersFromFile(file) : [];
    const hint = buildWarpPostInstallHint(servers[0] ?? "<server>", scope, file);
    return { scope, file, exists, servers, hint, hint_formatted: formatWarpPostInstallHint(hint) };
  });
  const anyDetected = reports.some((r) => r.exists);
  return {
    ok: true,
    data: {
      reports,
      summary: anyDetected
        ? "Archivos .warp/.mcp.json detectados. Activá 'File-based MCP Servers' en Warp Settings si todavía no lo hiciste."
        : "No se encontró .warp/.mcp.json en cwd ni en home. Primero registrá una conexión con 'agent-workflow mcp setup --host warp'.",
    },
    exitCode: 0,
  };
}

function readMcpServersFromFile(file: string): string[] {
  try {
    const text = readFileSync(file, "utf-8");
    if (text.trim().length === 0) return [];
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    if (!parsed.mcpServers || typeof parsed.mcpServers !== "object") return [];
    return Object.keys(parsed.mcpServers);
  } catch {
    return [];
  }
}

async function runRemoveSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const hosts = resolveHosts(args, ctx);
  if (!("value" in hosts)) return hosts;
  const connections = resolveConnections(args, ctx, true);
  if (!("value" in connections)) return connections;

  const workspace = args.values.get("workspace");
  const result = runMcpRemove(ctx.env, {
    hosts: hosts.value,
    connections: connections.value,
    scope: args.flags.has("--global") ? "global" : "workspace",
    ...(workspace !== undefined ? { workspace } : {}),
    dryRun: args.flags.has("--dry-run"),
    force: args.flags.has("--force"),
  });

  if ("ok" in result) {
    return fail("GLOBAL_REQUIRES_FORCE", result.hint, result, result.exitCode);
  }

  const hasErrors = result.errors.length > 0;
  return {
    ok: !hasErrors,
    data: result,
    ...(hasErrors
      ? {
          error: {
            code: "MCP_REMOVE_PARTIAL",
            message: `${result.errors.length} error(es) durante remove; ver data.errors`,
          },
        }
      : {}),
    exitCode: hasErrors ? 1 : 0,
  };
}

async function runDoctorSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const hosts = resolveHosts(args, ctx);
  if (!("value" in hosts)) return hosts;
  const connections = resolveConnections(args, ctx, true);
  if (!("value" in connections)) return connections;

  const workspace = args.values.get("workspace");
  const data = runMcpDoctor(ctx.env, ctx.paths, {
    hosts: hosts.value,
    connections: connections.value,
    scope: args.flags.has("--global") ? "global" : "workspace",
    ...(workspace !== undefined ? { workspace } : {}),
  });

  const okCount = data.summary.ok;
  const total = data.reports.length;
  const allOk = okCount === total;
  return {
    ok: allOk,
    data,
    ...(allOk
      ? {}
      : {
          error: {
            code: "MCP_DOCTOR_DRIFT",
            message: `${total - okCount}/${total} entradas con drift (ver data.reports)`,
          },
        }),
    exitCode: allOk ? 0 : 1,
  };
}

/** Exported for tests: host-harness detection must cover every file-writing host. */
export function resolveHosts(
  args: ParsedArgs,
  ctx: CliContext,
): { value: McpHost[] } | CommandResult {
  const flag = args.values.get("host");
  if (flag === undefined) {
    // No --host: write only to the harness we are running inside, resolved from
    // the registry.
    const harness = runHarness((k) => ctx.env.get(k));
    const spec = harness.harness === "unknown" ? null : harnessById(harness.harness);
    if (spec?.mcpHostId) return { value: [spec.mcpHostId] };
    // We could NOT tell which host we are in — either it exports no env marker
    // to its subprocesses (Kimi Code among them) or it takes MCP through a
    // launch flag instead of a config file (Oz). Falling back to "write into
    // every host" turned that ignorance into edits the user never asked for,
    // across configs they may not even use. Ask instead.
    const reason =
      spec === null
        ? "no pude identificar el host: no exporta marcadores de entorno a sus subprocesos"
        : `'${spec.label}' no escribe un archivo de configuración MCP (toma servidores por flag de arranque)`;
    return fail(
      "HOST_REQUIRED",
      `${reason}. Indicá el destino con --host <${[...FILE_HOSTS].join("|")}> (o --host all para todos). Para ver qué hosts hay en esta máquina: 'agent-workflow self detect-hosts'.`,
    );
  }
  if (!HOST_VALUES.has(flag)) {
    const validList = [...FILE_HOSTS, "all"].join(" | ");
    return fail("INVALID_INPUT", `--host inválido: '${flag}'. Valores válidos: ${validList}`);
  }
  if (flag === "all") return { value: [...FILE_HOSTS] };
  return { value: [flag as McpHost] };
}

function resolveConnections(
  args: ParsedArgs,
  ctx: CliContext,
  allowAll: boolean,
): { value: StoredMcpConnection[] } | CommandResult {
  if (args.values.has("dsn-var") || args.flags.has("--dsn-var")) {
    return fail(
      "MCP_DSN_OVERRIDE_UNSUPPORTED",
      "La variable DSN se declara sólo en mcp-connections.json mediante 'aw self mcp use-env'.",
    );
  }
  const allConnections = args.flags.has("--all-connections");
  if (args.values.has("all-connections")) {
    return fail("INVALID_INPUT", "--all-connections no recibe valor.");
  }
  if (allConnections && !allowAll) {
    return fail(
      "MCP_CONNECTION_SELECTION_CONFLICT",
      "mcp dbhub ejecuta una sola conexión; usá --instance <nombre>.",
    );
  }
  const instance = args.values.get("instance");
  const selection = resolveMcpConnectionSelection(ctx.paths, {
    ...(instance !== undefined ? { instance } : {}),
    ...(allConnections ? { allConnections: true } : {}),
  });
  if (!selection.ok) return fail(selection.code, selection.message);
  return { value: selection.connections };
}

function clampExit(code: number): ExitCode {
  if (code === 0) return 0;
  if (code === 2) return 2;
  return 1;
}
