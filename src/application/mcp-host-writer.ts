import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import type {
  McpEntry,
  McpHost,
  McpWriteAction,
  McpWriteOpts,
  McpWriteResult,
} from "../domain/mcp-entry.js";

export interface ScopeInput {
  scopeDir: string;
}

export class McpWriterError extends Error {
  constructor(
    message: string,
    public readonly target: string,
    public override readonly cause?: string,
  ) {
    super(message);
    this.name = "McpWriterError";
  }
}

export function writeMcpEntry(
  host: McpHost,
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts = {},
): McpWriteResult {
  if (host === "claude") return writeClaudeMcpEntry(entry, scope, opts);
  return writeCodexMcpEntry(entry, scope, opts);
}

export function removeMcpEntry(
  host: McpHost,
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts = {},
): McpWriteResult {
  if (host === "claude") return removeClaudeMcpEntry(entry, scope, opts);
  return removeCodexMcpEntry(entry, scope, opts);
}

function writeClaudeMcpEntry(
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  const settingsFile = join(scope.scopeDir, ".claude", "settings.json");
  const data = readClaudeSettings(settingsFile);
  const mcpServers = ensureRecord(data, "mcpServers");
  const existing = mcpServers[entry.name];
  const expected = expectedClaudeShape(entry);

  if (deepEqual(existing, expected)) {
    return resultSkipped("claude", settingsFile, entry.name);
  }

  mcpServers[entry.name] = expected;
  data.mcpServers = mcpServers;

  const newJson = `${JSON.stringify(data, null, 2)}\n`;
  const oldJson = existsSync(settingsFile) ? readFileSync(settingsFile, "utf-8") : "";
  if (newJson === oldJson) {
    return resultSkipped("claude", settingsFile, entry.name);
  }

  if (opts.dryRun) {
    return resultDryRun("claude", settingsFile, entry.name, [
      `mcpServers.${entry.name}: ${existing ? "update" : "add"}`,
    ]);
  }

  mkdirSync(dirname(settingsFile), { recursive: true });
  const backup = backupFile(settingsFile);
  writeFileSync(settingsFile, newJson, "utf-8");
  return resultWritten("claude", settingsFile, entry.name, backup);
}

function writeCodexMcpEntry(
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  const configFile = join(scope.scopeDir, ".codex", "config.toml");
  const oldContent = existsSync(configFile) ? readFileSync(configFile, "utf-8") : "";

  let parsed: Record<string, unknown>;
  try {
    parsed = oldContent.length > 0 ? (parseToml(oldContent) as Record<string, unknown>) : {};
  } catch (err) {
    throw new McpWriterError(
      `config.toml inválido en ${configFile}`,
      configFile,
      (err as Error).message,
    );
  }

  const mcpServers = (parsed.mcp_servers ?? {}) as Record<string, unknown>;
  const existing = mcpServers[entry.name];
  const expected = expectedCodexShape(entry);

  if (deepEqual(existing, expected)) {
    return resultSkipped("codex", configFile, entry.name);
  }

  const cleaned = removeCodexMcpBlocks(oldContent, entry.name);
  const newContent = appendCodexMcpBlocks(cleaned, entry);

  if (newContent === oldContent) {
    return resultSkipped("codex", configFile, entry.name);
  }

  if (opts.dryRun) {
    return resultDryRun("codex", configFile, entry.name, [
      `[mcp_servers.${entry.name}]: ${existing ? "update" : "add"}`,
      `[mcp_servers.${entry.name}.env]: ${existing ? "update" : "add"}`,
    ]);
  }

  mkdirSync(dirname(configFile), { recursive: true });
  const backup = backupFile(configFile);
  writeFileSync(configFile, newContent, "utf-8");
  return resultWritten("codex", configFile, entry.name, backup);
}

function removeClaudeMcpEntry(
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  const settingsFile = join(scope.scopeDir, ".claude", "settings.json");
  const data = readClaudeSettings(settingsFile);
  const mcpServers = ensureRecord(data, "mcpServers");
  const existing = mcpServers[entry.name];
  if (existing === undefined) {
    return resultSkipped("claude", settingsFile, entry.name);
  }

  delete mcpServers[entry.name];
  data.mcpServers = mcpServers;

  const newJson = `${JSON.stringify(data, null, 2)}\n`;
  if (opts.dryRun) {
    return resultDryRun("claude", settingsFile, entry.name, [`mcpServers.${entry.name}: remove`]);
  }

  mkdirSync(dirname(settingsFile), { recursive: true });
  const backup = backupFile(settingsFile);
  writeFileSync(settingsFile, newJson, "utf-8");
  return resultRemoved("claude", settingsFile, entry.name, backup);
}

