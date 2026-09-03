import { existsSync, readFileSync } from "node:fs";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import { MCP_FILE_HOSTS, harnessForMcpHost } from "../../domain/harnesses.js";
import {
  type McpEntry,
  type McpEntryState,
  type McpHost,
  type McpInstance,
  buildMcpEntry,
  generationVariantMcpEntry,
  mcpEntryNameFor,
  normalizeDsnVarName,
  validateDsnVarName,
  validateMcpInstance,
} from "../../domain/mcp-entry.js";
import type { CommandResult } from "../../domain/types.js";
import { homeRelative } from "../display-path.js";
import { dsnKeyForInstance, readDsnFile } from "../dsn-reader-service.js";
import {
  type McpConnection,
  McpConnectionsError,
  deleteMcpConnection,
  readMcpConnections,
  upsertMcpConnection,
} from "../mcp-connections-service.js";
import { type McpDoctorResult, runMcpDoctor } from "../mcp-doctor-service.js";
import { type McpEntryClassification, classifyMcpEntry } from "../mcp-entry-classification.js";
import { type McpEntrySnapshot, readMcpEntry } from "../mcp-host-reader.js";
import {
  type McpHostReceipt,
  McpHostReceiptError,
  type McpNativeHostCheckFailureCode,
  digestMcpReceiptDescriptor,
  parseMcpHostReceiptBook,
} from "../mcp-host-receipt-service.js";
import { mcpHostReceiptFile } from "../mcp-host-receipt-store.js";
import { removePersistedMcpReceipt } from "../mcp-host-receipts.js";
import { probePersistedMcpSetupEntries } from "../mcp-launch-probe-service.js";
import {
  checkNativeMcpHosts,
  recordNativeMcpHostChecks,
} from "../mcp-native-host-check-service.js";
import { registerMcpSetupReceipts } from "../mcp-receipt-registration-service.js";
import { removeMcpRemoveReceipts } from "../mcp-receipt-removal-service.js";
import { type McpRemoveInput, type McpRemoveResult, runMcpRemove } from "../mcp-remove-service.js";
import type { McpErrorRecord } from "../mcp-scope-common.js";
import { type McpSetupInput, type McpSetupResult, runMcpSetup } from "../mcp-setup-service.js";
import {
  type WarpPostInstallHint,
  buildWarpPostInstallHint,
} from "../mcp-warp-postinstall-hint.js";

// Hosts with a file-based MCP config the CLI can write — single source in the
// domain. Keeping this data-driven means a newly-supported host shows up in the
// wizard menu, status table, doctor and remove automatically.
const FILE_HOSTS: readonly McpHost[] = MCP_FILE_HOSTS;

/** Long label — read from the catalog, never a second copy of it. */
function hostLabel(host: McpHost): string {
  return harnessForMcpHost(host)?.label ?? host;
}

// Concise column headers for the status table: presentation-only shortenings of
// the catalog labels, which are too wide for a column.
const HOST_COLUMN: Record<McpHost, string> = {
  claude: "Claude",
  codex: "Codex",
  warp: "Warp",
  gemini: "Gemini",
  opencode: "OpenCode",
  crush: "Crush",
  kimi: "Kimi",
};

type InstallAction = `install-${McpHost}`;
type SelfMcpAction =
  | "list"
  | "use-env"
  | "create-env"
  | InstallAction
  | "doctor"
  | "remove"
  | "cancel";

type InstallStatus = "si" | "no" | "drift";
type ConnectionMenuAction = InstallAction | "doctor" | "remove" | "cancel";

interface PromptChoice<T extends string> {
  name: string;
  value: T;
  description?: string;
}

interface PromptSeparator {
  type: "separator";
  separator?: string;
}

type PromptChoiceOrSeparator<T extends string> = PromptChoice<T> | PromptSeparator;

function isPromptSeparator<T extends string>(
  choice: PromptChoiceOrSeparator<T>,
): choice is PromptSeparator {
  return (choice as PromptSeparator).type === "separator";
}

export interface SelfMcpPrompts {
  select<T extends string>(options: {
    message: string;
    choices: PromptChoiceOrSeparator<T>[];
    default?: T;
  }): Promise<T>;
  input(options: {
    message: string;
    default?: string;
    validate?: (value: string) => boolean | string;
  }): Promise<string>;
}

export interface SelfMcpConnectionView {
  nombre: McpInstance;
  server_name: string;
  dsn_var: string;
  dsn_visible: boolean;
  instalado: Record<McpHost, InstallStatus>;
  host_status: Record<McpHost, SelfMcpHostStatus>;
}

export type McpHostRuntimeState =
  | "registered"
  | "configured"
  | "launchable"
  | "host-load-observed"
  | "reload-required"
  | "legacy"
  | "conflict"
  | "failed";

export interface SelfMcpHostStatus {
  state: McpHostRuntimeState;
  entry_state: McpEntryState;
  launchable: boolean;
  reload_required: boolean;
  /** Host config file holding the same-named entry (absent when nothing is registered there). */
  target?: string;
  /**
   * Which legacy a `known-legacy` entry is, because the remedy differs: an
   * install refreshes a `generation` bump in place, while a `historic` shape is
   * replaced only by `aw mcp migrate`, which previews what it overwrites.
   */
  legacy_kind?: "generation" | "historic";
  last_probe?: { outcome: "passed" | "failed"; phase: string; observed_at: string };
  last_host_load_observed?: string;
  /** Failure-only result of the host's native MCP inspection. */
  native_check_failure?: { code: McpNativeHostCheckFailureCode; observed_at: string };
  /** A corrupt receipt ledger invalidates lifecycle evidence without hiding the descriptor. */
  receipt_failure?: { phase: "receipt" | "descriptor"; code: string };
}

