import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PostgresReadonlyTools } from "../../adapters/postgres-readonly-tools.js";
import { runDatabaseMcpStdio } from "../../application/database-mcp-stdio.js";
import { DatabaseToolCatalog } from "../../application/database-tool-catalog.js";
import { runHarness } from "../../application/dev-only-services.js";
import { runElicitationStdio } from "../../application/elicitation-stdio.js";
import {
  type StoredMcpConnection,
  resolveMcpConnectionSelection,
} from "../../application/mcp-connections-service.js";
import { runMcpDoctor } from "../../application/mcp-doctor-service.js";
import { classifyMcpEntry } from "../../application/mcp-entry-classification.js";
import { readMcpEntry } from "../../application/mcp-host-reader.js";
import {
  type McpReceiptScope,
  digestMcpReceiptDescriptor,
} from "../../application/mcp-host-receipt-service.js";
import {
  openMcpHostReceiptService,
  registerPersistedMcpDescriptor,
} from "../../application/mcp-host-receipts.js";
import { probePersistedMcpSetupEntries } from "../../application/mcp-launch-probe-service.js";
import {
  type McpMigrationResult,
  runMcpMigration,
} from "../../application/mcp-migration-service.js";
import {
  checkNativeMcpHosts,
  recordNativeMcpHostChecks,
} from "../../application/mcp-native-host-check-service.js";
import { registerMcpSetupReceipts } from "../../application/mcp-receipt-registration-service.js";
import { removeMcpRemoveReceipts } from "../../application/mcp-receipt-removal-service.js";
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
import { runMcpStdioProbe } from "../../application/mcp-stdio-probe.js";
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
import { DATABASE_TOOL_DESCRIPTORS, type ToolFailure } from "../../domain/database-tools.js";
import { type HarnessId, MCP_FILE_HOSTS, harnessById } from "../../domain/harnesses.js";
import {
  type McpHost,
  type McpInstance,
  buildMcpEntry,
  mcpEntryNameFor,
} from "../../domain/mcp-entry.js";
import type { CommandResult } from "../../domain/types.js";
import type { PostgresRoleInspection } from "../../ports/postgres-tools.js";
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
    "MCP server tooling. `serve` corre el servidor de elicitation de Workline y `serve-db` sirve las tools PostgreSQL; ambas reservan stdout para JSON-RPC. `dbhub` queda como alias deprecado de serve-db. Subcomandos: serve | serve-db [--instance i] | dbhub [--instance i] | setup/remove/doctor [--host h] [--instance i|--all-connections] [--workspace dir] [--global] [--dry-run] [--force] | migrate [--host h] [--instance i|--all-connections] [--workspace dir] [--global] [--apply --force] | warp-status.",
  async execute(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
    const subcommand = args.rest[0];
    if (
      (subcommand === "setup" ||
        subcommand === "remove" ||
        subcommand === "doctor" ||
        subcommand === "migrate" ||
        subcommand === "warp-status") &&
      args.rest.length > 1
    ) {
      return fail(
        "INVALID_INPUT",
        "Los subcomandos MCP no aceptan una conexión posicional. Usá --instance <nombre> o --all-connections cuando el subcomando permite fan-out.",
      );
    }
    if (subcommand === "serve") return runServeSub(args);
    if (subcommand === "serve-db") return runServeDbSub(args, ctx);
    if (subcommand === "dbhub") return runDbhubSub(args, ctx);
    if (subcommand === "setup") return runSetupSub(args, ctx);
    if (subcommand === "remove") return runRemoveSub(args, ctx);
    if (subcommand === "doctor") return runDoctorSub(args, ctx);
    if (subcommand === "migrate") return await runMigrateSub(args, ctx);
    if (subcommand === "warp-status") return runWarpStatusSub(args, ctx);
    return fail(
      "INVALID_INPUT",
      "mcp requiere subcomando: serve | serve-db [--instance <nombre>] | dbhub [--instance <nombre>] | setup | remove | doctor | migrate | warp-status",
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
  process.stderr.write("aw mcp dbhub está deprecado; usá 'aw mcp serve-db'.\n");
  return await runServeDbSub(args, ctx);
}

async function runServeDbSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  if (args.rest[1] !== undefined) {
    return serveBootstrapFailure(
      "mcp serve-db no acepta una conexión posicional. Usá --instance <nombre>.",
    );
  }
  if (args.flags.has("--instance")) return serveBootstrapFailure("--instance requiere un nombre.");
  const connections = resolveConnections(args, ctx, false);
  if (!("value" in connections))
    return serveBootstrapFailure("No se pudo resolver la conexión MCP.");
  const connection = connections.value[0];
  if (connection === undefined) {
    return serveBootstrapFailure("No hay conexiones MCP seleccionadas para serve-db.");
  }
  const catalog = new DatabaseToolCatalog({
    paths: ctx.paths,
    env: ctx.env,
    postgres: new PostgresReadonlyTools(),
  });
  const onHostLoadObserved = resolveHostLoadObservation(args, ctx, connection);
  await runDatabaseMcpStdio({
    input: process.stdin,
    output: process.stdout,
    diagnostics: process.stderr,
    catalog,
    connection: connection.name,
    ...(onHostLoadObserved === undefined ? {} : { onHostLoadObserved }),
  });
  return { ok: true, data: undefined, exitCode: 0 };
}

