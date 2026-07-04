import { isDeepStrictEqual } from "node:util";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import { HARNESSES } from "../../domain/harnesses.js";
import {
  type McpHost,
  type McpInstance,
  buildMcpEntry,
  isDbhubManagedEntry,
  mcpEntryNameFor,
  normalizeDsnVarName,
  validateDsnVarName,
  validateMcpInstance,
} from "../../domain/mcp-entry.js";
import type { CommandResult } from "../../domain/types.js";
import { dsnKeyForInstance, readBootstrapDsn } from "../dsn-reader-service.js";
import {
  type McpConnection,
  deleteMcpConnection,
  readMcpConnections,
  upsertMcpConnection,
} from "../mcp-connections-service.js";
import { type McpDoctorResult, runMcpDoctor } from "../mcp-doctor-service.js";
import { readMcpEntry } from "../mcp-host-reader.js";
import { type McpRemoveResult, runMcpRemove } from "../mcp-remove-service.js";
import { type McpSetupResult, runMcpSetup } from "../mcp-setup-service.js";
import {
  type WarpPostInstallHint,
  buildWarpPostInstallHint,
} from "../mcp-warp-postinstall-hint.js";

// Hosts with a file-based MCP config the CLI can write, derived from the registry
// (all 6: claude/codex/warp/gemini/opencode/crush). Keeping this data-driven means
// a newly-supported host shows up in the wizard menu, status table, doctor and
// remove automatically — no host can be silently left on 3.
const FILE_HOSTS: readonly McpHost[] = HARNESSES.filter((h) => h.mcpHostId !== null).map(
  (h) => h.mcpHostId as McpHost,
);
const HOST_LABEL: Record<McpHost, string> = {
  claude: "Claude Code",
  codex: "Codex",
  warp: "Warp Terminal",
  gemini: "Gemini CLI / Antigravity",
  opencode: "OpenCode",
  crush: "Crush",
};
// Concise column headers for the status table.
const HOST_COLUMN: Record<McpHost, string> = {
  claude: "Claude",
  codex: "Codex",
  warp: "Warp",
  gemini: "Gemini",
  opencode: "OpenCode",
  crush: "Crush",
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
}

export interface SelfMcpConfigData {
  action: SelfMcpAction;
  connection: SelfMcpConnectionView | null;
  connections?: SelfMcpConnectionView[];
  table?: string;
  registry?: { path: string; changed: boolean };
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

  switch (resolved.action) {
    case "list":
      return resolved.fromArgs ? listConnections(ctx) : listConnectionsMenu(args, ctx, prompt);
    case "use-env":
      return useExistingDsnVar(args, ctx, prompt);
    case "create-env":
      return createDsnEnvHelp(args, prompt);
    case "cancel":
      return {
        ok: true,
        data: { action: "cancel", connection: null, summary: "Operación cancelada." },
        exitCode: 0,
      };
    default:
      // install-<host> | doctor | remove — all operate on a registered connection.
      return runConnectionAction(args, ctx, prompt, resolved.action);
  }
}