interface HostReceiptLedger {
  receipts: readonly McpHostReceipt[];
  failure?: { code: string };
}

interface McpRegistryIssue {
  code: "MCP_CONNECTION_INVALID";
  path: string;
  recovery: string;
}

type ConnectionViewsResult =
  | { kind: "ok"; connections: SelfMcpConnectionView[] }
  | { kind: "invalid"; issue: McpRegistryIssue };

type RegisteredConnectionResult =
  | { kind: "found"; connection: McpConnection }
  | { kind: "none" }
  | { kind: "invalid"; issue: McpRegistryIssue };

export interface SelfMcpConfigData {
  action: SelfMcpAction;
  connection: SelfMcpConnectionView | null;
  connections?: SelfMcpConnectionView[];
  table?: string;
  registry?: { path: string; changed: boolean };
  registry_error?: McpRegistryIssue;
  setup?: McpSetupResult;
  remove?: McpRemoveResult;
  /** Hosts whose same-named global entry is NOT ours (remove leaves it intact). */
  preserved_foreign?: McpHost[];
  doctor?: McpDoctorResult;
  warp_hint?: WarpPostInstallHint;
  env_help?: {
    platform: string;
    variable: string;
    commands: string[];
    next_step: string;
  };
  summary: string;
}

interface ResolvedAction {
  action: SelfMcpAction;
  fromArgs: boolean;
}

export async function selfMcpConfig(
  args: ParsedArgs,
  ctx: CliContext,
  prompts?: SelfMcpPrompts,
): Promise<CommandResult<SelfMcpConfigData>> {
  const prompt = prompts ?? (await loadPrompts());
  const resolved = await resolveAction(args, prompt);

  try {
    switch (resolved.action) {
      case "list":
        return resolved.fromArgs
          ? listConnections(ctx)
          : await listConnectionsMenu(args, ctx, prompt);
      case "use-env":
        return await useExistingDsnVar(args, ctx, prompt);
      case "create-env":
        return await createDsnEnvHelp(args, prompt);
      case "cancel":
        return {
          ok: true,
          data: { action: "cancel", connection: null, summary: "Operación cancelada." },
          exitCode: 0,
        };
      default:
        // install-<host> | doctor | remove — all operate on a registered connection.
        return await runConnectionAction(args, ctx, prompt, resolved.action);
    }
  } catch (error) {
    if (error instanceof McpConnectionsError) {
      return invalidRegistryResult(resolved.action, mcpRegistryIssue(ctx));
    }
    throw error;
  }
}

function listConnections(ctx: CliContext): CommandResult<SelfMcpConfigData> {
  const views = connectionViews(ctx);
  if (views.kind === "invalid") return invalidRegistryResult("list", views.issue);
  const { connections } = views;
  return {
    ok: true,
    data: {
      action: "list",
      connection: null,
      connections,
      table: formatConnectionsTable(connections),
      summary:
        connections.length > 0
          ? `${connections.length} conexión(es) MCP registradas.`
          : "No hay conexiones MCP registradas.",
    },
    exitCode: 0,
  };
}

async function listConnectionsMenu(
  args: ParsedArgs,
  ctx: CliContext,
  prompts: SelfMcpPrompts,
): Promise<CommandResult<SelfMcpConfigData>> {
  const views = connectionViews(ctx);
  if (views.kind === "invalid") return invalidRegistryResult("list", views.issue);
  const { connections } = views;
  if (connections.length === 0) {
    return {
      ok: true,
      data: {
        action: "list",
        connection: null,
        connections,
        table: formatConnectionsTable(connections),
        summary: "No hay conexiones MCP registradas. Primero usa una DSN env var existente.",
      },
      exitCode: 0,
    };
  }

  const action = await prompts.select<ConnectionMenuAction>({
    message: formatConnectionsBlock(connections),
    default: "install-claude",
    choices: [
      { type: "separator", separator: "── Instalar / Reinstalar ──" },
      ...FILE_HOSTS.map((h) => ({
        name: `▸ ${hostLabel(h)}`,
        value: `install-${h}` as ConnectionMenuAction,
      })),
      { type: "separator", separator: "── Operar ──" },
      { name: "· Diagnosticar", value: "doctor" },
      { name: "✗ Eliminar", value: "remove" },
      { type: "separator" },
      { name: "⏎ Cancelar", value: "cancel" },
    ],
  });
  if (action === "cancel") {
    return {
      ok: true,
      data: {
        action,
        connection: null,
        connections,
        table: formatConnectionsTable(connections),
        summary: "Operación cancelada.",
      },
      exitCode: 0,
    };
  }
  return runConnectionAction(args, ctx, prompts, action);
}

