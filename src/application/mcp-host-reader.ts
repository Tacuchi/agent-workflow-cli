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
  /**
   * A REMOTE entry: `{type:"http"|"sse", url}` and its variants, which the host
   * reaches over the network instead of spawning, and which needs no command.
   *
   * The URL itself is deliberately NOT retained — it can carry a token in its
   * query string, and `raw` already holds whatever the file said for the
   * ownership predicates. The flag exists because "there is no command" and "the
   * command is missing" are different entries, and the readers only ever had to
   * answer the stdio question until the doctor started sweeping every entry a
   * host holds — ours and other people's alike.
   */
  remote?: true;
  /** The named value has an MCP-shaped container but invalid field types. */
  malformed?: boolean;
  raw?: unknown;
  /** Claude entry came from the historical `.claude/settings.json` location. */
  legacy_location?: boolean;
  /** A second Claude location is occupied and must not be silently ignored. */
  secondary?: McpEntrySnapshot;
}

/**
 * Where one host keeps its MCP entries, and under which key.
 *
 * The single source for both readers here. Reading ONE entry by name and
 * listing every entry a host holds are the same question about the same files,
 * and answering them from two tables is how a listing ends up blind to the
 * historical Claude location that the single reader still honours.
 */
interface McpEntryContainer {
  target: string;
  /** Top-level key holding the servers map. */
  key: "mcpServers" | "mcp" | "mcp_servers";
  format: "json" | "toml";
}

function mcpEntryContainers(
  host: McpHost,
  scopeDir: string,
  kind: ReaderScopeKind = "workspace",
): McpEntryContainer[] {
  const spec = harnessForMcpHost(host);
  if (spec?.projectMcpPath === undefined) return [];
  if (host === "codex") {
    return [
      { target: join(scopeDir, ".codex", "config.toml"), key: "mcp_servers", format: "toml" },
    ];
  }
  if (host === "claude") {
    return [
      {
        target: join(scopeDir, kind === "global" ? ".claude.json" : ".mcp.json"),
        key: "mcpServers",
        format: "json",
      },
      // La ubicación HISTÓRICA va segunda, y ese orden ES la precedencia:
      // `readClaudeMcpEntry` desestructura `[current, historical]`. No hay un
      // campo que la declare, porque un campo declarativo que nadie lee es una
      // promesa falsa — quien agregue un tercer contenedor lo marcaría creyendo
      // que cambia el orden, y no cambiaría nada.
      { target: join(scopeDir, ".claude", "settings.json"), key: "mcpServers", format: "json" },
    ];
  }
  if (host === "opencode" || host === "crush") {
    return [{ target: mcpKeyTarget(host, scopeDir, kind), key: "mcp", format: "json" }];
  }
  if (host === "warp" && kind === "global") {
    const globalPath = resolveWarpGlobalMcpPath(process.platform, () => scopeDir);
    if (globalPath !== null) return [{ target: globalPath, key: "mcpServers", format: "json" }];
  }
  return [
    {
      target: join(scopeDir, ...spec.projectMcpPath.split("/")),
      key: "mcpServers",
      format: "json",
    },
  ];
}

export function readMcpEntry(
  host: McpHost,
  scopeDir: string,
  name: string,
  kind: ReaderScopeKind = "workspace",
): McpEntrySnapshot {
  const containers = mcpEntryContainers(host, scopeDir, kind);
  const first = containers[0];
  if (first === undefined) return missingSnapshot(host, scopeDir, name);
  if (host === "claude") return readClaudeMcpEntry(containers, name);
  return readContainer(host, first, name);
}

function readContainer(
  host: McpHost,
  container: McpEntryContainer,
  name: string,
): McpEntrySnapshot {
  if (container.format === "toml") {
    return readTomlMcpEntry(host, container.target, name, container.key);
  }
  if (container.key === "mcp") {
    return readMcpKeyEntry(host as "opencode" | "crush", container.target, name);
  }
  return readJsonMcpEntry(host, container.target, name);
}

// Claude historically accepted the same mcpServers object under
// `.claude/settings.json`. Prefer the current `.mcp.json` / `.claude.json`
// location, but surface an occupied historical location rather than hiding it
// as absent: migration may only replace an exact known Workline shape.
function readClaudeMcpEntry(
  containers: readonly McpEntryContainer[],
  name: string,
): McpEntrySnapshot {
  const [current, historical] = containers;
  if (current === undefined) throw new Error("claude siempre declara su ubicación vigente");
  const primary = readJsonMcpEntry("claude", current.target, name);
  if (historical === undefined) return primary;
  const legacy = readJsonMcpEntry("claude", historical.target, name);
  if (primary.exists || primary.present) {
    return legacy.exists || legacy.present ? { ...primary, secondary: legacy } : primary;
  }
  return legacy.exists || legacy.present ? { ...legacy, legacy_location: true } : primary;
}