/** A stdio server may never put a CLI envelope on its JSON-RPC stdout. */
function serveBootstrapFailure(message: string): CommandResult {
  process.stderr.write(`aw mcp serve-db: ${message}\n`);
  return {
    ok: false,
    error: { code: "MCP_SERVER_BOOTSTRAP_FAILED", message },
    exitCode: 2,
    suppressOutput: true,
  };
}

/**
 * Only an exact persisted descriptor can clear reload_required. A local doctor
 * sets AW_MCP_PROBE, so its initialized notification remains launch evidence
 * and cannot impersonate a real host reload.
 */
function resolveHostLoadObservation(
  args: ParsedArgs,
  ctx: CliContext,
  connection: StoredMcpConnection,
): (() => Promise<void>) | undefined {
  if (process.env.AW_MCP_PROBE === "1") return undefined;
  const rawHost = args.values.get("host");
  const rawScope = args.values.get("scope");
  if (rawHost === undefined || rawScope === undefined) return undefined;
  if (!FILE_HOSTS.includes(rawHost as McpHost)) return undefined;
  if (rawScope !== "workspace" && rawScope !== "global") return undefined;
  const host = rawHost as McpHost;
  const scope = rawScope as McpReceiptScope;
  if (scope !== "global") return undefined;
  const entry = buildMcpEntry(connection.name, connection.dsnVar, {
    host,
    scope,
    namespace: ctx.paths.namespace,
  });
  // `process.argv` begins with Node and the entrypoint. The rest must be the
  // descriptor byte-for-byte; a hand-written `serve-db` command is useful but
  // is not evidence that a configured host loaded its registered descriptor.
  if (process.execPath !== entry.command || !isDeepStrictEqual(process.argv.slice(1), entry.args)) {
    return undefined;
  }
  const descriptorDigest = digestMcpReceiptDescriptor({
    command: entry.command,
    args: entry.args,
  });
  return async () => {
    try {
      const snapshot = readMcpEntry(host, ctx.env.homeDir(), entry.name, scope);
      const classification = classifyMcpEntry(host, snapshot, entry, connection);
      if (
        classification.state !== "current" ||
        snapshot.command === undefined ||
        snapshot.args === undefined ||
        digestMcpReceiptDescriptor({ command: snapshot.command, args: snapshot.args }) !==
          descriptorDigest
      ) {
        return;
      }
      await openMcpHostReceiptService(ctx.paths).observeHostLoad({
        host,
        scope,
        connection: connection.name,
        descriptorDigest,
      });
    } catch {
      // A stale/missing receipt must not contaminate MCP stdout. The host has
      // already received a valid initialized lifecycle response; doctor will
      // surface the missing operational evidence separately.
      process.stderr.write("aw mcp serve-db: no se pudo registrar la carga observada del host\n");
    }
  };
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
    namespace: ctx.paths.namespace,
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
  if (input.scope !== "workspace") {
    const result = runMcpSetup(ctx.env, input);
    return "ok" in result ? result : await attachSetupReceipts(ctx, input, result);
  }

  const preview = runMcpSetup(ctx.env, { ...input, dryRun: true });
  if ("ok" in preview) return preview;
  if (!hasPendingMcpMutation(preview.applied)) {
    if (input.dryRun) return preview;
    const result = runMcpSetup(ctx.env, input);
    return "ok" in result ? result : await attachSetupReceipts(ctx, input, result);
  }

  const materialization = await materializeMcpWorkspace(
    ctx,
    input.workspace,
    input.dryRun === true,
  );
  if (input.dryRun) return { ...preview, materialization };

  const result = runMcpSetup(ctx.env, input);
  if ("ok" in result) return result;
  const withReceipts = await attachSetupReceipts(ctx, input, result);
  return { ...withReceipts, materialization };
}

