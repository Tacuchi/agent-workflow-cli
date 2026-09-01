import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { harnessForMcpHost } from "../domain/harnesses.js";
import type { McpHost } from "../domain/mcp-entry.js";
import { crushGlobalMcpFile, opencodeGlobalMcpFile } from "./mcp-host-paths.js";
import { resolveWarpGlobalMcpPath } from "./multiroot/warp.js";

export type ReaderScopeKind = "workspace" | "global";

export interface McpEntrySnapshot {
  host: McpHost;
  target: string;
  name: string;
  exists: boolean;
  /** A same-named raw value exists but cannot be decoded as an MCP entry. */
  present?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** The named value has an MCP-shaped container but invalid field types. */
  malformed?: boolean;
  raw?: unknown;
  /** Claude entry came from the historical `.claude/settings.json` location. */
  legacy_location?: boolean;
  /** A second Claude location is occupied and must not be silently ignored. */
  secondary?: McpEntrySnapshot;
}

export function readMcpEntry(
  host: McpHost,
  scopeDir: string,
  name: string,
  kind: ReaderScopeKind = "workspace",
): McpEntrySnapshot {
  const spec = harnessForMcpHost(host);
  if (spec?.projectMcpPath === undefined) return missingSnapshot(host, scopeDir, name);

  const hostSpecific = readHostSpecificEntry(host, scopeDir, name, kind);
  if (hostSpecific !== undefined) return hostSpecific;

  const target = join(scopeDir, ...spec.projectMcpPath.split("/"));
  return readJsonMcpEntry(host, target, name);
}

function readHostSpecificEntry(
  host: McpHost,
  scopeDir: string,
  name: string,
  kind: ReaderScopeKind,
): McpEntrySnapshot | undefined {
  if (host === "codex") {
    return readTomlMcpEntry(host, join(scopeDir, ".codex", "config.toml"), name, "mcp_servers");
  }
  if (host === "claude") return readClaudeMcpEntry(scopeDir, name, kind);
  if (host === "opencode" || host === "crush") {
    return readMcpKeyEntry(host, mcpKeyTarget(host, scopeDir, kind), name);
  }
  if (host !== "warp" || kind !== "global") return undefined;
  const globalPath = resolveWarpGlobalMcpPath(process.platform, () => scopeDir);
  return globalPath === null ? undefined : readJsonMcpEntry(host, globalPath, name);
}

// Claude historically accepted the same mcpServers object under
// `.claude/settings.json`. Prefer the current `.mcp.json` / `.claude.json`
// location, but surface an occupied historical location rather than hiding it
// as absent: migration may only replace an exact known Workline shape.
function readClaudeMcpEntry(
  scopeDir: string,
  name: string,
  kind: ReaderScopeKind,
): McpEntrySnapshot {
  const primaryTarget = kind === "global" ? ".claude.json" : ".mcp.json";
  const primary = readJsonMcpEntry("claude", join(scopeDir, primaryTarget), name);
  const legacy = readJsonMcpEntry("claude", join(scopeDir, ".claude", "settings.json"), name);
  if (primary.exists || primary.present) {
    return legacy.exists || legacy.present ? { ...primary, secondary: legacy } : primary;
  }
  return legacy.exists || legacy.present ? { ...legacy, legacy_location: true } : primary;
}

function mcpKeyTarget(host: "opencode" | "crush", scopeDir: string, kind: ReaderScopeKind): string {
  if (kind !== "global") return join(scopeDir, `${host}.json`);
  return host === "opencode" ? opencodeGlobalMcpFile(scopeDir) : crushGlobalMcpFile(scopeDir);
}

function missingSnapshot(host: McpHost, target: string, name: string): McpEntrySnapshot {
  return { host, target, name, exists: false };
}

type LoadedMcpEntry =
  | { state: "entry"; value: Record<string, unknown> }
  | { state: "foreign"; value: unknown }
  | { state: "malformed" }
  | null;

type DecodedMcpEntry = { snapshot: McpEntrySnapshot } | { entry: Record<string, unknown> };