function removeCodexMcpEntry(
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  const configFile = join(scope.scopeDir, ".codex", "config.toml");
  const oldContent = existsSync(configFile) ? readFileSync(configFile, "utf-8") : "";
  if (oldContent.length > 0) {
    try {
      parseToml(oldContent);
    } catch (err) {
      throw new McpWriterError(
        `config.toml inválido en ${configFile}`,
        configFile,
        (err as Error).message,
      );
    }
  }

  const newContent = removeCodexMcpBlocks(oldContent, entry.name);
  if (newContent === oldContent) {
    return resultSkipped("codex", configFile, entry.name);
  }

  if (opts.dryRun) {
    return resultDryRun("codex", configFile, entry.name, [
      `[mcp_servers.${entry.name}]: remove`,
      `[mcp_servers.${entry.name}.env]: remove`,
    ]);
  }

  mkdirSync(dirname(configFile), { recursive: true });
  const backup = backupFile(configFile);
  writeFileSync(configFile, newContent, "utf-8");
  return resultRemoved("codex", configFile, entry.name, backup);
}

function readClaudeSettings(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf-8");
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("settings.json no es un objeto JSON");
  } catch (err) {
    throw new McpWriterError(`settings.json inválido en ${file}`, file, (err as Error).message);
  }
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const fresh: Record<string, unknown> = {};
  parent[key] = fresh;
  return fresh;
}

function expectedClaudeShape(entry: McpEntry): Record<string, unknown> {
  return {
    command: entry.command,
    args: [...entry.args],
    env: { ...entry.env },
  };
}

function expectedCodexShape(entry: McpEntry): Record<string, unknown> {
  return {
    command: entry.command,
    args: [...entry.args],
    env: { ...entry.env },
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return JSON.stringify(v ?? null);
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function backupFile(path: string): string | null {
  if (!existsSync(path)) return null;
  const ts = Math.floor(Date.now() / 1000);
  const backupPath = `${path}.bak.${ts}`;
  copyFileSync(path, backupPath);
  return backupPath;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function removeCodexMcpBlocks(text: string, name: string): string {
  let out = text;
  for (const header of [`[mcp_servers.${name}.env]`, `[mcp_servers.${name}]`]) {
    out = removeBlock(out, header);
  }
  return out.replace(/\n{3,}/g, "\n\n");
}

function removeBlock(text: string, sectionHeader: string): string {
  const re = new RegExp(`^${escapeRegex(sectionHeader)}[ \\t]*$`, "m");
  const match = re.exec(text);
  if (!match || match.index === undefined) return text;
  const start = match.index;
  const headerEnd = start + match[0].length;
  const after = text.slice(headerEnd);
  const nextRe = /\n\[/;
  const nextMatch = nextRe.exec(after);
  const end = nextMatch ? headerEnd + (nextMatch.index ?? 0) + 1 : text.length;
  return text.slice(0, start) + text.slice(end);
}

export function appendCodexMcpBlocks(text: string, entry: McpEntry): string {
  const buffer: string[] = [];
  let prefix = text;
  if (prefix.length > 0 && !prefix.endsWith("\n")) prefix += "\n";
  if (prefix.length > 0 && !prefix.endsWith("\n\n")) prefix += "\n";
  buffer.push(`[mcp_servers.${entry.name}]`);
  buffer.push(`command = ${tomlString(entry.command)}`);
  buffer.push(`args = [${entry.args.map(tomlString).join(", ")}]`);
  buffer.push("");
  buffer.push(`[mcp_servers.${entry.name}.env]`);
  for (const [k, v] of Object.entries(entry.env)) {
    buffer.push(`${k} = ${tomlString(v)}`);
  }
  buffer.push("");
  return prefix + buffer.join("\n");
}

function tomlString(value: string): string {
  // TOML basic strings share JSON escaping conventions for ASCII with \n/\t/\"/\\.
  return JSON.stringify(value);
}

function resultWritten(
  host: McpHost,
  target: string,
  name: string,
  backup: string | null,
): McpWriteResult {
  return action(host, target, name, "written", backup);
}

function resultRemoved(
  host: McpHost,
  target: string,
  name: string,
  backup: string | null,
): McpWriteResult {
  return action(host, target, name, "removed", backup);
}

function resultSkipped(host: McpHost, target: string, name: string): McpWriteResult {
  return action(host, target, name, "skipped-idempotent", null);
}

function resultDryRun(host: McpHost, target: string, name: string, diff: string[]): McpWriteResult {
  return { ...action(host, target, name, "dry-run", null), diff };
}

function action(
  host: McpHost,
  target: string,
  name: string,
  status: McpWriteAction,
  backup: string | null,
): McpWriteResult {
  return { host, target, name, action: status, backup };
}
