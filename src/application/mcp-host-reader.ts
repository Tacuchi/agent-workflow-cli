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
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  raw?: unknown;
}

export function readMcpEntry(
  host: McpHost,
  scopeDir: string,
  name: string,
  kind: ReaderScopeKind = "workspace",
): McpEntrySnapshot {
  const spec = harnessForMcpHost(host);
  if (!spec) return { host, target: scopeDir, name, exists: false };

  const projectPath = spec.projectMcpPath;
  if (!projectPath) return { host, target: scopeDir, name, exists: false };

  // Codex uses TOML with the mcp_servers key.
  if (host === "codex") {
    const target = join(scopeDir, ".codex", "config.toml");
    return readTomlMcpEntry(host, target, name, "mcp_servers");
  }

  // OpenCode & Crush store the entry under the top-level `mcp` key (NOT `mcpServers`)
  // with host-specific shapes — this mirrors the writer (mcp-host-writer.ts). Global
  // scope resolves via mcp-host-paths.ts (XDG_CONFIG_HOME; crush win32 = LOCALAPPDATA),
  // workspace scope is <host>.json at the project root.
  if (host === "opencode" || host === "crush") {
    const target =
      kind === "global"
        ? host === "opencode"
          ? opencodeGlobalMcpFile(scopeDir)
          : crushGlobalMcpFile(scopeDir)
        : join(scopeDir, `${host}.json`);
    return readMcpKeyEntry(host, target, name);
  }

  // JSON readers keyed by `mcpServers` (Claude shape): claude uses .mcp.json (workspace)
  // or .claude.json (global); warp uses .warp/.mcp.json (workspace) or the per-platform
  // global registry path (mirrors the writer — DEC-W3); gemini uses .gemini/settings.json.
  if (host === "warp" && kind === "global") {
    const globalPath = resolveWarpGlobalMcpPath(process.platform, () => scopeDir);
    if (globalPath) return readJsonMcpEntry(host, globalPath, name);
  }
  const target =
    host === "claude" && kind === "global"
      ? join(scopeDir, ".claude.json")
      : join(scopeDir, ...projectPath.split("/"));
  return readJsonMcpEntry(host, target, name);
}

// Shared preamble: exists check → read → empty check → try-parse → key extract →
// entry validate. Returns the entry record, or null for every not-found/invalid case.
function loadEntryObject(
  target: string,
  parse: (text: string) => unknown,
  key: string,
  name: string,
): Record<string, unknown> | null {
  if (!existsSync(target)) return null;
  const text = readFileSync(target, "utf-8");
  if (text.trim().length === 0) return null;
  let data: Record<string, unknown>;
  try {
    data = parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const servers = (data[key] ?? {}) as Record<string, unknown>;
  const entry = servers[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  return entry as Record<string, unknown>;
}

// Standard Claude-shaped snapshot: command/args/env fields on the entry.
function stdSnapshot(
  host: McpHost,
  target: string,
  name: string,
  e: Record<string, unknown>,
): McpEntrySnapshot {
  return {
    host,
    target,
    name,
    exists: true,
    ...(typeof e.command === "string" ? { command: e.command } : {}),
    ...(Array.isArray(e.args)
      ? { args: (e.args as unknown[]).filter((x): x is string => typeof x === "string") }
      : {}),
    ...(typeof e.env === "object" && e.env !== null ? { env: toStringRecord(e.env) } : {}),
    raw: e,
  };
}

function readJsonMcpEntry(host: McpHost, target: string, name: string): McpEntrySnapshot {
  const e = loadEntryObject(target, JSON.parse, "mcpServers", name);
  if (!e) return { host, target, name, exists: false };
  return stdSnapshot(host, target, name, e);
}

// Reader for hosts that store the MCP entry under the top-level `mcp` key.
// OpenCode: { type:"local", command:[cmd, ...args], environment }. The dbhub
// command is the first array element and args are the rest; env lives under
// `environment`. Crush: { type:"stdio", command, args, env } (Claude-like fields).
function readMcpKeyEntry(host: McpHost, target: string, name: string): McpEntrySnapshot {
  const e = loadEntryObject(target, JSON.parse, "mcp", name);
  if (!e) return { host, target, name, exists: false };

  if (host === "opencode") {
    const cmd = Array.isArray(e.command)
      ? (e.command as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    return {
      host,
      target,
      name,
      exists: true,
      ...(cmd.length > 0 ? { command: cmd[0] } : {}),
      args: cmd.slice(1),
      ...(typeof e.environment === "object" && e.environment !== null
        ? { env: toStringRecord(e.environment) }
        : {}),
      raw: e,
    };
  }

  // crush: standard command/args/env fields under the `mcp` key.
  return stdSnapshot(host, target, name, e);
}

function readTomlMcpEntry(
  host: McpHost,
  target: string,
  name: string,
  serversKey: string,
): McpEntrySnapshot {
  const e = loadEntryObject(target, parseToml, serversKey, name);
  if (!e) return { host, target, name, exists: false };
  return stdSnapshot(host, target, name, e);
}

function toStringRecord(obj: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
