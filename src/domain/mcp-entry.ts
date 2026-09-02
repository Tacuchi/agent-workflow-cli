import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { readPackageVersion } from "../runtime/version.js";

export type McpHost = "claude" | "codex" | "warp" | "gemini" | "opencode" | "crush" | "kimi";

export type McpInstance = string;

export type McpEntryName = string;

export type McpEntryState = "current" | "known-legacy" | "foreign" | "missing" | "malformed";

/** A registered connection and the exact DSN variable it owns. */
export interface McpConnectionRef {
  name: McpInstance;
  dsnVar: string;
}

export interface McpEntry {
  name: McpEntryName;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Codex may keep database MCP servers non-blocking while CLI fallback works. */
  optional?: boolean;
}

export interface McpEntryLaunchOptions {
  /** The namespace that owns the connection registry; defaults only for legacy callers. */
  namespace?: string;
  /** The host writes its own name into the descriptor for observable diagnostics. */
  host?: McpHost;
  /** Receipt identity for host-specific reload and load observations. */
  scope?: "workspace" | "global";
  /** Test/embedded launcher override. Production uses the running Node binary. */
  nodePath?: string;
  /** Test/embedded entrypoint override. Production is the installed CLI entrypoint. */
  entrypoint?: string;
  /** Only used by the retained portable workspace descriptor. */
  platform?: NodeJS.Platform;
  /**
   * Global launch generation bound into argv and the receipt digest. A release
   * change prevents a still-running older binary from confirming a reload.
   */
  descriptorGeneration?: string;
}

/**
 * The complete persisted shape for one host's MCP entry.
 *
 * Ownership is deliberately structural: a server bearing the same name is not
 * ours unless this entire generated representation matches. Keeping the shape
 * next to the entry contract lets writers and read-only state probes enforce
 * the same rule without each inventing a partial "looks like Workline" test.
 */
export function mcpEntryShapeForHost(host: McpHost, entry: McpEntry): Record<string, unknown> {
  switch (host) {
    case "opencode":
      return {
        type: "local",
        command: [entry.command, ...entry.args],
        environment: { ...entry.env },
        enabled: true,
      };
    case "crush":
      return {
        type: "stdio",
        command: entry.command,
        args: [...entry.args],
        env: { ...entry.env },
      };
    case "codex":
      return {
        command: entry.command,
        args: [...entry.args],
        env: { ...entry.env },
        ...(entry.optional ? { required: false } : {}),
      };
    case "claude":
    case "warp":
    case "gemini":
    case "kimi":
      return {
        command: entry.command,
        args: [...entry.args],
        env: { ...entry.env },
      };
  }
}

export interface McpWriteOpts {
  dryRun?: boolean;
  /** A migration may replace this exact previously published Workline shape only. */
  replaceLegacy?: McpEntry;
}

export type McpWriteAction =
  | "written"
  | "removed"
  | "skipped-idempotent"
  | "dry-run"
  /** A same-named entry has a different shape and belongs to someone else. */
  | "conflict";

export interface McpWriteResult {
  host: McpHost;
  target: string;
  name: string;
  action: McpWriteAction;
  backup: string | null;
  diff?: string[];
  /** Claude legacy cleanup did not complete; both locations need recovery-aware readback. */
  partial?: {
    code: "MCP_LEGACY_CLEANUP_FAILED";
    /** The second Claude config location that still needs explicit recovery. */
    target: string;
    message: string;
  };
}

export type McpDriftStatus =
  | "ok"
  | "missing-mcp"
  | "dsn-mismatch"
  | "extra-entry"
  | "missing-dsn"
  | "legacy-entry"
  | "foreign-entry"
  | "malformed-entry";

export interface McpDriftReport {
  host: McpHost;
  instance: McpInstance;
  scope: "workspace" | "global";
  target: string;
  dsn: { path: string; exists: boolean; key: string; present: boolean };
  mcp: { name: string; present: boolean; matches: boolean };
  entry_state: McpEntryState;
  /** Workspace setup remains portable but depends on the host PATH. */
  launch_mode: "absolute" | "path-dependent";
  status: McpDriftStatus;
  detail?: string;
  /** Optional active launch/data evidence; absence means no active probe ran. */
  probe?: {
    mode: "launch" | "data";
    outcome: "passed" | "failed";
    phase?: "spawn" | "initialize" | "initialized" | "tools/list" | "tools/call";
    code?: string;
  };
  /** Direct role inspection used only by `mcp doctor --probe data`. */
  safety?: {
    status: "safe" | "warning" | "blocked";
    superuser: boolean;
    write_capable: boolean;
    create_role: boolean;
    create_database: boolean;
    /** Membership or SET ROLE path to a dangerous predefined PostgreSQL server role. */
    unsafe_server_role: boolean;
    code?: string;
  };
}