/**
 * What a host holds in this scope: the names it declares AND the files that
 * could not be decoded.
 *
 * The second half is not a detail. A file that does not parse declares NOTHING
 * this reader can enumerate, so a caller that only saw the names cannot tell
 * "this host has no entries" from "this host's configuration is unreadable" —
 * and answering "checked, nothing found" for the second is a coverage claim over
 * bytes nobody managed to look at.
 */
export interface McpEntryScan {
  /**
   * Deduplicated and sorted: a name present in both the current and the
   * historical Claude location is ONE resource with two homes, and reporting it
   * twice would make the same server look like two.
   */
  names: string[];
  /** Containers that exist and did not decode. Nothing inside them was read. */
  unreadable: string[];
}

export function scanMcpEntries(
  host: McpHost,
  scopeDir: string,
  kind: ReaderScopeKind = "workspace",
): McpEntryScan {
  const names = new Set<string>();
  const unreadable: string[] = [];
  for (const container of mcpEntryContainers(host, scopeDir, kind)) {
    const scanned = containerNames(container);
    if (scanned === null) {
      unreadable.push(container.target);
      continue;
    }
    for (const name of scanned) names.add(name);
  }
  return { names: [...names].sort((left, right) => left.localeCompare(right)), unreadable };
}

// Same preamble as `loadEntryObject`, stopping one level earlier: the keys of
// the servers map instead of one value inside it. `null` — not an empty list —
// for a file that cannot be parsed: guessing names out of broken bytes would
// invent resources, and reporting none would claim the file said none.
function containerNames(container: McpEntryContainer): string[] | null {
  if (!existsSync(container.target)) return [];
  const text = readFileSync(container.target, "utf-8");
  if (text.trim().length === 0) return [];
  let data: unknown;
  try {
    data = container.format === "toml" ? parseToml(text) : JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const servers = data[container.key];
  if (servers === undefined) return [];
  return isRecord(servers) ? Object.keys(servers) : null;
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

/**
 * Whether the entry declares a server the host REACHES instead of spawning.
 *
 * The test is the reachable address, not the transport name: Claude and Crush
 * write `{type:"http"|"sse", url}`, Codex's TOML writes a bare `url`, and a
 * table of accepted type names would call every future spelling malformed.
 * There is no command because a remote server needs none — judging it by the
 * stdio question is how a legitimate remote entry (the COMMON case: the captured
 * `claude mcp list` of this very batch shows three of them connected) came back
 * as "does not have the shape of a decodable MCP server".
 */
function isRemoteEntry(e: Record<string, unknown>): boolean {
  return e.command === undefined && typeof e.url === "string" && e.url.length > 0;
}

// Standard Claude-shaped snapshot: command/args/env fields on the entry, or the
// url of a server the host connects to over the network.
function stdSnapshot(
  host: McpHost,
  target: string,
  name: string,
  e: Record<string, unknown>,
): McpEntrySnapshot {
  const command = typeof e.command === "string" ? e.command : undefined;
  const args = stringArray(e.args);
  const env = e.env === undefined ? undefined : stringRecord(e.env);
  const remote = isRemoteEntry(e);
  const envBroken = e.env !== undefined && env === undefined;
  // ABSENT and MALFORMED are different answers, and `stringArray` collapses
  // them: it returns `undefined` both for a missing `args` and for one whose
  // items are not strings. `args` is OPTIONAL in every host's config —
  // `{"command":"npx"}` is a perfectly valid stdio server — so demanding it
  // reported a legitimate entry as broken. Only a PRESENT `args` of the wrong
  // shape is a defect.
  const argsBroken = e.args !== undefined && args === undefined;
  const malformed = remote
    ? // A remote entry carries no command and no args, so demanding them would
      // report the normal shape as broken; only a bad `env` remains a defect.
      envBroken
    : command === undefined || argsBroken || envBroken;

  return {
    host,
    target,
    name,
    exists: true,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(env === undefined ? {} : { env }),
    ...(remote ? { remote: true as const } : {}),
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
  // OpenCode spells the same distinction with `{type:"remote", url}`: no command
  // array at all, and that is a complete entry rather than a broken one.
  const remote = isRemoteEntry(entry);
  const envBroken = entry.environment !== undefined && env === undefined;
  const malformed = remote ? envBroken : command === undefined || command.length === 0 || envBroken;
  return {
    host,
    target,
    name,
    exists: true,
    ...(command === undefined || command.length === 0 ? {} : { command: command[0] }),
    ...(command === undefined ? {} : { args: command.slice(1) }),
    ...(env === undefined ? {} : { env }),
    ...(remote ? { remote: true as const } : {}),
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