async function useExistingDsnVar(
  args: ParsedArgs,
  ctx: CliContext,
  prompts: SelfMcpPrompts,
): Promise<CommandResult<SelfMcpConfigData>> {
  const name = await resolveConnectionName(args, prompts);
  const dsnVar = await resolveDsnVar(args, prompts, name);
  if (!isDsnVisible(ctx, dsnVar)) {
    return {
      ok: false,
      error: {
        code: "DSN_VAR_NOT_VISIBLE",
        message: `${dsnVar} no está visible en el entorno actual ni en ${ctx.paths.userDsnFile()}.`,
      },
      data: {
        action: "use-env",
        connection: null,
        env_help: buildEnvHelp(dsnVar, name),
        summary: `Exporta ${dsnVar} y vuelve a registrar la conexión.`,
      },
      exitCode: 1,
    };
  }

  const write = upsertMcpConnection(ctx.paths, { name, dsnVar });
  const connection = connectionView(ctx, {
    name: write.connection.name,
    dsnVar: write.connection.dsnVar,
    provider: write.connection.provider,
    dsnPresent: true,
  });
  const views = connectionViews(ctx);
  if (views.kind === "invalid") return invalidRegistryResult("use-env", views.issue);
  return {
    ok: true,
    data: {
      action: "use-env",
      connection,
      connections: views.connections,
      table: formatConnectionsTable(views.connections),
      registry: { path: write.path, changed: true },
      summary: `Conexión '${connection.nombre}' registrada con ${connection.dsn_var}.`,
    },
    exitCode: 0,
  };
}

async function createDsnEnvHelp(
  args: ParsedArgs,
  prompts: SelfMcpPrompts,
): Promise<CommandResult<SelfMcpConfigData>> {
  const name = await resolveConnectionName(args, prompts);
  const dsnVar = await resolveDsnVar(args, prompts, name);
  return {
    ok: true,
    data: {
      action: "create-env",
      connection: null,
      env_help: buildEnvHelp(dsnVar, name),
      summary: `Comandos sugeridos para crear ${dsnVar}. No se instaló ningún host.`,
    },
    exitCode: 0,
  };
}

async function runConnectionAction(
  args: ParsedArgs,
  ctx: CliContext,
  prompts: SelfMcpPrompts,
  action: Exclude<SelfMcpAction, "list" | "use-env" | "create-env" | "cancel">,
): Promise<CommandResult<SelfMcpConfigData>> {
  const resolved = await resolveRegisteredConnection(args, ctx, prompts);
  if (resolved.kind === "invalid") return invalidRegistryResult(action, resolved.issue);
  if (resolved.kind === "none") {
    return {
      ok: false,
      error: {
        code: "NO_MCP_CONNECTIONS",
        message: "No hay conexiones MCP registradas. Usa primero 'self mcp use-env'.",
      },
      data: { action, connection: null, summary: "No hay conexiones MCP registradas." },
      exitCode: 1,
    };
  }
  const { connection } = resolved;

  switch (action) {
    case "doctor":
      return doctorConnection(ctx, connection);
    case "remove":
      return removeConnection(args, ctx, connection);
    default:
      // install-<host>
      return installConnection(args, ctx, connection, action.slice("install-".length) as McpHost);
  }
}

async function installConnection(
  args: ParsedArgs,
  ctx: CliContext,
  connection: McpConnection,
  host: McpHost,
): Promise<CommandResult<SelfMcpConfigData>> {
  // The explicit install action (CLI/TUI) carries its own narrow global consent;
  // it is not the public broad `--force` escape hatch.
  const setupInput: McpSetupInput = {
    hosts: [host],
    connections: [connection],
    namespace: ctx.paths.namespace,
    scope: "global",
    globalApproval: "explicit-self-action",
    dryRun: args.flags.has("--dry-run"),
  };
  const setup = await runGlobalSetupWithEvidence(ctx, setupInput);
  if ("ok" in setup) return refusal(hostAction(host), connectionView(ctx, connection), setup.hint);
  const doctor = runDoctor(ctx, connection, [host]);
  const hasProblems = setup.errors.length > 0 || setup.conflicts.length > 0;
  const views = connectionViews(ctx);
  if (views.kind === "invalid") return invalidRegistryResult(hostAction(host), views.issue);
  // The hint cites the file actually written (per-platform global path).
  const warpTarget = [...setup.applied, ...setup.skipped].find((r) => r.host === "warp")?.target;
  const warpHint =
    host === "warp" && !hasProblems && warpTarget
      ? buildWarpPostInstallHint(mcpEntryNameFor(connection.name), "global", warpTarget)
      : undefined;
  return {
    ok: !hasProblems,
    data: {
      action: hostAction(host),
      connection: connectionView(ctx, connection),
      connections: views.connections,
      table: formatConnectionsTable(views.connections),
      setup,
      doctor,
      ...(warpHint ? { warp_hint: warpHint } : {}),
      summary: warpHint
        ? `Conexión '${connection.name}' escrita en ${warpHint.file}. Activá 'File-based MCP Servers' en Warp Settings para que la spawnee.`
        : hasProblems
          ? `No se instaló '${connection.name}' en ${hostLabel(host)}.${setupProblemNote(setup, ctx.env.homeDir())}`
          : `Conexión '${connection.name}' instalada en ${hostLabel(host)}.`,
    },
    ...(hasProblems
      ? {
          error: {
            code: "MCP_SETUP_PARTIAL",
            message: `${setup.errors.length} error(es) y ${setup.conflicts.length} conflicto(s) durante setup; ver data.setup.errors y data.setup.conflicts`,
          },
        }
      : {}),
    exitCode: hasProblems ? 1 : 0,
  };
}

/**
 * The self wizard writes user-scope descriptors, so it must finish the same
 * durable lifecycle as `mcp setup --global`: receipt, exact persisted launch
 * probe, then native host visibility. Keeping that sequence behind one local
 * boundary prevents a future wizard branch from treating a file write as host
 * readiness.
 */
