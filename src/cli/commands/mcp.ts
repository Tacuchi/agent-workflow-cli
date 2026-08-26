import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runHarness } from "../../application/dev-only-services.js";
import { runElicitationStdio } from "../../application/elicitation-stdio.js";
import {
  type StoredMcpConnection,
  resolveMcpConnectionSelection,
} from "../../application/mcp-connections-service.js";
import { DbhubLauncherError, runDbhubLauncher } from "../../application/mcp-dbhub-launcher.js";
import { runMcpDoctor } from "../../application/mcp-doctor-service.js";
import {
  type McpRemoveInput,
  type McpRemoveResult,
  runMcpRemove,
} from "../../application/mcp-remove-service.js";
import type { McpScopeRefusal } from "../../application/mcp-scope-common.js";
import {
  type McpSetupInput,
  type McpSetupResult,
  runMcpSetup,
} from "../../application/mcp-setup-service.js";
import {
  type WarpPostInstallHint,
  buildWarpPostInstallHint,
  formatWarpPostInstallHint,
} from "../../application/mcp-warp-postinstall-hint.js";
import {
  resolveWarpGlobalMcpPath,
  resolveWarpProjectMcpPath,
} from "../../application/multiroot/warp.js";
import { PathsService } from "../../application/paths-service.js";
import {
  type WorklineMaterialization,
  ensureWorklineMaterialized,
  previewWorklineMaterialization,
} from "../../application/workspace-materialization-service.js";
import { type HarnessId, MCP_FILE_HOSTS, harnessById } from "../../domain/harnesses.js";
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
    "MCP server tooling. `serve` corre el servidor propio de Workline, que presenta una frontera humana con el selector nativo del host por elicitation; su salida estándar es el canal JSON-RPC. Connections come from mcp-connections.json. Subcomandos: serve | dbhub [--instance i] | setup/remove/doctor [--host h] [--instance i|--all-connections] [--workspace dir] [--global] [--dry-run] [--force] | warp-status.",
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
    if (subcommand === "serve") return runServeSub(args);
    if (subcommand === "dbhub") return runDbhubSub(args, ctx);
    if (subcommand === "setup") return runSetupSub(args, ctx);
    if (subcommand === "remove") return runRemoveSub(args, ctx);
    if (subcommand === "doctor") return runDoctorSub(args, ctx);
    if (subcommand === "warp-status") return runWarpStatusSub(args, ctx);
    return fail(
      "INVALID_INPUT",
      "mcp requiere subcomando: serve | dbhub [--instance <nombre>] | setup | remove | doctor | warp-status",
    );
  },
};

/**
 * El servidor propio, hablando por la entrada y la salida de ESTE proceso.
 *
 * No devuelve datos para renderizar y no puede: la salida estándar ya está tomada
 * por el protocolo, así que cualquier cosa que el renderizador imprimiera ahí
 * corrompería la sesión del cliente. Por eso `data` viaja indefinido.
 */
async function runServeSub(args: ParsedArgs): Promise<CommandResult> {
  // Qué host lo lanzó: el propio host lo dice al registrarlo, porque el servidor
  // no puede detectarlo desde adentro. Sólo habilita una vía observada; no se usa
  // para atribuir una negativa o cancelación posterior.
  const declared = args.values.get("host");
  const spec = declared === undefined ? null : harnessById(declared as HarnessId);
  await runElicitationStdio({
    input: process.stdin,
    output: process.stdout,
    diagnostics: process.stderr,
    via: spec?.structuredChoice.mcpElicitation ?? {
      available: false,
      reason: "el servidor se lanzó sin declarar en qué host corre (--host)",
    },
  });
  return { ok: true, exitCode: 0 };
}

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

  // All workspace-scoped MCP artifacts share Workline's resolved root. An
  // explicit --workspace remains an intentional override; raw process cwd is
  // only the invocation coordinate and may be a source subdirectory.
  const workspace = args.values.get("workspace") ?? ctx.paths.workspaceDir();
  const scopeInput = args.flags.has("--global")
    ? ({ scope: "global" } as const)
    : ({ scope: "workspace", workspace } as const);
  const result = await runMcpSetupWithMaterialization(ctx, {
    hosts: hosts.value,
    connections: connections.value,
    ...scopeInput,
    dryRun: args.flags.has("--dry-run"),
    ...(args.flags.has("--force") ? { globalApproval: "explicit-cli-force" as const } : {}),
  });

  if ("ok" in result) {
    return fail("GLOBAL_REQUIRES_FORCE", result.hint, result, result.exitCode);
  }

  const hasProblems = result.errors.length > 0 || result.conflicts.length > 0;
  const warpHints = !hasProblems
    ? buildWarpHintsFor(
        hosts.value,
        connections.value.map((connection) => connection.name),
        scopeInput.scope,
        workspace,
      )
    : [];
  return {
    ok: !hasProblems,
    data: { ...result, ...(warpHints.length > 0 ? { warp_hints: warpHints } : {}) },
    ...(hasProblems
      ? {
          error: {
            code: "MCP_SETUP_PARTIAL",
            message: `${result.errors.length} error(es) y ${result.conflicts.length} conflicto(s) durante setup; ver data.errors y data.conflicts`,
          },
        }
      : {}),
    exitCode: hasProblems ? 1 : 0,
  };
}