function listConnections(ctx: CliContext): CommandResult<SelfMcpConfigData> {
  const connections = connectionViews(ctx);
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
  const connections = connectionViews(ctx);
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
      { type: "separator", separator: "── Instalar / Actualizar ──" },
      ...FILE_HOSTS.map((h) => ({
        name: `▸ ${HOST_LABEL[h]}`,
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
    dsnPresent: true,
  });
  return {
    ok: true,
    data: {
      action: "use-env",
      connection,
      connections: connectionViews(ctx),
      table: formatConnectionsTable(connectionViews(ctx)),
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
  const connection = await resolveRegisteredConnection(args, ctx, prompts);
  if (connection === null) {
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

function installConnection(
  args: ParsedArgs,
  ctx: CliContext,
  connection: McpConnection,
  host: McpHost,
): CommandResult<SelfMcpConfigData> {
  // User scope: the explicit install action (TUI button / menu choice) IS the
  // consent the global_requires_force guard asks for, hence force: true.
  const setup = runMcpSetup(ctx.env, {
    hosts: [host],
    instances: [connection.name],
    scope: "global",
    force: true,
    dsnVars: { [connection.name]: connection.dsnVar },
    dryRun: args.flags.has("--dry-run"),
  });
  if ("ok" in setup) return refusal(hostAction(host), connectionView(ctx, connection), setup.hint);
  const doctor = runDoctor(ctx, connection, [host]);
  const hasErrors = setup.errors.length > 0;
  // The hint cites the file actually written (per-platform global path).
  const warpTarget = [...setup.applied, ...setup.skipped].find((r) => r.host === "warp")?.target;
  const warpHint =
    host === "warp" && !hasErrors && warpTarget
      ? buildWarpPostInstallHint(mcpEntryNameFor(connection.name), "global", warpTarget)
      : undefined;
  return {
    ok: !hasErrors,
    data: {
      action: hostAction(host),
      connection: connectionView(ctx, connection),
      connections: connectionViews(ctx),
      table: formatConnectionsTable(connectionViews(ctx)),
      setup,
      doctor,
      ...(warpHint ? { warp_hint: warpHint } : {}),
      summary: warpHint
        ? `Conexión '${connection.name}' escrita en ${warpHint.file}. Activá 'File-based MCP Servers' en Warp Settings para que la spawnee.`
        : `Conexión '${connection.name}' instalada/actualizada en ${hostLabel(host)}.`,
    },
    ...(hasErrors
      ? {
          error: {
            code: "MCP_SETUP_PARTIAL",
            message: `${setup.errors.length} error(es) durante setup; ver data.setup.errors`,
          },
        }
      : {}),
    exitCode: hasErrors ? 1 : 0,
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

function removeConnection(
  args: ParsedArgs,
  ctx: CliContext,
  connection: McpConnection,
): CommandResult<SelfMcpConfigData> {
  const dryRun = args.flags.has("--dry-run");
  // Ownership guard: a same-named global entry the tool never wrote (user's own
  // server) is preserved — remove only fans out to hosts whose entry is ours.
  const entryName = mcpEntryNameFor(connection.name);
  const preservedForeign = FILE_HOSTS.filter((host) => {
    const snapshot = readMcpEntry(host, ctx.env.homeDir(), entryName, "global");
    return snapshot.exists && !isDbhubManagedEntry(snapshot);
  });
  const removableHosts = FILE_HOSTS.filter((host) => !preservedForeign.includes(host));
  // User scope; the explicit remove action is the consent the guard asks for.
  const remove = runMcpRemove(ctx.env, {
    hosts: removableHosts,
    instances: [connection.name],
    scope: "global",
    force: true,
    dryRun,
  });
  if ("ok" in remove) return refusal("remove", connectionView(ctx, connection), remove.hint);
  const hasErrors = remove.errors.length > 0;
  const deleted = !dryRun && !hasErrors ? deleteMcpConnection(ctx.paths, connection) : null;
  const preservedNote =
    preservedForeign.length > 0
      ? ` Se conservó la entrada ajena homónima en: ${preservedForeign.join(", ")}.`
      : "";
  return {
    ok: !hasErrors,
    data: {
      action: "remove",
      connection: connectionView(ctx, connection),
      connections: connectionViews(ctx),
      table: formatConnectionsTable(connectionViews(ctx)),
      remove,
      ...(preservedForeign.length > 0 ? { preserved_foreign: preservedForeign } : {}),
      ...(deleted ? { registry: { path: deleted.path, changed: deleted.removed } } : {}),
      summary: dryRun
        ? `Previsualización de eliminación para '${connection.name}'.${preservedNote}`
        : `Conexión '${connection.name}' eliminada de los hosts con MCP y del registro local.${preservedNote}`,
    },
    ...(hasErrors
      ? {
          error: {
            code: "MCP_REMOVE_PARTIAL",
            message: `${remove.errors.length} error(es) durante remove; ver data.remove.errors`,
          },
        }
      : {}),
    exitCode: hasErrors ? 1 : 0,
  };
}

function runDoctor(ctx: CliContext, connection: McpConnection, hosts: McpHost[]): McpDoctorResult {
  return runMcpDoctor(ctx.env, ctx.paths, {
    hosts,
    instances: [connection.name],
    scope: "global",
    dsnVars: { [connection.name]: connection.dsnVar },
  });
}

function connectionViews(ctx: CliContext): SelfMcpConnectionView[] {
  return readMcpConnections(ctx.paths, ctx.env).map((connection) =>
    connectionView(ctx, connection),
  );
}

function connectionView(ctx: CliContext, connection: McpConnection): SelfMcpConnectionView {
  return {
    nombre: connection.name,
    server_name: mcpEntryNameFor(connection.name),
    dsn_var: connection.dsnVar,
    dsn_visible: isDsnVisible(ctx, connection.dsnVar),
    instalado: Object.fromEntries(
      FILE_HOSTS.map((h) => [h, installStatus(ctx, connection, h)]),
    ) as Record<McpHost, InstallStatus>,
  };
}

function installStatus(ctx: CliContext, connection: McpConnection, host: McpHost): InstallStatus {
  const entry = buildMcpEntry(connection.name, connection.dsnVar);
  const snapshot = readMcpEntry(host, ctx.env.homeDir(), entry.name, "global");
  if (!snapshot.exists) return "no";
  if (snapshot.command !== entry.command) return "drift";
  if (!isDeepStrictEqual(snapshot.args ?? [], entry.args)) return "drift";
  if (!isDeepStrictEqual(snapshot.env ?? {}, entry.env)) return "drift";
  return "si";
}

export function isDsnVisible(ctx: CliContext, dsnVar: string): boolean {
  if (ctx.env.get(dsnVar)) return true;
  const dsn = readBootstrapDsn(ctx.paths);
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
): Promise<McpConnection | null> {
  const connections = readMcpConnections(ctx.paths, ctx.env);
  if (connections.length === 0) return null;
  const raw = args.values.get("name") ?? args.values.get("instance");
  if (raw !== undefined) {
    const validation = validateMcpInstance(raw);
    if (!validation.ok) throw new Error(validation.error);
    const found = connections.find((item) => item.name === validation.value);
    if (found === undefined) {
      throw new Error(`conexión MCP no registrada: '${validation.value}'`);
    }
    return found;
  }
  const selected = await prompts.select<McpInstance>({
    message: "Conexión a operar",
    default: connections[0]?.name ?? "cert",
    choices: connections.map((item) => ({
      name: `${item.name} (${item.dsnVar})`,
      value: item.name,
    })),
  });
  return connections.find((item) => item.name === selected) ?? null;
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
    default: "cert",
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

function buildEnvHelp(
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
      message: "Configurar MCP database (dbhub)",
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

function hostLabel(host: McpHost): string {
  return HOST_LABEL[host];
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