async function attachSetupReceipts(
  ctx: CliContext,
  input: McpSetupInput,
  result: McpSetupResult,
): Promise<McpSetupResult> {
  const receipts = await registerMcpSetupReceipts(ctx.paths, input, result);
  const withReceipts: McpSetupResult = {
    ...result,
    errors: [...result.errors, ...receipts.errors],
    ...(receipts.registered.length === 0 ? {} : { receipts: receipts.registered }),
  };
  const launch = await probePersistedMcpSetupEntries(
    ctx.paths,
    withReceipts,
    receipts.probeTargets,
  );
  const native = await checkNativeMcpHosts(receipts.probeTargets);
  await recordNativeMcpHostChecks({
    paths: ctx.paths,
    scope: withReceipts.scope,
    scopeDir: withReceipts.scope_dir,
    targets: receipts.probeTargets,
    checks: native.checks,
  });
  if (
    receipts.registered.length === 0 &&
    receipts.errors.length === 0 &&
    launch.probes.length === 0 &&
    launch.errors.length === 0 &&
    native.checks.length === 0 &&
    native.errors.length === 0
  ) {
    return result;
  }
  return {
    ...withReceipts,
    errors: [...withReceipts.errors, ...launch.errors, ...native.errors],
    ...(launch.probes.length === 0 ? {} : { launch_probes: launch.probes }),
    ...(native.checks.length === 0 ? {} : { native_checks: native.checks }),
  };
}

async function runMcpRemoveWithMaterialization(
  ctx: CliContext,
  input: McpRemoveInput,
): Promise<McpRemoveResult | McpScopeRefusal> {
  if (input.scope !== "workspace") {
    const result = runMcpRemove(ctx.env, input);
    return "ok" in result ? result : await attachRemoveReceipts(ctx, input, result);
  }

  const preview = runMcpRemove(ctx.env, { ...input, dryRun: true });
  if ("ok" in preview) return preview;
  if (!hasPendingMcpMutation(preview.removed)) {
    if (input.dryRun) return preview;
    const result = runMcpRemove(ctx.env, input);
    return "ok" in result ? result : await attachRemoveReceipts(ctx, input, result);
  }

  const materialization = await materializeMcpWorkspace(
    ctx,
    input.workspace,
    input.dryRun === true,
  );
  if (input.dryRun) return { ...preview, materialization };

  const result = runMcpRemove(ctx.env, input);
  if ("ok" in result) return result;
  const withReceipts = await attachRemoveReceipts(ctx, input, result);
  return { ...withReceipts, materialization };
}

async function attachRemoveReceipts(
  ctx: CliContext,
  input: McpRemoveInput,
  result: McpRemoveResult,
): Promise<McpRemoveResult> {
  const errors = await removeMcpRemoveReceipts(ctx.paths, input, result);
  return errors.length === 0 ? result : { ...result, errors: [...result.errors, ...errors] };
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
    namespace: ctx.paths.namespace,
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
  const input = resolveDoctorInput(args, ctx);
  if (!("value" in input)) return input;
  const data = runMcpDoctor(ctx.env, ctx.paths, {
    hosts: input.value.hosts,
    connections: input.value.connections,
    namespace: ctx.paths.namespace,
    ...input.value.scope,
  });
  if (input.value.probeMode !== undefined) {
    await probeDoctorReports(data, input.value.probeMode, ctx, input.value.connections);
  }
  return doctorCommandResult(data);
}

interface DoctorInput {
  hosts: McpHost[];
  connections: StoredMcpConnection[];
  probeMode: "launch" | "data" | undefined;
  scope: { scope: "global" } | { scope: "workspace"; workspace: string };
}