// Shared preamble: exists check → read → empty check → try-parse → key extract.
// A same-named scalar is preserved as `foreign`: it is not a usable entry, but
// callers deciding ownership must not mistake it for an absent name.
function loadEntryObject(
  target: string,
  parse: (text: string) => unknown,
  key: string,
  name: string,
): LoadedMcpEntry {
  if (!existsSync(target)) return null;
  const text = readFileSync(target, "utf-8");
  if (text.trim().length === 0) return null;
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return { state: "malformed" };
  }
  if (!isRecord(data)) return { state: "malformed" };
  const servers = data[key];
  if (servers === undefined) return null;
  if (!isRecord(servers)) return { state: "malformed" };
  const entry = servers[name];
  if (entry === undefined) return null;
  if (!isRecord(entry)) return { state: "foreign", value: entry };
  return { state: "entry", value: entry };
}

// Standard Claude-shaped snapshot: command/args/env fields on the entry.
function stdSnapshot(
  host: McpHost,
  target: string,
  name: string,
  e: Record<string, unknown>,
): McpEntrySnapshot {
  const command = typeof e.command === "string" ? e.command : undefined;
  const args = stringArray(e.args);
  const env = e.env === undefined ? undefined : stringRecord(e.env);
  const malformed =
    command === undefined || args === undefined || (e.env !== undefined && env === undefined);

  return {
    host,
    target,
    name,
    exists: true,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(malformed ? { malformed: true } : {}),
    raw: e,
  };
}

function readJsonMcpEntry(host: McpHost, target: string, name: string): McpEntrySnapshot {
  const decoded = decodeMcpEntry(
    host,
    target,
    name,
    loadEntryObject(target, JSON.parse, "mcpServers", name),
  );
  return "snapshot" in decoded ? decoded.snapshot : stdSnapshot(host, target, name, decoded.entry);
}

// Reader for hosts that store the MCP entry under the top-level `mcp` key.
// OpenCode: { type:"local", command:[cmd, ...args], environment }. The database
// command is the first array element and args are the rest; env lives under
// `environment`. Crush: { type:"stdio", command, args, env } (Claude-like fields).
function readMcpKeyEntry(host: McpHost, target: string, name: string): McpEntrySnapshot {
  const decoded = decodeMcpEntry(
    host,
    target,
    name,
    loadEntryObject(target, JSON.parse, "mcp", name),
  );
  if ("snapshot" in decoded) return decoded.snapshot;
  return host === "opencode"
    ? openCodeSnapshot(host, target, name, decoded.entry)
    : stdSnapshot(host, target, name, decoded.entry);
}

function openCodeSnapshot(
  host: "opencode",
  target: string,
  name: string,
  entry: Record<string, unknown>,
): McpEntrySnapshot {
  const command = stringArray(entry.command);
  const env = entry.environment === undefined ? undefined : stringRecord(entry.environment);
  const malformed =
    command === undefined ||
    command.length === 0 ||
    (entry.environment !== undefined && env === undefined);
  return {
    host,
    target,
    name,
    exists: true,
    ...(command === undefined || command.length === 0 ? {} : { command: command[0] }),
    ...(command === undefined ? {} : { args: command.slice(1) }),
    ...(env === undefined ? {} : { env }),
    ...(malformed ? { malformed: true } : {}),
    raw: entry,
  };
}

function readTomlMcpEntry(
  host: McpHost,
  target: string,
  name: string,
  serversKey: string,
): McpEntrySnapshot {
  const decoded = decodeMcpEntry(
    host,
    target,
    name,
    loadEntryObject(target, parseToml, serversKey, name),
  );
  return "snapshot" in decoded ? decoded.snapshot : stdSnapshot(host, target, name, decoded.entry);
}

function decodeMcpEntry(
  host: McpHost,
  target: string,
  name: string,
  loaded: LoadedMcpEntry,
): DecodedMcpEntry {
  if (loaded === null) return { snapshot: missingSnapshot(host, target, name) };
  if (loaded.state === "malformed") {
    return { snapshot: { host, target, name, exists: false, present: true } };
  }
  if (loaded.state === "foreign") {
    return { snapshot: { host, target, name, exists: false, present: true, raw: loaded.value } };
  }
  return { entry: loaded.value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return [...value] as string[];
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}