async function runGlobalSetupWithEvidence(
  ctx: CliContext,
  input: McpSetupInput,
): Promise<ReturnType<typeof runMcpSetup>> {
  const setup = runMcpSetup(ctx.env, input);
  if ("ok" in setup) return setup;

  const receiptRegistration = await registerMcpSetupReceipts(ctx.paths, input, setup);
  const withReceipts: McpSetupResult = {
    ...setup,
    errors: [...setup.errors, ...receiptRegistration.errors],
    ...(receiptRegistration.registered.length === 0
      ? {}
      : { receipts: receiptRegistration.registered }),
  };
  const launch = await probePersistedMcpSetupEntries(
    ctx.paths,
    withReceipts,
    receiptRegistration.probeTargets,
  );
  const native = await checkNativeMcpHosts(receiptRegistration.probeTargets);
  await recordNativeMcpHostChecks({
    paths: ctx.paths,
    scope: withReceipts.scope,
    scopeDir: withReceipts.scope_dir,
    targets: receiptRegistration.probeTargets,
    checks: native.checks,
  });
  if (
    receiptRegistration.registered.length === 0 &&
    receiptRegistration.errors.length === 0 &&
    launch.probes.length === 0 &&
    launch.errors.length === 0 &&
    native.checks.length === 0 &&
    native.errors.length === 0
  ) {
    return setup;
  }
  return {
    ...withReceipts,
    errors: [...withReceipts.errors, ...launch.errors, ...native.errors],
    ...(launch.probes.length === 0 ? {} : { launch_probes: launch.probes }),
    ...(native.checks.length === 0 ? {} : { native_checks: native.checks }),
  };
}

function doctorConnection(
  ctx: CliContext,
  connection: McpConnection,
): CommandResult<SelfMcpConfigData> {
  const doctor = runDoctor(ctx, connection, [...FILE_HOSTS]);
  const allOk = doctor.summary.ok === doctor.reports.length;
  return {
    ok: allOk,
    data: {
      action: "doctor",
      connection: connectionView(ctx, connection),
      doctor,
      summary: `Diagnóstico MCP ejecutado para '${connection.name}'.`,
    },
    ...(allOk
      ? {}
      : {
          error: {
            code: "MCP_DOCTOR_DRIFT",
            message: `${doctor.reports.length - doctor.summary.ok}/${doctor.reports.length} entradas con drift`,
          },
        }),
    exitCode: allOk ? 0 : 1,
  };
}

async function removeConnection(
  args: ParsedArgs,
  ctx: CliContext,
  connection: McpConnection,
): Promise<CommandResult<SelfMcpConfigData>> {
  const dryRun = args.flags.has("--dry-run");
  // The explicit remove action carries its own narrow global consent.
  // The writer verifies exact ownership per host and returns a conflict for an
  // homonymous foreign entry, so this never has to infer ownership from a word
  // in the command line.
  const removeInput: McpRemoveInput = {
    hosts: [...FILE_HOSTS],
    connections: [connection],
    namespace: ctx.paths.namespace,
    scope: "global",
    globalApproval: "explicit-self-action",
    dryRun,
  };
  const remove = runMcpRemove(ctx.env, removeInput);
  if ("ok" in remove) return refusal("remove", connectionView(ctx, connection), remove.hint);
  const receiptErrors = await removeMcpRemoveReceipts(ctx.paths, removeInput, remove);
  const home = ctx.env.homeDir();
  // A `conflict` says the writer stopped before touching that host — not that
  // nothing of ours is there. Claude stops on a foreign homonym in the legacy
  // file BEFORE reaching the owned entry in ~/.claude.json, so an owned
  // descriptor still present anywhere is an error that holds the registry entry:
  // dropping it would orphan that descriptor.
  const leftovers: McpErrorRecord[] = remove.conflicts.flatMap((conflict) => {
    const left = ownedDescriptorLeft(ctx, connection, conflict.host);
    return left === null
      ? []
      : [
          {
            host: conflict.host,
            instance: connection.name,
            target: left,
            message: `Queda un descriptor propio en ${homeRelative(left, home)}: resolvé la entrada ajena en ${homeRelative(conflict.target, home)} y repetí remove.`,
          },
        ];
  });
  const settled = [...remove.errors, ...receiptErrors, ...leftovers];
  // A foreign homonym was never Workline's: it is neither removed nor allowed to
  // keep the connection registered, and once the connection goes its receipt
  // describes nothing of ours. Only a real error holds the registry entry.
  const staleReceiptErrors =
    dryRun || settled.length > 0
      ? []
      : await purgeForeignReceipts(ctx.paths, connection.name, remove.conflicts);
  const removeWithReceipts: McpRemoveResult = {
    ...remove,
    errors: [...settled, ...staleReceiptErrors],
  };
  const hasErrors = removeWithReceipts.errors.length > 0;
  const preservedForeign = [
    ...new Set(removeWithReceipts.conflicts.map((conflict) => conflict.host)),
  ];
  const deleted = !dryRun && !hasErrors ? deleteMcpConnection(ctx.paths, connection) : null;
  const leftoverNote = leftovers.map((leftover) => ` ${leftover.message}`).join("");
  const preservedNote =
    removeWithReceipts.conflicts.length > 0
      ? ` Se conservó la entrada ajena homónima en: ${removeWithReceipts.conflicts
          .map((conflict) => `${hostLabel(conflict.host)} (${homeRelative(conflict.target, home)})`)
          .join(", ")}.`
      : "";
  const reloadNotice = removalReloadNotice(removeWithReceipts);
  const views = connectionViews(ctx);
  if (views.kind === "invalid") return invalidRegistryResult("remove", views.issue);
  return {
    ok: !hasErrors,
    data: {
      action: "remove",
      connection: connectionView(ctx, connection),
      connections: views.connections,
      table: formatConnectionsTable(views.connections),
      remove: removeWithReceipts,
      ...(preservedForeign.length > 0 ? { preserved_foreign: preservedForeign } : {}),
      ...(deleted ? { registry: { path: deleted.path, changed: deleted.removed } } : {}),
      summary: dryRun
        ? `Previsualización de eliminación para '${connection.name}'.${preservedNote}`
        : hasErrors
          ? `Eliminación parcial de '${connection.name}'.${preservedNote}${leftoverNote}${reloadNotice}`
          : `Conexión '${connection.name}' eliminada de los hosts con MCP y del registro local.${preservedNote}${reloadNotice}`,
    },
    ...(hasErrors
      ? {
          error: {
            code: "MCP_REMOVE_PARTIAL",
            message: `${removeWithReceipts.errors.length} error(es) durante remove; ver data.remove.errors`,
          },
        }
      : {}),
    exitCode: hasErrors ? 1 : 0,
  };
}

