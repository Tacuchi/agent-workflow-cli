import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { harnessForMcpHost } from "../domain/harnesses.js";
import type { McpHost } from "../domain/mcp-entry.js";

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
  // with host-specific shapes — this mirrors the writer (mcp-host-writer.ts). File is
  // the XDG path (~/.config/<host>/<host>.json) for global scope, or <host>.json at the
  // project root for workspace scope.
  if (host === "opencode" || host === "crush") {
    const target =
      kind === "global"
        ? join(scopeDir, ".config", host, `${host}.json`)
        : join(scopeDir, `${host}.json`);
    return readMcpKeyEntry(host, target, name);
  }

  // JSON readers keyed by `mcpServers` (Claude shape): claude uses .mcp.json (workspace)
  // or .claude.json (global); warp uses .warp/.mcp.json; gemini uses .gemini/settings.json.
  const target =
    host === "claude" && kind === "global"
      ? join(scopeDir, ".claude.json")
      : join(scopeDir, ...projectPath.split("/"));
  return readJsonMcpEntry(host, target, name);
}

function readJsonMcpEntry(host: McpHost, target: string, name: string): McpEntrySnapshot {
  if (!existsSync(target)) return { host, target, name, exists: false };
  const text = readFileSync(target, "utf-8");
  if (text.trim().length === 0) return { host, target, name, exists: false };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    return { host, target, name, exists: false };
  }
  const mcpServers = (data.mcpServers ?? {}) as Record<string, unknown>;
  const entry = mcpServers[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { host, target, name, exists: false };
  }
  const e = entry as Record<string, unknown>;
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

// Reader for hosts that store the MCP entry under the top-level `mcp` key.
// OpenCode: { type:"local", command:[cmd, ...args], environment }. The dbhub
// command is the first array element and args are the rest; env lives under
// `environment`. Crush: { type:"stdio", command, args, env } (Claude-like fields).
function readMcpKeyEntry(host: McpHost, target: string, name: string): McpEntrySnapshot {
  if (!existsSync(target)) return { host, target, name, exists: false };
  const text = readFileSync(target, "utf-8");
  if (text.trim().length === 0) return { host, target, name, exists: false };
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    return { host, target, name, exists: false };
  }
  const mcp = (data.mcp ?? {}) as Record<string, unknown>;
  const entry = mcp[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { host, target, name, exists: false };
  }
  const e = entry as Record<string, unknown>;

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

function readTomlMcpEntry(
  host: McpHost,
  target: string,
  name: string,
  serversKey: string,
): McpEntrySnapshot {
  if (!existsSync(target)) return { host, target, name, exists: false };
  const text = readFileSync(target, "utf-8");
  if (text.trim().length === 0) return { host, target, name, exists: false };
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch {
    return { host, target, name, exists: false };
  }
  const mcpServers = (data[serversKey] ?? {}) as Record<string, unknown>;
  const entry = mcpServers[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { host, target, name, exists: false };
  }
  const e = entry as Record<string, unknown>;
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

function toStringRecord(obj: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