/**
 * MCP writers use host-native synchronous file APIs, so the generic guarded
 * filesystem cannot observe their mutation. Preflight with the writer's own
 * dry-run path, materialize only when that preflight has a real effect, then
 * run the actual write. This preserves pure conflicts/skips and puts the
 * canonical marker in place before the first host config is touched.
 */
async function runMcpSetupWithMaterialization(
  ctx: CliContext,
  input: McpSetupInput,
): Promise<McpSetupResult | McpScopeRefusal> {
  if (input.scope !== "workspace") return runMcpSetup(ctx.env, input);

  const preview = runMcpSetup(ctx.env, { ...input, dryRun: true });
  if ("ok" in preview) return preview;
  if (!hasPendingMcpMutation(preview.applied)) {
    return input.dryRun ? preview : runMcpSetup(ctx.env, input);
  }

  const materialization = await materializeMcpWorkspace(
    ctx,
    input.workspace,
    input.dryRun === true,
  );
  if (input.dryRun) return { ...preview, materialization };

  const result = runMcpSetup(ctx.env, input);
  return "ok" in result ? result : { ...result, materialization };
}

async function runMcpRemoveWithMaterialization(
  ctx: CliContext,
  input: McpRemoveInput,
): Promise<McpRemoveResult | McpScopeRefusal> {
  if (input.scope !== "workspace") return runMcpRemove(ctx.env, input);

  const preview = runMcpRemove(ctx.env, { ...input, dryRun: true });
  if ("ok" in preview) return preview;
  if (!hasPendingMcpMutation(preview.removed)) {
    return input.dryRun ? preview : runMcpRemove(ctx.env, input);
  }

  const materialization = await materializeMcpWorkspace(
    ctx,
    input.workspace,
    input.dryRun === true,
  );
  if (input.dryRun) return { ...preview, materialization };

  const result = runMcpRemove(ctx.env, input);
  return "ok" in result ? result : { ...result, materialization };
}

function hasPendingMcpMutation(results: readonly { action: string }[]): boolean {
  return results.some((result) => result.action === "dry-run");
}

async function materializeMcpWorkspace(
  ctx: CliContext,
  workspace: string,
  dryRun: boolean,
): Promise<WorklineMaterialization> {
  const root = resolve(workspace);
  const currentRoot = resolve(ctx.paths.workspaceDir());
  const paths =
    root === currentRoot
      ? ctx.paths
      : new PathsService(ctx.paths.namespace, ctx.env.homeDir(), root);
  const fs = ctx.rawFs ?? ctx.fs;
  return dryRun
    ? await previewWorklineMaterialization(fs, paths)
    : await ensureWorklineMaterialized(fs, paths);
}

function buildWarpHintsFor(
  hosts: McpHost[],
  instances: McpInstance[],
  scope: "workspace" | "global",
  workspace: string,
): WarpPostInstallHint[] {
  if (!hosts.includes("warp")) return [];
  const file =
    scope === "global"
      ? (resolveWarpGlobalMcpPath() ?? "~/.warp/.mcp.json")
      : resolveWarpProjectMcpPath(resolve(workspace));
  return instances.map((instance) =>
    buildWarpPostInstallHint(mcpEntryNameFor(instance), scope, file),
  );
}

async function runWarpStatusSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const workspace = args.values.get("workspace") ?? ctx.paths.workspaceDir();
  const projectFile = resolveWarpProjectMcpPath(resolve(workspace));
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
        : "No se encontró .warp/.mcp.json en el workspace ni en home. Primero registrá una conexión con 'agent-workflow mcp setup --host warp'.",
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

  const workspace = args.values.get("workspace") ?? ctx.paths.workspaceDir();
  const scopeInput = args.flags.has("--global")
    ? ({ scope: "global" } as const)
    : ({ scope: "workspace", workspace } as const);
  const result = await runMcpRemoveWithMaterialization(ctx, {
    hosts: hosts.value,
    connections: connections.value,
    ...scopeInput,
    dryRun: args.flags.has("--dry-run"),
    ...(args.flags.has("--force") ? { globalApproval: "explicit-cli-force" as const } : {}),
  });

  if ("ok" in result) {
    return fail("GLOBAL_REQUIRES_FORCE", result.hint, result, result.exitCode);
  }

  const hasProblems = result.errors.length > 0 || result.conflicts.length > 0;
  return {
    ok: !hasProblems,
    data: result,
    ...(hasProblems
      ? {
          error: {
            code: "MCP_REMOVE_PARTIAL",
            message: `${result.errors.length} error(es) y ${result.conflicts.length} conflicto(s) durante remove; ver data.errors y data.conflicts`,
          },
        }
      : {}),
    exitCode: hasProblems ? 1 : 0,
  };
}

async function runDoctorSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const hosts = resolveHosts(args, ctx);
  if (!("value" in hosts)) return hosts;
  const connections = resolveConnections(args, ctx, true);
  if (!("value" in connections)) return connections;

  const workspace = args.values.get("workspace") ?? ctx.paths.workspaceDir();
  const scopeInput = args.flags.has("--global")
    ? ({ scope: "global" } as const)
    : ({ scope: "workspace", workspace } as const);
  const data = runMcpDoctor(ctx.env, ctx.paths, {
    hosts: hosts.value,
    connections: connections.value,
    ...scopeInput,
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