/**
 * The file that still holds a Workline-shaped descriptor for this host, or null.
 * Each Claude location is judged on its own: the combined classification reports
 * the foreign legacy homonym and would hide the owned primary entry behind it.
 */
function ownedDescriptorLeft(
  ctx: CliContext,
  connection: McpConnection,
  host: McpHost,
): string | null {
  const entry = buildMcpEntry(connection.name, connection.dsnVar, {
    host,
    scope: "global",
    namespace: ctx.paths.namespace,
  });
  const { secondary, ...primary } = readMcpEntry(host, ctx.env.homeDir(), entry.name, "global");
  for (const location of secondary === undefined ? [primary] : [primary, secondary]) {
    const { state } = classifyMcpEntry(host, location, entry, connection);
    if (state === "current" || state === "known-legacy") return location.target;
  }
  return null;
}

async function purgeForeignReceipts(
  paths: CliContext["paths"],
  connectionName: string,
  conflicts: readonly McpRemoveResult["conflicts"][number][],
): Promise<McpErrorRecord[]> {
  const errors: McpErrorRecord[] = [];
  for (const conflict of conflicts) {
    try {
      await removePersistedMcpReceipt(paths, {
        host: conflict.host,
        scope: "global",
        connection: connectionName,
      });
    } catch {
      errors.push({
        host: conflict.host,
        instance: connectionName,
        target: conflict.target,
        message:
          "La entrada ajena se conserva, pero no se pudo retirar el recibo operativo de Workline.",
      });
    }
  }
  return errors;
}

/**
 * Why an install did not land, in the sentence a surface actually shows. The
 * summary is what the TUI puts in its toast, so leaving it at "instalada"
 * turned a refusal into a success message under a failure title.
 */
function setupProblemNote(setup: McpSetupResult, home: string): string {
  const conflicts = setup.conflicts.map(
    (conflict) => `${hostLabel(conflict.host)} (${homeRelative(conflict.target, home)})`,
  );
  const conflictNote =
    conflicts.length === 0
      ? ""
      : ` Ya hay una entrada con ese nombre que Workline no puede reemplazar en: ${conflicts.join(", ")}.`;
  const errorNote =
    setup.errors.length === 0 ? "" : ` ${setup.errors.length} error(es) de escritura.`;
  return `${conflictNote}${errorNote}`;
}

function removalReloadNotice(remove: McpRemoveResult): string {
  const requirements = remove.reload_required ?? [];
  if (requirements.length === 0) return "";
  return ` Recarga requerida: ${requirements
    .map((requirement) => `${hostLabel(requirement.host)}: ${requirement.next_step}`)
    .join(" ")}`;
}

function runDoctor(ctx: CliContext, connection: McpConnection, hosts: McpHost[]): McpDoctorResult {
  return runMcpDoctor(ctx.env, ctx.paths, {
    hosts,
    connections: [connection],
    namespace: ctx.paths.namespace,
    scope: "global",
  });
}

function connectionViews(ctx: CliContext): ConnectionViewsResult {
  try {
    const receiptLedger = readHostReceipts(ctx);
    return {
      kind: "ok",
      connections: readMcpConnections(ctx.paths, ctx.env).map((connection) =>
        connectionView(ctx, connection, receiptLedger),
      ),
    };
  } catch (error) {
    if (error instanceof McpConnectionsError) {
      return { kind: "invalid", issue: mcpRegistryIssue(ctx) };
    }
    throw error;
  }
}

function mcpRegistryIssue(ctx: CliContext): McpRegistryIssue {
  return {
    code: "MCP_CONNECTION_INVALID",
    path: ctx.paths.userMcpConnectionsFile(),
    recovery:
      "Restaurá mcp-connections.json desde una copia válida o corregí su forma antes de volver a operar.",
  };
}

function invalidRegistryResult(
  action: SelfMcpAction,
  issue: McpRegistryIssue,
): CommandResult<SelfMcpConfigData> {
  return {
    ok: false,
    error: {
      code: issue.code,
      message: "El registro MCP local no es válido y requiere reparación antes de operar.",
    },
    data: {
      action,
      connection: null,
      connections: [],
      table: formatConnectionsTable([]),
      registry_error: issue,
      summary: issue.recovery,
    },
    exitCode: 2,
  };
}