export function normalizeMcpInstance(input: string): McpInstance {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

export function validateMcpInstance(
  input: string,
): { ok: true; value: McpInstance } | { ok: false; error: string } {
  const value = normalizeMcpInstance(input);
  if (value.length === 0) {
    return { ok: false, error: "el nombre de conexión MCP no puede estar vacío" };
  }
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    return {
      ok: false,
      error: "nombre de conexión MCP inválido; usá letras, números y guiones, e iniciá con letra",
    };
  }
  return { ok: true, value };
}

export function mcpEntryNameFor(instance: McpInstance): McpEntryName {
  return normalizeMcpInstance(instance);
}

export function normalizeDsnVarName(input: string): string {
  return input.trim().toUpperCase();
}

export function validateDsnVarName(
  input: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = normalizeDsnVarName(input);
  if (value.length === 0) {
    return { ok: false, error: "el nombre de variable DSN no puede estar vacío" };
  }
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    return {
      ok: false,
      error: "variable DSN inválida; usá letras, números y guiones bajos, e iniciá con letra o '_'",
    };
  }
  return { ok: true, value };
}

export function buildMcpEntry(
  instance: McpInstance,
  dsnVar: string,
  options: McpEntryLaunchOptions | string = {},
): McpEntry {
  const normalized = normalizeMcpInstance(instance);
  // The registry retains the DSN variable as secret ownership metadata. It is
  // intentionally absent from the persisted host descriptor.
  void dsnVar;
  // Keep the historical platform string source-compatible for workspace
  // descriptors. Global/TUI descriptors deliberately ignore shell shims.
  const launch = normalizeMcpEntryOptions(options);
  const namespace = launch.namespace ?? "workflow";
  const host = launch.host ?? "codex";
  const scope = launch.scope ?? "workspace";
  const platform = launch.platform ?? process.platform;
  const nodePath = launch.nodePath ?? process.execPath;
  const entrypoint = launch.entrypoint ?? fileURLToPath(new URL("../cli/main.js", import.meta.url));
  requireAbsoluteGlobalDescriptor(scope, nodePath, entrypoint);
  const generation = descriptorGenerationFor(scope, launch);
  const serveArgs = databaseServeArgs(namespace, normalized, host, scope, generation);
  const command = descriptorCommand(scope, platform, nodePath);
  const args = descriptorArgs(scope, platform, entrypoint, serveArgs);
  return {
    name: mcpEntryNameFor(normalized),
    command,
    args,
    // DSNs stay in the registry environment or dsn.env, never in host config.
    env: {},
    optional: true,
  };
}

/** Global registrations must remain independently launchable after a host reload. */
function requireAbsoluteGlobalDescriptor(
  scope: "workspace" | "global",
  nodePath: string,
  entrypoint: string,
): void {
  if (scope !== "global") return;
  if (!isAbsolute(nodePath) || !isAbsolute(entrypoint)) {
    throw new Error("Los descriptores MCP globales requieren Node y entrypoint absolutos.");
  }
}

function normalizeMcpEntryOptions(options: McpEntryLaunchOptions | string): McpEntryLaunchOptions {
  return typeof options === "string" ? { platform: options as NodeJS.Platform } : options;
}

function descriptorGenerationFor(
  scope: "workspace" | "global",
  launch: McpEntryLaunchOptions,
): string | undefined {
  if (scope === "workspace") return undefined;
  return launch.descriptorGeneration ?? readPackageVersion();
}

function databaseServeArgs(
  namespace: string,
  instance: string,
  host: McpHost,
  scope: "workspace" | "global",
  generation: string | undefined,
): string[] {
  return [
    "mcp",
    "serve-db",
    "--namespace",
    namespace,
    "--instance",
    instance,
    "--host",
    host,
    "--scope",
    scope,
    ...(generation === undefined ? [] : ["--descriptor-generation", generation]),
  ];
}

