import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
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
  if (host === "claude") return readClaudeMcpEntry(scopeDir, name, kind);
  return readCodexMcpEntry(scopeDir, name);
}

function readClaudeMcpEntry(
  scopeDir: string,
  name: string,
  kind: ReaderScopeKind,
): McpEntrySnapshot {
  const target = kind === "global" ? join(scopeDir, ".claude.json") : join(scopeDir, ".mcp.json");
  if (!existsSync(target)) {
    return { host: "claude", target, name, exists: false };
  }
  const text = readFileSync(target, "utf-8");
  if (text.trim().length === 0) {
    return { host: "claude", target, name, exists: false };
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    return { host: "claude", target, name, exists: false };
  }
  const mcpServers = (data.mcpServers ?? {}) as Record<string, unknown>;
  const entry = mcpServers[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { host: "claude", target, name, exists: false };
  }
  const e = entry as Record<string, unknown>;
  return {
    host: "claude",
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

function readCodexMcpEntry(scopeDir: string, name: string): McpEntrySnapshot {
  const target = join(scopeDir, ".codex", "config.toml");
  if (!existsSync(target)) {
    return { host: "codex", target, name, exists: false };
  }
  const text = readFileSync(target, "utf-8");
  if (text.trim().length === 0) {
    return { host: "codex", target, name, exists: false };
  }
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch {
    return { host: "codex", target, name, exists: false };
  }
  const mcpServers = (data.mcp_servers ?? {}) as Record<string, unknown>;
  const entry = mcpServers[name];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { host: "codex", target, name, exists: false };
  }
  const e = entry as Record<string, unknown>;
  return {
    host: "codex",
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