function connectionView(
  ctx: CliContext,
  connection: McpConnection,
  receiptLedger: HostReceiptLedger = readHostReceipts(ctx),
): SelfMcpConnectionView {
  const hostStatus = Object.fromEntries(
    FILE_HOSTS.map((host) => [host, installStatus(ctx, connection, host, receiptLedger)]),
  ) as Record<McpHost, SelfMcpHostStatus>;
  return {
    nombre: connection.name,
    server_name: mcpEntryNameFor(connection.name),
    dsn_var: connection.dsnVar,
    dsn_visible: isDsnVisible(ctx, connection.dsnVar),
    instalado: Object.fromEntries(
      FILE_HOSTS.map((host) => [host, installMark(hostStatus[host])]),
    ) as Record<McpHost, InstallStatus>,
    host_status: hostStatus,
  };
}

/**
 * Status must be derived from the exact descriptor that this host would load,
 * not from a host-agnostic default. Global descriptors carry the resolved
 * namespace and host identity in their argv, so both are part of ownership.
 */
function installStatus(
  ctx: CliContext,
  connection: McpConnection,
  host: McpHost,
  receiptLedger: HostReceiptLedger,
): SelfMcpHostStatus {
  const entry = buildMcpEntry(connection.name, connection.dsnVar, {
    host,
    scope: "global",
    namespace: ctx.paths.namespace,
  });
  const snapshot = readMcpEntry(host, ctx.env.homeDir(), entry.name, "global");
  const classification = classifyMcpEntry(host, snapshot, entry, connection);
  const status = lifecycleStatus(classification.state, snapshot, receiptLedger, host, connection);
  const kind = legacyKindOf(entry, classification);
  // The file the entry was read from travels with the status, so a consumer can
  // point the person at it — for Claude that may be the historical settings file.
  return {
    ...status,
    ...(classification.target === undefined ? {} : { target: classification.target }),
    ...(kind === undefined ? {} : { legacy_kind: kind }),
  };
}

/**
 * Which legacy an owned entry is. Derived from the same predicate the install
 * path uses to decide what it may replace, so what a surface tells the person
 * and what a write actually does cannot drift apart.
 */
function legacyKindOf(
  entry: McpEntry,
  classification: McpEntryClassification,
): SelfMcpHostStatus["legacy_kind"] {
  if (classification.state !== "known-legacy" || classification.legacy === undefined) {
    return undefined;
  }
  return generationVariantMcpEntry(entry, classification.legacy.args) === undefined
    ? "historic"
    : "generation";
}

function lifecycleStatus(
  entryState: McpEntryState,
  snapshot: McpEntrySnapshot,
  receiptLedger: HostReceiptLedger,
  host: McpHost,
  connection: McpConnection,
): SelfMcpHostStatus {
  const ledgerFailure = receiptLedgerFailureStatus(entryState, receiptLedger);
  if (ledgerFailure !== undefined) return ledgerFailure;
  const entryStatus = nonCurrentEntryStatus(entryState);
  if (entryStatus !== undefined) return entryStatus;

  const receipt = receiptLedger.receipts.find(
    (candidate) =>
      candidate.host === host &&
      candidate.scope === "global" &&
      candidate.connection === connection.name,
  );
  if (receipt !== undefined && !receiptMatchesDescriptor(receipt, snapshot)) {
    return staleReceiptStatus(entryState);
  }
  return currentDescriptorStatus(entryState, receipt);
}

function receiptLedgerFailureStatus(
  entryState: McpEntryState,
  receiptLedger: HostReceiptLedger,
): SelfMcpHostStatus | undefined {
  if (receiptLedger.failure === undefined) return undefined;
  return {
    state: "failed",
    entry_state: entryState,
    launchable: false,
    reload_required: false,
    receipt_failure: { phase: "receipt", code: receiptLedger.failure.code },
  };
}

function nonCurrentEntryStatus(entryState: McpEntryState): SelfMcpHostStatus | undefined {
  switch (entryState) {
    case "missing":
      return {
        state: "registered",
        entry_state: entryState,
        launchable: false,
        reload_required: false,
      };
    case "known-legacy":
      return {
        state: "legacy",
        entry_state: entryState,
        launchable: false,
        reload_required: true,
      };
    case "foreign":
      return {
        state: "conflict",
        entry_state: entryState,
        launchable: false,
        reload_required: false,
      };
    case "malformed":
      return {
        state: "failed",
        entry_state: entryState,
        launchable: false,
        reload_required: false,
      };
    case "current":
      return undefined;
  }
}

function staleReceiptStatus(entryState: McpEntryState): SelfMcpHostStatus {
  return {
    state: "failed",
    entry_state: entryState,
    launchable: false,
    reload_required: true,
    receipt_failure: { phase: "descriptor", code: "MCP_RECEIPT_DESCRIPTOR_STALE" },
  };
}

