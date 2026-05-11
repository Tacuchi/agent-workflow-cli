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

  // Codex uses TOML with mcp_servers key; all others (claude, warp) use JSON with mcpServers key
  if (host === "codex") {
    const target = join(scopeDir, ".codex", "config.toml");
    return readTomlMcpEntry(host, target, name, "mcp_servers");
  }

  // JSON readers: claude uses .mcp.json (workspace) or .claude.json (global); warp uses .warp/.mcp.json
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
