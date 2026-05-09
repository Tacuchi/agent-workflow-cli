import { resolve } from "node:path";
import type { ParsedArgs } from "../../cli/parser.js";
import type { CliContext } from "../../cli/types.js";
import {
  type McpHost,
  type McpInstance,
  buildMcpEntry,
  mcpEntryNameFor,
  normalizeDsnVarName,
  validateDsnVarName,
  validateMcpInstance,
} from "../../domain/mcp-entry.js";
import type { CommandResult } from "../../domain/types.js";
import { readBootstrapDsn } from "../dsn-reader-service.js";
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

type SelfMcpAction =
  | "list"
  | "use-env"
  | "create-env"
  | "install-claude"
  | "install-codex"
  | "doctor"
  | "remove"
  | "cancel";

type InstallStatus = "si" | "no" | "drift";
type ConnectionMenuAction = "install-claude" | "install-codex" | "doctor" | "remove" | "cancel";

interface PromptChoice<T extends string> {
  name: string;
  value: T;
  description?: string;
}

export interface SelfMcpPrompts {
  select<T extends string>(options: {
    message: string;
    choices: PromptChoice<T>[];
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
  instalado: {
    claude_code: InstallStatus;
    codex: InstallStatus;
  };
}

export interface SelfMcpConfigData {
  action: SelfMcpAction;
  connection: SelfMcpConnectionView | null;
  connections?: SelfMcpConnectionView[];
  table?: string;
  registry?: { path: string; changed: boolean };
  setup?: McpSetupResult;
  remove?: McpRemoveResult;
  doctor?: McpDoctorResult;
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
    case "install-claude":
      return runConnectionAction(args, ctx, prompt, resolved.action);
    case "install-codex":
      return runConnectionAction(args, ctx, prompt, resolved.action);
    case "doctor":
      return runConnectionAction(args, ctx, prompt, resolved.action);
    case "remove":
      return runConnectionAction(args, ctx, prompt, resolved.action);
    case "cancel":
      return {
        ok: true,
        data: { action: "cancel", connection: null, summary: "Operación cancelada." },
        exitCode: 0,
      };
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
    message: formatConnectionsTable(connections),
    default: "install-claude",
    choices: [
      { name: "Instalar/Actualizar en Claude Code", value: "install-claude" },
      { name: "Instalar/Actualizar en Codex", value: "install-codex" },
      { name: "Diagnosticar", value: "doctor" },
      { name: "Eliminar", value: "remove" },
      { name: "Cancelar", value: "cancel" },
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
    case "install-claude":
      return installConnection(args, ctx, connection, "claude");
    case "install-codex":
      return installConnection(args, ctx, connection, "codex");
    case "doctor":
      return doctorConnection(ctx, connection);
    case "remove":
      return removeConnection(args, ctx, connection);
  }
}

function installConnection(
  args: ParsedArgs,
  ctx: CliContext,
  connection: McpConnection,
  host: McpHost,
): CommandResult<SelfMcpConfigData> {
  const setup = runMcpSetup(ctx.env, {
    hosts: [host],
    instances: [connection.name],
    scope: "workspace",
    dsnVars: { [connection.name]: connection.dsnVar },
    dryRun: args.flags.has("--dry-run"),
  });
  if ("ok" in setup) return refusal(hostAction(host), connectionView(ctx, connection), setup.hint);
  const doctor = runDoctor(ctx, connection, [host]);
  const hasErrors = setup.errors.length > 0;
  return {
    ok: !hasErrors,
    data: {
      action: hostAction(host),
      connection: connectionView(ctx, connection),
      connections: connectionViews(ctx),
      table: formatConnectionsTable(connectionViews(ctx)),
      setup,
      doctor,
      summary: `Conexión '${connection.name}' instalada/actualizada en ${hostLabel(host)}.`,
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
  const doctor = runDoctor(ctx, connection, ["claude", "codex"]);
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
  const remove = runMcpRemove(ctx.env, {
    hosts: ["claude", "codex"],
    instances: [connection.name],
    scope: "workspace",
    dryRun,
  });
  if ("ok" in remove) return refusal("remove", connectionView(ctx, connection), remove.hint);
  const hasErrors = remove.errors.length > 0;
  const deleted = !dryRun && !hasErrors ? deleteMcpConnection(ctx.paths, connection) : null;
  return {
    ok: !hasErrors,
    data: {
      action: "remove",
      connection: connectionView(ctx, connection),
      connections: connectionViews(ctx),
      table: formatConnectionsTable(connectionViews(ctx)),
      remove,
      ...(deleted ? { registry: { path: deleted.path, changed: deleted.removed } } : {}),
      summary: dryRun
        ? `Previsualización de eliminación para '${connection.name}'.`
        : `Conexión '${connection.name}' eliminada de Claude Code, Codex y del registro local.`,
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
    scope: "workspace",
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
    instalado: {
      claude_code: installStatus(ctx, connection, "claude"),
      codex: installStatus(ctx, connection, "codex"),
    },
  };
}

function installStatus(ctx: CliContext, connection: McpConnection, host: McpHost): InstallStatus {
  const entry = buildMcpEntry(connection.name, connection.dsnVar);
  const snapshot = readMcpEntry(host, resolve(ctx.env.cwd()), entry.name);
  if (!snapshot.exists) return "no";
  if (snapshot.command !== entry.command) return "drift";
  if (!arraysEqual(snapshot.args ?? [], entry.args)) return "drift";
  if (!recordsEqual(snapshot.env ?? {}, entry.env)) return "drift";
  return "si";
}

function isDsnVisible(ctx: CliContext, dsnVar: string): boolean {
  if (ctx.env.get(dsnVar)) return true;
  const dsn = readBootstrapDsn(ctx.paths);
  return Boolean(dsn.values[dsnVar]);
}

function formatConnectionsTable(connections: SelfMcpConnectionView[]): string {
  const header = "| nombre | DSN var (nombre) | Instalado en Claude Code | Instalado en Codex |";
  const separator = "|---|---|---|---|";
  if (connections.length === 0) return `${header}\n${separator}`;
  const rows = connections.map(
    (item) =>
      `| ${item.nombre} | ${item.dsn_var} | ${item.instalado.claude_code} | ${item.instalado.codex} |`,
  );
  return [header, separator, ...rows].join("\n");
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
    message: "Conexión",
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
    message: "Nombre de conexión",
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
    message: "Nombre de variable DSN",
    default: defaultDsnVar(name),
    validate: (input) => {
      const validation = validateDsnVarName(input);
      return validation.ok ? true : validation.error;
    },
  });
  const validation = validateDsnVarName(value);
  if (!validation.ok) throw new Error(validation.error);
  return validation.value;
}

function defaultDsnVar(name: McpInstance): string {
  const normalized = name.toUpperCase().replace(/-/g, "_");
  if (normalized === "CERT") return "DB_CERT_DSN";
  if (normalized === "PROD") return "DB_PROD_DSN";
  return `DB_${normalized}_DSN`;
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
    select: prompts.select,
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
        { name: "Listar conexiones existentes", value: "list" },
        { name: "Utilizar DSN env var existente", value: "use-env" },
        { name: "Crear DSN env var", value: "create-env" },
        { name: "Cancelar", value: "cancel" },
      ],
    }),
    fromArgs: false,
  };
}

function isAction(value: string | undefined): value is SelfMcpAction {
  return (
    value === "list" ||
    value === "use-env" ||
    value === "create-env" ||
    value === "install-claude" ||
    value === "install-codex" ||
    value === "doctor" ||
    value === "remove" ||
    value === "cancel"
  );
}

function hostAction(host: McpHost): "install-claude" | "install-codex" {
  return host === "claude" ? "install-claude" : "install-codex";
}

function hostLabel(host: McpHost): string {
  return host === "claude" ? "Claude Code" : "Codex";
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

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function recordsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (!arraysEqual(keysA, keysB)) return false;
  for (const key of keysA) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}