function currentDescriptorStatus(
  entryState: McpEntryState,
  receipt: McpHostReceipt | undefined,
): SelfMcpHostStatus {
  // A current descriptor without a receipt may be the aftermath of a busy
  // receipt ledger after the host file was already written. It has no durable
  // descriptor digest, lifecycle evidence, or way for a later host reload to
  // clear reload_required, so presenting it as merely configured would hide
  // the required recovery action.
  if (receipt === undefined) {
    return {
      state: "failed",
      entry_state: entryState,
      launchable: false,
      reload_required: true,
      receipt_failure: { phase: "receipt", code: "MCP_RECEIPT_NOT_FOUND" },
    };
  }
  const lastProbe = receipt?.last_launch_probe;
  const nativeCheckFailure = receipt?.last_native_check_failure;
  const launchable = lastProbe?.outcome === "passed";
  const reloadRequired = receipt?.reload_required ?? false;
  const evidence = {
    entry_state: entryState,
    launchable,
    reload_required: reloadRequired,
    ...(lastProbe === undefined
      ? {}
      : {
          last_probe: {
            outcome: lastProbe.outcome,
            phase: lastProbe.phase,
            observed_at: lastProbe.observed_at,
          },
        }),
    ...(receipt?.last_host_load_observed === undefined
      ? {}
      : { last_host_load_observed: receipt.last_host_load_observed.observed_at }),
    ...(nativeCheckFailure === undefined
      ? {}
      : {
          native_check_failure: {
            code: nativeCheckFailure.code,
            observed_at: nativeCheckFailure.observed_at,
          },
        }),
  };
  if (lastProbe?.outcome === "failed" || nativeCheckFailure !== undefined) {
    return { state: "failed", ...evidence };
  }
  if (receipt?.last_host_load_observed !== undefined && !reloadRequired) {
    return { state: "host-load-observed", ...evidence };
  }
  if (reloadRequired) return { state: "reload-required", ...evidence };
  if (launchable) return { state: "launchable", ...evidence };
  return { state: "configured", ...evidence };
}

function receiptMatchesDescriptor(receipt: McpHostReceipt, snapshot: McpEntrySnapshot): boolean {
  if (snapshot.command === undefined || snapshot.args === undefined) return false;
  try {
    return (
      receipt.descriptor_digest ===
      digestMcpReceiptDescriptor({ command: snapshot.command, args: snapshot.args })
    );
  } catch {
    return false;
  }
}

function installMark(status: SelfMcpHostStatus): InstallStatus {
  return status.entry_state === "missing"
    ? "no"
    : status.entry_state === "current"
      ? "si"
      : "drift";
}

function readHostReceipts(ctx: CliContext): HostReceiptLedger {
  const file = mcpHostReceiptFile(ctx.paths);
  if (!existsSync(file)) return { receipts: [] };
  try {
    return { receipts: parseMcpHostReceiptBook(readFileSync(file, "utf8")).receipts };
  } catch (error) {
    // The registry remains readable, but no lifecycle claim survives a corrupt
    // receipt ledger. Every host becomes explicitly actionable rather than
    // quietly falling back to an unproven "configured" state.
    return {
      receipts: [],
      failure: {
        code: error instanceof McpHostReceiptError ? error.code : "MCP_RECEIPT_UNREADABLE",
      },
    };
  }
}

export function isDsnVisible(ctx: CliContext, dsnVar: string): boolean {
  if (ctx.env.get(dsnVar)) return true;
  const dsn = readDsnFile(ctx.paths);
  return Boolean(dsn.values[dsnVar]);
}

const INSTALL_STATUS_ICON: Record<InstallStatus, string> = {
  si: "✓",
  no: "–",
  drift: "!",
};

export function formatConnectionsTable(connections: SelfMcpConnectionView[]): string {
  const headers = ["nombre", "DSN var", ...FILE_HOSTS.map((h) => HOST_COLUMN[h])];
  const rows = connections.map((item) => [
    item.nombre,
    item.dsn_var,
    ...FILE_HOSTS.map((h) => INSTALL_STATUS_ICON[item.instalado[h]]),
  ]);
  return renderBoxTable(headers, rows);
}

function formatConnectionsBlock(connections: SelfMcpConnectionView[]): string {
  const header =
    connections.length === 0
      ? "Conexiones MCP registradas (ninguna):"
      : `Conexiones MCP registradas (${connections.length}):`;
  const legend = "Leyenda: ✓ instalado · – no instalado · ! drift de configuración";
  return [header, formatConnectionsTable(connections), legend].join("\n");
}

function renderBoxTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, col) => {
    const cellMax = rows.reduce((max, row) => Math.max(max, (row[col] ?? "").length), 0);
    return Math.max(h.length, cellMax);
  });
  const buildLine = (left: string, mid: string, right: string): string =>
    `${left}${widths.map((w) => "─".repeat(w + 2)).join(mid)}${right}`;
  const buildRow = (cells: string[]): string =>
    `│${cells.map((cell, col) => ` ${(cell ?? "").padEnd(widths[col] ?? 0)} `).join("│")}│`;

  const top = buildLine("┌", "┬", "┐");
  const headerSep = buildLine("├", "┼", "┤");
  const bottom = buildLine("└", "┴", "┘");
  const out: string[] = [top, buildRow(headers)];
  if (rows.length === 0) {
    out.push(bottom);
    return out.join("\n");
  }
  out.push(headerSep);
  for (const row of rows) out.push(buildRow(row));
  out.push(bottom);
  return out.join("\n");
}

async function resolveRegisteredConnection(
  args: ParsedArgs,
  ctx: CliContext,
  prompts: SelfMcpPrompts,
): Promise<RegisteredConnectionResult> {
  let connections: McpConnection[];
  try {
    connections = readMcpConnections(ctx.paths, ctx.env);
  } catch (error) {
    if (error instanceof McpConnectionsError) {
      return { kind: "invalid", issue: mcpRegistryIssue(ctx) };
    }
    throw error;
  }
  if (connections.length === 0) return { kind: "none" };
  const raw = args.values.get("name") ?? args.values.get("instance");
  if (raw !== undefined) {
    const validation = validateMcpInstance(raw);
    if (!validation.ok) throw new Error(validation.error);
    const found = connections.find((item) => item.name === validation.value);
    if (found === undefined) {
      throw new Error(`conexión MCP no registrada: '${validation.value}'`);
    }
    return { kind: "found", connection: found };
  }
  const defaultConnection = connections[0]?.name;
  const selected = await prompts.select<McpInstance>({
    message: "Conexión a operar",
    ...(defaultConnection !== undefined ? { default: defaultConnection } : {}),
    choices: connections.map((item) => ({
      name: `${item.name} (${item.dsnVar})`,
      value: item.name,
    })),
  });
  const connection = connections.find((item) => item.name === selected);
  return connection === undefined ? { kind: "none" } : { kind: "found", connection };
}