interface ReadableMcpDescriptor {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

function resolveDoctorInput(
  args: ParsedArgs,
  ctx: CliContext,
): { value: DoctorInput } | CommandResult {
  const hosts = resolveHosts(args, ctx);
  if (!("value" in hosts)) return hosts;
  const connections = resolveConnections(args, ctx, true);
  if (!("value" in connections)) return connections;
  const probeMode = resolveDoctorProbeMode(args);
  if (!("value" in probeMode)) return probeMode;
  const workspace = args.values.get("workspace") ?? ctx.paths.workspaceDir();
  return {
    value: {
      hosts: hosts.value,
      connections: connections.value,
      probeMode: probeMode.value,
      scope: args.flags.has("--global") ? { scope: "global" } : { scope: "workspace", workspace },
    },
  };
}

async function probeDoctorReports(
  data: ReturnType<typeof runMcpDoctor>,
  mode: "launch" | "data",
  ctx: CliContext,
  connections: readonly StoredMcpConnection[],
): Promise<void> {
  const receipts = openMcpHostReceiptService(ctx.paths);
  const catalog = new DatabaseToolCatalog({
    paths: ctx.paths,
    env: ctx.env,
    postgres: new PostgresReadonlyTools(),
  });
  for (const report of data.reports) {
    const connection = connections.find((candidate) => candidate.name === report.instance);
    if (connection === undefined) {
      report.probe = { mode, outcome: "failed", phase: "spawn", code: "CONNECTION_NOT_FOUND" };
      continue;
    }
    await probeDoctorReport(report, data, mode, receipts, catalog, ctx, connection);
  }
}

async function probeDoctorReport(
  report: ReturnType<typeof runMcpDoctor>["reports"][number],
  data: ReturnType<typeof runMcpDoctor>,
  mode: "launch" | "data",
  receipts: ReturnType<typeof openMcpHostReceiptService>,
  catalog: DatabaseToolCatalog,
  ctx: CliContext,
  connection: StoredMcpConnection,
): Promise<void> {
  const readiness = doctorProbeReadiness(report, mode);
  if (readiness !== undefined) {
    report.probe = readiness;
    return;
  }
  const snapshot = doctorProbeSnapshot(report, data, mode, ctx, connection);
  if (snapshot === undefined) return;
  const probe = await runMcpStdioProbe({
    descriptor: {
      command: snapshot.command,
      args: snapshot.args,
      ...(snapshot.env === undefined ? {} : { env: snapshot.env }),
    },
    mode,
    expectedTools: DATABASE_TOOL_DESCRIPTORS,
  });
  if (!probe.ok) {
    report.probe = { mode: probe.mode, outcome: "failed", phase: probe.phase, code: probe.code };
    await recordReceiptProbeBestEffort(receipts, report, snapshot, "failed", probe.phase);
    await inspectDoctorSafety(mode, catalog, report);
    return;
  }
  const phase = probe.mode === "data" ? "tools/call" : "tools/list";
  report.probe = { mode: probe.mode, outcome: "passed", phase };
  await recordReceiptProbeBestEffort(receipts, report, snapshot, "passed", phase);
  await inspectDoctorSafety(mode, catalog, report);
}

async function inspectDoctorSafety(
  mode: "launch" | "data",
  catalog: DatabaseToolCatalog,
  report: ReturnType<typeof runMcpDoctor>["reports"][number],
): Promise<void> {
  if (mode !== "data") return;
  report.safety = safetyFromRoleOutcome((await catalog.inspectRole(report.instance)).inspection);
}

function doctorProbeReadiness(
  report: ReturnType<typeof runMcpDoctor>["reports"][number],
  mode: "launch" | "data",
): ReturnType<typeof runMcpDoctor>["reports"][number]["probe"] | undefined {
  if (report.launch_mode === "path-dependent") {
    return { mode, outcome: "failed", phase: "spawn", code: "PATH_DEPENDENT_DESCRIPTOR" };
  }
  if (report.status !== "ok") {
    return { mode, outcome: "failed", phase: "spawn", code: "CONFIGURATION_NOT_READY" };
  }
  return undefined;
}

function doctorProbeSnapshot(
  report: ReturnType<typeof runMcpDoctor>["reports"][number],
  data: ReturnType<typeof runMcpDoctor>,
  mode: "launch" | "data",
  ctx: CliContext,
  connection: StoredMcpConnection,
): ReadableMcpDescriptor | undefined {
  try {
    const entry = buildMcpEntry(connection.name, connection.dsnVar, {
      host: report.host,
      scope: data.scope,
      namespace: ctx.paths.namespace,
    });
    const snapshot = readMcpEntry(report.host, data.scope_dir, entry.name, data.scope);
    if (
      snapshot.command !== undefined &&
      snapshot.args !== undefined &&
      classifyMcpEntry(report.host, snapshot, entry, connection).state === "current"
    ) {
      return {
        command: snapshot.command,
        args: snapshot.args,
        ...(snapshot.env === undefined ? {} : { env: snapshot.env }),
      };
    }
  } catch {
    // The status remains actionable below without exposing a host config error.
  }
  report.probe = { mode, outcome: "failed", phase: "spawn", code: "DESCRIPTOR_UNREADABLE" };
  return undefined;
}

function doctorCommandResult(data: ReturnType<typeof runMcpDoctor>): CommandResult {
  const total = data.reports.length;
  const affected = data.reports.filter(isDoctorReportAffected).length;
  if (affected === 0) return { ok: true, data, exitCode: 0 };
  return {
    ok: false,
    data,
    error: {
      code: "MCP_DOCTOR_DRIFT",
      message: `${affected}/${total} entradas con drift, probe o seguridad pendiente (ver data.reports)`,
    },
    exitCode: 1,
  };
}

function isDoctorReportAffected(
  report: ReturnType<typeof runMcpDoctor>["reports"][number],
): boolean {
  return (
    report.status !== "ok" ||
    report.probe?.outcome === "failed" ||
    (report.safety !== undefined && report.safety.status !== "safe")
  );
}

function resolveDoctorProbeMode(
  args: ParsedArgs,
): { value: "launch" | "data" | undefined } | CommandResult {
  if (args.flags.has("--probe")) {
    return fail("INVALID_INPUT", "--probe requiere launch o data.", undefined, 2);
  }
  const value = args.values.get("probe");
  if (value === undefined) return { value: undefined };
  if (value === "launch" || value === "data") return { value };
  return fail("INVALID_INPUT", "--probe acepta launch o data.", undefined, 2);
}

async function recordReceiptProbeBestEffort(
  service: ReturnType<typeof openMcpHostReceiptService>,
  report: { host: McpHost; scope: "workspace" | "global"; instance: string },
  descriptor: Pick<ReadableMcpDescriptor, "command" | "args">,
  outcome: "passed" | "failed",
  phase: "spawn" | "initialize" | "initialized" | "tools/list" | "tools/call",
): Promise<void> {
  try {
    const identity = { host: report.host, scope: report.scope, connection: report.instance };
    const receipt = await service.find(identity);
    const descriptorDigest = digestMcpReceiptDescriptor(descriptor);
    if (receipt === undefined || receipt.descriptor_digest !== descriptorDigest) {
      return;
    }
    await service.recordLaunchProbe({ ...identity, descriptorDigest, outcome, phase });
  } catch {
    // Probe output remains useful even if an optional receipt update is busy.
    // The next setup/doctor exposes reload state from the last durable receipt.
  }
}

export function safetyFromRoleOutcome(
  inspection: PostgresRoleInspection | ToolFailure,
): NonNullable<import("../../domain/mcp-entry.js").McpDriftReport["safety"]> {
  if ("success" in inspection) {
    return {
      status: "blocked",
      superuser: false,
      write_capable: false,
      create_role: false,
      create_database: false,
      unsafe_server_role: false,
      code: inspection.code,
    };
  }
  const status = inspection.superuser
    ? "blocked"
    : inspection.canWrite ||
        inspection.canCreateRole ||
        inspection.canCreateDatabase ||
        inspection.unsafeServerRole === true
      ? "warning"
      : "safe";
  return {
    status,
    superuser: inspection.superuser,
    write_capable: inspection.canWrite,
    create_role: inspection.canCreateRole,
    create_database: inspection.canCreateDatabase,
    unsafe_server_role: inspection.unsafeServerRole === true,
  };
}

async function runMigrateSub(args: ParsedArgs, ctx: CliContext): Promise<CommandResult> {
  const input = resolveMigrationInput(args, ctx);
  if (!("value" in input)) return input;
  const migration = runMcpMigration(ctx.env, {
    hosts: input.value.hosts,
    connections: input.value.connections,
    namespace: ctx.paths.namespace,
    ...input.value.scope,
    ...(input.value.apply ? { apply: true } : {}),
    ...(input.value.apply && input.value.scope.scope === "global"
      ? { globalApproval: true as const }
      : {}),
  });
  if (isMcpMigrationRefusal(migration)) {
    return fail("GLOBAL_REQUIRES_FORCE", migration.hint, undefined, 2);
  }
  if (input.value.apply) await finalizeMigration(ctx, migration, input.value);
  return migrationCommandResult(migration, input.value.apply);
}

interface MigrationInput {
  apply: boolean;
  hosts: McpHost[];
  connections: StoredMcpConnection[];
  scope: { scope: "global" } | { scope: "workspace"; workspace: string };
}

interface MigrationFinalization {
  receipts: NonNullable<McpMigrationResult["receipts"]>;
  receiptErrors: NonNullable<McpMigrationResult["receipt_errors"]>;
  readbackErrors: NonNullable<McpMigrationResult["readback_errors"]>;
  nativeErrors: NonNullable<McpMigrationResult["native_errors"]>;
  probeTargets: Array<{
    host: McpHost;
    instance: string;
    target: string;
    entry: ReturnType<typeof buildMcpEntry>;
  }>;
}

function resolveMigrationInput(
  args: ParsedArgs,
  ctx: CliContext,
): { value: MigrationInput } | CommandResult {
  if (args.flags.has("--dry-run") && args.flags.has("--apply")) {
    return fail(
      "INVALID_INPUT",
      "mcp migrate usa preview por defecto; no combines --dry-run con --apply.",
      undefined,
      2,
    );
  }
  const apply = args.flags.has("--apply");
  if (apply && !args.flags.has("--force")) {
    return fail(
      "MCP_MIGRATE_REQUIRES_FORCE",
      "La migración escribe configuraciones de host. Revisá el preview y repetí con --apply --force.",
      undefined,
      2,
    );
  }
  const hosts = resolveHosts(args, ctx);
  if (!("value" in hosts)) return hosts;
  const connections = resolveConnections(args, ctx, true);
  if (!("value" in connections)) return connections;
  const workspace = args.values.get("workspace") ?? ctx.paths.workspaceDir();
  return {
    value: {
      apply,
      hosts: hosts.value,
      connections: connections.value,
      scope: args.flags.has("--global") ? { scope: "global" } : { scope: "workspace", workspace },
    },
  };
}

async function finalizeMigration(
  ctx: CliContext,
  data: McpMigrationResult,
  input: MigrationInput,
): Promise<void> {
  const finalization: MigrationFinalization = {
    receipts: [],
    receiptErrors: [],
    readbackErrors: [],
    nativeErrors: [],
    probeTargets: [],
  };
  const receipts = openMcpHostReceiptService(ctx.paths);
  for (const item of data.items) {
    await finalizeRetiredAliasReceipts(ctx, data, input, receipts, finalization, item);
    await finalizeMigrationItem(ctx, data, input, receipts, finalization, item);
  }
  attachMigrationFinalization(data, finalization);
  if (data.scope === "global") await finalizeMigrationProbes(ctx, data, finalization);
}

async function finalizeRetiredAliasReceipts(
  ctx: CliContext,
  data: McpMigrationResult,
  input: MigrationInput,
  receipts: ReturnType<typeof openMcpHostReceiptService>,
  finalization: MigrationFinalization,
  item: McpMigrationResult["items"][number],
): Promise<void> {
  if (data.scope !== "global" || item.retirements === undefined) return;
  const connection = input.connections.find((candidate) => candidate.name === item.instance);
  if (connection === undefined) return;
  for (const retirement of item.retirements) {
    if (retirement.action !== "retire-known-legacy" || retirement.readback_state !== "missing") {
      continue;
    }
    const aliasConnection = { ...connection, name: retirement.instance };
    const entry = buildMcpEntry(aliasConnection.name, aliasConnection.dsnVar, {
      host: item.host,
      scope: data.scope,
      namespace: ctx.paths.namespace,
    });
    try {
      const snapshot = readMcpEntry(item.host, data.scope_dir, entry.name, data.scope);
      if (classifyMcpEntry(item.host, snapshot, entry, aliasConnection).state !== "missing") {
        finalization.readbackErrors.push({
          host: item.host,
          instance: retirement.instance,
          message:
            "La entrada MCP legacy reapareció antes de retirar su recibo; se conserva la evidencia operativa.",
        });
        continue;
      }
      await receipts.remove({
        host: item.host,
        scope: data.scope,
        connection: retirement.instance,
      });
    } catch {
      finalization.receiptErrors.push({
        host: item.host,
        instance: retirement.instance,
        message: "La entrada MCP legacy se retiró, pero no se pudo retirar su recibo operativo.",
      });
    }
  }
}

async function finalizeMigrationItem(
  ctx: CliContext,
  data: McpMigrationResult,
  input: MigrationInput,
  receipts: ReturnType<typeof openMcpHostReceiptService>,
  finalization: MigrationFinalization,
  item: McpMigrationResult["items"][number],
): Promise<void> {
  const write = eligibleMigrationWrite(item);
  if (write === undefined) return;
  const connection = input.connections.find((candidate) => candidate.name === item.instance);
  if (connection === undefined) return;
  if (write.partial !== undefined) {
    finalization.readbackErrors.push({
      host: item.host,
      instance: connection.name,
      message: write.partial.message,
    });
    return;
  }
  if (item.readback_state !== "current") {
    finalization.readbackErrors.push(migrationReadbackError(item.host, connection.name));
    return;
  }
  if (data.scope !== "global") return;
  const current = readCurrentMigrationEntry(ctx, data, item, connection);
  if (current === undefined) {
    finalization.readbackErrors.push(migrationReadbackError(item.host, connection.name));
    return;
  }
  const registration = await registerMigrationReceipt(
    ctx,
    receipts,
    item,
    connection,
    current.descriptor,
  );
  if (registration === "skipped") return;
  if (registration === undefined) {
    finalization.receiptErrors.push({
      host: item.host,
      instance: connection.name,
      message: "No se pudo registrar el recibo MCP; revisá el estado antes de recargar el host.",
    });
    return;
  }
  finalization.receipts.push({
    host: item.host,
    instance: connection.name,
    descriptor_digest: registration.descriptor_digest,
    reload_required: true,
  });
  finalization.probeTargets.push({
    host: item.host,
    instance: connection.name,
    target: item.target,
    entry: current.entry,
  });
}

function eligibleMigrationWrite(
  item: McpMigrationResult["items"][number],
): NonNullable<McpMigrationResult["items"][number]["write"]> | undefined {
  // A retirement can fail only after qtc-* was written and reread. That
  // partial migration still changed a live descriptor and must receive the
  // same revocable receipt/reload signal as a fully retired alias; the item
  // remains failed overall and the command still reports recovery work.
  if (item.write?.action === "written" || item.write?.action === "skipped-idempotent") {
    return item.write;
  }
  return undefined;
}

function readCurrentMigrationEntry(
  ctx: CliContext,
  data: McpMigrationResult,
  item: McpMigrationResult["items"][number],
  connection: StoredMcpConnection,
):
  | { entry: ReturnType<typeof buildMcpEntry>; descriptor: { command: string; args: string[] } }
  | undefined {
  try {
    const entry = buildMcpEntry(connection.name, connection.dsnVar, {
      host: item.host,
      scope: data.scope,
      namespace: ctx.paths.namespace,
    });
    const snapshot = readMcpEntry(item.host, data.scope_dir, entry.name, data.scope);
    if (
      snapshot.command === undefined ||
      snapshot.args === undefined ||
      classifyMcpEntry(item.host, snapshot, entry, connection).state !== "current"
    ) {
      return undefined;
    }
    return { entry, descriptor: { command: snapshot.command, args: snapshot.args } };
  } catch {
    return undefined;
  }
}

async function registerMigrationReceipt(
  ctx: CliContext,
  receipts: ReturnType<typeof openMcpHostReceiptService>,
  item: McpMigrationResult["items"][number],
  connection: StoredMcpConnection,
  descriptor: { command: string; args: string[] },
): Promise<Awaited<ReturnType<typeof registerPersistedMcpDescriptor>> | "skipped" | undefined> {
  try {
    const identity = { host: item.host, scope: "global" as const, connection: connection.name };
    // A qtc descriptor can be byte-identical while this migration retired a
    // legacy alias from the same live host config. That is still a mutation:
    // renew the receipt so reload_required cannot remain falsely cleared from
    // an earlier host load that may still expose the retired alias.
    if (item.write?.action === "skipped-idempotent" && item.configuration_changed !== true) {
      const existing = await receipts.find(identity);
      if (
        existing !== undefined &&
        existing.descriptor_digest === digestMcpReceiptDescriptor(descriptor)
      ) {
        return "skipped";
      }
    }
    return await registerPersistedMcpDescriptor(ctx.paths, {
      host: item.host,
      scope: "global",
      connection: connection.name,
      entry: descriptor,
    });
  } catch {
    return undefined;
  }
}

function migrationReadbackError(host: McpHost, instance: string) {
  return {
    host,
    instance,
    message:
      "La entrada MCP escrita no coincidió al leerla de vuelta; no se registró recibo ni se debe recargar el host.",
  };
}

function attachMigrationFinalization(data: McpMigrationResult, state: MigrationFinalization): void {
  if (state.receipts.length > 0) data.receipts = state.receipts;
  if (state.receiptErrors.length > 0) data.receipt_errors = state.receiptErrors;
  if (state.readbackErrors.length > 0) data.readback_errors = state.readbackErrors;
  if (state.nativeErrors.length > 0) data.native_errors = state.nativeErrors;
}

async function finalizeMigrationProbes(
  ctx: CliContext,
  data: McpMigrationResult,
  state: MigrationFinalization,
): Promise<void> {
  const launch = await probePersistedMcpSetupEntries(
    ctx.paths,
    {
      scope: "global",
      scope_dir: data.scope_dir,
      dry_run: false,
      applied: [],
      skipped: [],
      conflicts: [],
      errors: [],
    },
    state.probeTargets,
  );
  if (launch.probes.length > 0) data.launch_probes = launch.probes;
  if (launch.errors.length > 0) {
    data.probe_errors = launch.errors.map((error) => ({
      host: error.host,
      instance: error.instance,
      message: error.message,
    }));
  }
  const native = await checkNativeMcpHosts(state.probeTargets);
  await recordNativeMcpHostChecks({
    paths: ctx.paths,
    scope: "global",
    scopeDir: data.scope_dir,
    targets: state.probeTargets,
    checks: native.checks,
  });
  if (native.checks.length > 0) data.native_checks = native.checks;
  state.nativeErrors.push(
    ...native.errors.map((error) => ({
      host: error.host,
      instance: error.instance,
      message: error.message,
    })),
  );
  if (state.nativeErrors.length > 0) data.native_errors = state.nativeErrors;
}

function migrationCommandResult(data: McpMigrationResult, apply: boolean): CommandResult {
  const blocked = data.items.filter((item) => item.action === "blocked").length;
  const failedWrites = data.items.filter(
    (item) => item.write?.action === "conflict" || item.action === "failed",
  ).length;
  const receiptFailures = data.receipt_errors?.length ?? 0;
  const readbackFailures = data.readback_errors?.length ?? 0;
  const probeFailures = data.probe_errors?.length ?? 0;
  const nativeFailures = data.native_errors?.length ?? 0;
  const problems =
    blocked + failedWrites + receiptFailures + readbackFailures + probeFailures + nativeFailures;
  const hasProblems = apply && problems > 0;
  return {
    ok: !hasProblems,
    data,
    ...(hasProblems
      ? {
          error: {
            code: "MCP_MIGRATE_PARTIAL",
            message: `${problems} entrada(s) no se migraron, no dejaron recibo, no pasaron readback, no fueron launchable o no pudieron verificarse con su host.`,
          },
        }
      : {}),
    exitCode: hasProblems ? 1 : 0,
  };
}

function isMcpMigrationRefusal(
  value: McpMigrationResult | { ok: false; hint: string },
): value is { ok: false; hint: string } {
  return "ok" in value && value.ok === false;
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
      "mcp serve-db ejecuta una sola conexión; usá --instance <nombre>.",
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