function descriptorCommand(
  scope: "workspace" | "global",
  platform: NodeJS.Platform,
  nodePath: string,
): string {
  if (scope === "global") return nodePath;
  return platform === "win32" ? "cmd" : "agent-workflow";
}

function descriptorArgs(
  scope: "workspace" | "global",
  platform: NodeJS.Platform,
  entrypoint: string,
  serveArgs: string[],
): string[] {
  if (scope === "global") return [entrypoint, ...serveArgs];
  return platform === "win32" ? ["/c", "agent-workflow", ...serveArgs] : serveArgs;
}

/** The immediately preceding reliable descriptor shape, before release binding. */
export function previousReliableMcpEntry(entry: McpEntry): McpEntry | undefined {
  const generation = entry.args.indexOf("--descriptor-generation");
  if (generation < 0 || generation !== entry.args.length - 2) return undefined;
  return {
    ...entry,
    args: [...entry.args.slice(0, generation), ...entry.args.slice(generation + 2)],
  };
}

/**
 * The same descriptor as this installation published under another release.
 *
 * A release only rebinds the trailing `--descriptor-generation` value, so an
 * on-disk entry that differs from the current one in nothing else was written
 * by this very install: same absolute launcher, same entrypoint, same
 * namespace, instance, host and scope. Treating it as somebody else's server
 * would make every upgrade orphan the entries Workline itself wrote.
 *
 * Returns the entry as it sits on disk — the exact shape a writer may replace
 * or retire — or `undefined` when anything beyond that value differs. It is
 * deliberately blind to which release is newer: the descriptor has to launch
 * the binary that exists, and rewriting it is an explicit install either way.
 */
export function generationVariantMcpEntry(
  entry: McpEntry,
  observed: readonly string[],
): McpEntry | undefined {
  const flag = entry.args.length - 2;
  if (flag < 0 || entry.args[flag] !== "--descriptor-generation") return undefined;
  if (observed.length !== entry.args.length || observed[flag] !== "--descriptor-generation") {
    return undefined;
  }
  const generation = observed[observed.length - 1];
  if (generation === undefined || generation.length === 0) return undefined;
  if (generation === entry.args[entry.args.length - 1]) return undefined;
  if (observed.slice(0, flag).some((arg, index) => arg !== entry.args[index])) return undefined;
  // Built from `entry`, never from the observation: name, command, env and
  // `optional` must stay this install's own, and the prefix is already proven equal.
  return { ...entry, args: [...entry.args.slice(0, -1), generation] };
}

/**
 * Exact historic Workline descriptors that the migration is allowed to own.
 * This deliberately does not include generic `npx @bytebase/dbhub` entries:
 * those are indistinguishable from a person's independently managed server.
 */
export function knownLegacyMcpEntries(instance: McpInstance, dsnVar: string): McpEntry[] {
  const normalized = normalizeMcpInstance(instance);
  const env = {
    DBHUB_DSN_VAR: normalizeDsnVarName(dsnVar),
    MAX_ROWS: "1000",
    READONLY: "true",
    TRANSPORT: "stdio",
  };
  const flag = ["mcp", "dbhub", "--instance", normalized];
  const positional = ["mcp", "dbhub", normalized];
  return [
    { name: mcpEntryNameFor(normalized), command: "agent-workflow", args: flag, env },
    { name: mcpEntryNameFor(normalized), command: "agent-workflow", args: positional, env },
    {
      name: mcpEntryNameFor(normalized),
      command: "cmd",
      args: ["/c", "agent-workflow", ...flag],
      env,
    },
    {
      name: mcpEntryNameFor(normalized),
      command: "cmd",
      args: ["/c", "agent-workflow", ...positional],
      env,
    },
  ];
}

/**
 * Published connection names that predate the qtc-* namespace. They are not a
 * general rename mechanism: migration may retire only these exact historic
 * aliases after proving the descriptor is Workline-owned.
 */
export function knownLegacyMcpInstanceAliases(instance: McpInstance): readonly McpInstance[] {
  switch (normalizeMcpInstance(instance)) {
    case "qtc-cert":
      return ["cert"];
    case "qtc-prod":
      return ["prod"];
    default:
      return [];
  }
}