async function resolveConnectionName(
  args: ParsedArgs,
  prompts: SelfMcpPrompts,
): Promise<McpInstance> {
  const raw = args.values.get("name") ?? args.values.get("instance");
  if (raw !== undefined) {
    const validation = validateMcpInstance(raw);
    if (!validation.ok) throw new Error(validation.error);
    return validation.value;
  }
  const value = await prompts.input({
    message: "Nombre de la nueva conexión (slug-kebab)",
    default: "alpha",
    validate: (input) => {
      const validation = validateMcpInstance(input);
      return validation.ok ? true : validation.error;
    },
  });
  const validation = validateMcpInstance(value);
  if (!validation.ok) throw new Error(validation.error);
  return validation.value;
}

async function resolveDsnVar(
  args: ParsedArgs,
  prompts: SelfMcpPrompts,
  name: McpInstance,
): Promise<string> {
  const raw = args.values.get("dsn-var") ?? args.values.get("var");
  if (raw !== undefined) {
    const validation = validateDsnVarName(raw);
    if (!validation.ok) throw new Error(validation.error);
    return validation.value;
  }
  const value = await prompts.input({
    message: "Variable de entorno con la DSN (UPPER_SNAKE_CASE)",
    default: dsnKeyForInstance(name),
    validate: (input) => {
      const validation = validateDsnVarName(input);
      return validation.ok ? true : validation.error;
    },
  });
  const validation = validateDsnVarName(value);
  if (!validation.ok) throw new Error(validation.error);
  return validation.value;
}

export function buildEnvHelp(
  dsnVar: string,
  name: McpInstance,
): NonNullable<SelfMcpConfigData["env_help"]> {
  const variable = normalizeDsnVarName(dsnVar);
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const commands =
    process.platform === "win32"
      ? [
          `$env:${variable} = "<DSN>"`,
          `[Environment]::SetEnvironmentVariable("${variable}", "<DSN>", "User")`,
        ]
      : [
          `export ${variable}='<DSN>'`,
          `printf '%s\\n' "export ${variable}='<DSN>'" >> ${shellStartupFile()}`,
        ];
  return {
    platform,
    variable,
    commands,
    next_step: `agent-workflow self mcp use-env --name ${name} --dsn-var ${variable}`,
  };
}

function shellStartupFile(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("/zsh")) return "~/.zshenv";
  if (shell.endsWith("/bash")) return "~/.bashrc";
  return "~/.profile";
}

async function loadPrompts(): Promise<SelfMcpPrompts> {
  const prompts = await import("@inquirer/prompts");
  return {
    select: <T extends string>(options: {
      message: string;
      choices: PromptChoiceOrSeparator<T>[];
      default?: T;
    }) => {
      const choices = options.choices.map((choice) => {
        if (isPromptSeparator(choice)) {
          return new prompts.Separator(choice.separator);
        }
        return { name: choice.name, value: choice.value };
      });
      const baseOpts: Parameters<typeof prompts.select<T>>[0] = {
        message: options.message,
        choices,
      };
      if (options.default !== undefined) baseOpts.default = options.default;
      return prompts.select(baseOpts);
    },
    input: prompts.input,
  };
}

async function resolveAction(args: ParsedArgs, prompts: SelfMcpPrompts): Promise<ResolvedAction> {
  const raw = args.values.get("action") ?? args.rest[1];
  if (isAction(raw)) return { action: raw, fromArgs: true };
  return {
    action: await prompts.select<SelfMcpAction>({
      message: "Configurar MCP database (PostgreSQL Workline)",
      default: "list",
      choices: [
        { type: "separator", separator: "── Conexiones existentes ──" },
        { name: "▸ Listar / operar", value: "list" },
        { type: "separator", separator: "── Registrar nueva conexión ──" },
        { name: "▸ Utilizar DSN env var existente", value: "use-env" },
        { name: "▸ Crear DSN env var (ayuda)", value: "create-env" },
        { type: "separator" },
        { name: "⏎ Cancelar", value: "cancel" },
      ],
    }),
    fromArgs: false,
  };
}

function isAction(value: string | undefined): value is SelfMcpAction {
  if (value === undefined) return false;
  if (
    value === "list" ||
    value === "use-env" ||
    value === "create-env" ||
    value === "doctor" ||
    value === "remove" ||
    value === "cancel"
  ) {
    return true;
  }
  if (value.startsWith("install-")) {
    return (FILE_HOSTS as readonly string[]).includes(value.slice("install-".length));
  }
  return false;
}

function hostAction(host: McpHost): InstallAction {
  return `install-${host}`;
}

function refusal(
  action: SelfMcpAction,
  connection: SelfMcpConnectionView,
  message: string,
): CommandResult<SelfMcpConfigData> {
  return {
    ok: false,
    error: { code: "GLOBAL_REQUIRES_FORCE", message },
    data: { action, connection, summary: message },
    exitCode: 2,
  };
}
