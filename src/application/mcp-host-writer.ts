import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  type McpEntry,
  type McpHost,
  type McpWriteAction,
  type McpWriteOpts,
  type McpWriteResult,
  isDbhubManagedEntry,
} from "../domain/mcp-entry.js";
import { crushGlobalMcpFile, opencodeGlobalMcpFile } from "./mcp-host-paths.js";
import { backupFile, escapeRegex, purgeStaleBackups } from "./multiroot/paths.js";
import { resolveWarpGlobalMcpPath, resolveWarpProjectMcpPath } from "./multiroot/warp.js";

export interface ScopeInput {
  scopeDir: string;
  kind?: "workspace" | "global";
}

// Atomic replace: stage to a tmp sibling and rename over the target. At global
// scope the targets are live user files (~/.claude.json is rewritten by any
// running Claude Code session); rename keeps a concurrent reader from seeing a
// truncated/half-written file. Lost-update between two writers remains possible
// (would need locking) — accepted residual risk.
let atomicWriteCounter = 0;
function atomicWriteFileSync(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${++atomicWriteCounter}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may not exist if writeFileSync failed before creating it
    }
    throw err;
  }
}

function claudeMcpFile(scope: ScopeInput): string {
  return scope.kind === "global"
    ? join(scope.scopeDir, ".claude.json")
    : join(scope.scopeDir, ".mcp.json");
}

function legacyClaudeSettingsFile(scope: ScopeInput): string {
  return join(scope.scopeDir, ".claude", "settings.json");
}

function cleanupLegacyClaudeMcpEntry(scope: ScopeInput, name: string, dryRun: boolean): void {
  if (dryRun) return;
  const legacy = legacyClaudeSettingsFile(scope);
  if (!existsSync(legacy)) return;
  let data: Record<string, unknown>;
  try {
    const text = readFileSync(legacy, "utf-8");
    if (text.trim().length === 0) return;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    data = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const mcpServers = data.mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return;
  const servers = mcpServers as Record<string, unknown>;
  if (!(name in servers)) return;
  // Ownership guard: at global scope this file is the user's real
  // ~/.claude/settings.json — a same-named entry the tool never wrote stays.
  const existing = servers[name];
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return;
  if (!isDbhubManagedEntry(existing as { command?: unknown; args?: unknown })) return;
  servers[name] = undefined;
  const remaining = Object.fromEntries(Object.entries(servers).filter(([, v]) => v !== undefined));
  if (Object.keys(remaining).length === 0) {
    data.mcpServers = undefined;
  } else {
    data.mcpServers = remaining;
  }
  purgeStaleBackups(legacy);
  const legacyBackup = backupFile(legacy);
  atomicWriteFileSync(legacy, `${JSON.stringify(data, null, 2)}\n`);
  discardBackup(legacyBackup);
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
  if (host === "warp") return writeWarpMcpEntry(entry, scope, opts);
  if (host === "codex") return writeCodexMcpEntry(entry, scope, opts);
  if (host === "gemini")
    return writeJsonMcpEntry("gemini", geminiMcpFile(scope), "mcpServers", entry, opts);
  if (host === "opencode")
    return writeJsonMcpEntry("opencode", opencodeMcpFile(scope), "mcp", entry, opts);
  return writeJsonMcpEntry("crush", crushMcpFile(scope), "mcp", entry, opts);
}

export function removeMcpEntry(
  host: McpHost,
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts = {},
): McpWriteResult {
  if (host === "claude") return removeClaudeMcpEntry(entry, scope, opts);
  if (host === "warp") return removeWarpMcpEntry(entry, scope, opts);
  if (host === "codex") return removeCodexMcpEntry(entry, scope, opts);
  if (host === "gemini")
    return removeJsonMcpEntry("gemini", geminiMcpFile(scope), "mcpServers", entry, opts);
  if (host === "opencode")
    return removeJsonMcpEntry("opencode", opencodeMcpFile(scope), "mcp", entry, opts);
  return removeJsonMcpEntry("crush", crushMcpFile(scope), "mcp", entry, opts);
}

// --- New-host MCP file locations ---
// Global scope passes scopeDir = homedir(); OpenCode/Crush are XDG-based
// (~/.config/<name>/…), so global differs from the project-root file. Gemini's
// .gemini/settings.json is the same relative path for both scopes.
function geminiMcpFile(scope: ScopeInput): string {
  return join(scope.scopeDir, ".gemini", "settings.json");
}
function opencodeMcpFile(scope: ScopeInput): string {
  return scope.kind === "global"
    ? opencodeGlobalMcpFile(scope.scopeDir)
    : join(scope.scopeDir, "opencode.json");
}
function crushMcpFile(scope: ScopeInput): string {
  return scope.kind === "global"
    ? crushGlobalMcpFile(scope.scopeDir)
    : join(scope.scopeDir, "crush.json");
}

// Per-host serialization of a dbhub McpEntry into the host's JSON schema.
function mcpShapeFor(host: McpHost, entry: McpEntry): Record<string, unknown> {
  if (host === "opencode") {
    // OpenCode: { type: "local", command: [cmd, ...args], environment, enabled }
    return {
      type: "local",
      command: [entry.command, ...entry.args],
      environment: { ...entry.env },
      enabled: true,
    };
  }
  if (host === "crush") {
    // Crush: { type: "stdio", command, args, env }
    return {
      type: "stdio",
      command: entry.command,
      args: [...entry.args],
      env: { ...entry.env },
    };
  }
  // gemini (and any Claude-compatible host): { command, args, env }
  return expectedClaudeShape(entry);
}

// Generic writer for hosts whose MCP config is a JSON file with a top-level
// object keyed by server name (Gemini `mcpServers`, OpenCode/Crush `mcp`).
// Preserves other top-level keys and other server entries; idempotent; dry-run;
// transient backup purged on success.
function writeJsonMcpEntry(
  host: McpHost,
  file: string,
  topKey: string,
  entry: McpEntry,
  opts: McpWriteOpts,
): McpWriteResult {
  const data = readJsonFile(file);
  const bag = ensureRecord(data, topKey);
  const existing = bag[entry.name];
  const expected = mcpShapeFor(host, entry);

  if (deepEqual(existing, expected)) {
    return resultSkipped(host, file, entry.name);
  }

  bag[entry.name] = expected;
  data[topKey] = bag;
  const newJson = `${JSON.stringify(data, null, 2)}\n`;

  if (opts.dryRun) {
    return resultDryRun(host, file, entry.name, [
      `${topKey}.${entry.name}: ${existing ? "update" : "add"}`,
    ]);
  }

  mkdirSync(dirname(file), { recursive: true });
  purgeStaleBackups(file);
  const backup = backupFile(file);
  atomicWriteFileSync(file, newJson);
  discardBackup(backup);
  return resultWritten(host, file, entry.name, null);
}

function removeJsonMcpEntry(
  host: McpHost,
  file: string,
  topKey: string,
  entry: McpEntry,
  opts: McpWriteOpts,
): McpWriteResult {
  const data = readJsonFile(file);
  const bag = ensureRecord(data, topKey);
  const existing = bag[entry.name];
  if (existing === undefined) {
    return resultSkipped(host, file, entry.name);
  }

  bag[entry.name] = undefined;
  const remaining = Object.fromEntries(Object.entries(bag).filter(([, v]) => v !== undefined));
  data[topKey] = Object.keys(remaining).length === 0 ? undefined : remaining;
  const newJson = `${JSON.stringify(data, null, 2)}\n`;

  if (opts.dryRun) {
    return resultDryRun(host, file, entry.name, [`${topKey}.${entry.name}: remove`]);
  }

  mkdirSync(dirname(file), { recursive: true });
  purgeStaleBackups(file);
  const backup = backupFile(file);
  atomicWriteFileSync(file, newJson);
  discardBackup(backup);
  return resultRemoved(host, file, entry.name, null);
}

function writeClaudeMcpEntry(
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  const settingsFile = claudeMcpFile(scope);
  const data = readClaudeSettings(settingsFile);
  const mcpServers = ensureRecord(data, "mcpServers");
  const existing = mcpServers[entry.name];
  const expected = expectedClaudeShape(entry);

  if (deepEqual(existing, expected)) {
    cleanupLegacyClaudeMcpEntry(scope, entry.name, opts.dryRun ?? false);
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
  purgeStaleBackups(settingsFile);
  const backup = backupFile(settingsFile);
  atomicWriteFileSync(settingsFile, newJson);
  discardBackup(backup);
  cleanupLegacyClaudeMcpEntry(scope, entry.name, false);
  return resultWritten("claude", settingsFile, entry.name, null);
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
  purgeStaleBackups(configFile);
  const backup = backupFile(configFile);
  atomicWriteFileSync(configFile, newContent);
  discardBackup(backup);
  return resultWritten("codex", configFile, entry.name, null);
}

function removeClaudeMcpEntry(
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  const settingsFile = claudeMcpFile(scope);
  const data = readClaudeSettings(settingsFile);
  const mcpServers = ensureRecord(data, "mcpServers");
  const existing = mcpServers[entry.name];
  if (existing === undefined) {
    cleanupLegacyClaudeMcpEntry(scope, entry.name, opts.dryRun ?? false);
    return resultSkipped("claude", settingsFile, entry.name);
  }

  mcpServers[entry.name] = undefined;
  const remaining = Object.fromEntries(
    Object.entries(mcpServers).filter(([, v]) => v !== undefined),
  );
  if (Object.keys(remaining).length === 0) {
    data.mcpServers = undefined;
  } else {
    data.mcpServers = remaining;
  }

  const newJson = `${JSON.stringify(data, null, 2)}\n`;
  if (opts.dryRun) {
    return resultDryRun("claude", settingsFile, entry.name, [`mcpServers.${entry.name}: remove`]);
  }

  mkdirSync(dirname(settingsFile), { recursive: true });
  purgeStaleBackups(settingsFile);
  const backup = backupFile(settingsFile);
  atomicWriteFileSync(settingsFile, newJson);
  discardBackup(backup);
  cleanupLegacyClaudeMcpEntry(scope, entry.name, false);
  return resultRemoved("claude", settingsFile, entry.name, null);
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
  purgeStaleBackups(configFile);
  const backup = backupFile(configFile);
  atomicWriteFileSync(configFile, newContent);
  discardBackup(backup);
  return resultRemoved("codex", configFile, entry.name, null);
}

/**
 * Warp file by scope: workspace = <scopeDir>/.warp/.mcp.json; global = the
 * per-platform registry path (Linux/Windows difieren de ~/.warp — DEC-W3).
 * scopeDir actúa de homedir en global, así los tests inyectan un tmpdir.
 */
function warpMcpFile(scope: ScopeInput): string {
  if (scope.kind === "global") {
    const globalPath = resolveWarpGlobalMcpPath(process.platform, "stable", () => scope.scopeDir);
    if (globalPath) return globalPath;
  }
  return resolveWarpProjectMcpPath(scope.scopeDir);
}

function writeWarpMcpEntry(entry: McpEntry, scope: ScopeInput, opts: McpWriteOpts): McpWriteResult {
  const settingsFile = warpMcpFile(scope);
  const data = readJsonFile(settingsFile);
  const mcpServers = ensureRecord(data, "mcpServers");
  const existing = mcpServers[entry.name];
  const expected = expectedClaudeShape(entry);

  if (deepEqual(existing, expected)) {
    return resultSkipped("warp", settingsFile, entry.name);
  }

  mcpServers[entry.name] = expected;
  data.mcpServers = mcpServers;
  const newJson = `${JSON.stringify(data, null, 2)}\n`;

  if (opts.dryRun) {
    return resultDryRun("warp", settingsFile, entry.name, [
      `mcpServers.${entry.name}: ${existing ? "update" : "add"}`,
    ]);
  }

  mkdirSync(dirname(settingsFile), { recursive: true });
  purgeStaleBackups(settingsFile);
  const backup = backupFile(settingsFile);
  atomicWriteFileSync(settingsFile, newJson);
  discardBackup(backup);
  return resultWritten("warp", settingsFile, entry.name, null);
}

function removeWarpMcpEntry(
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  const settingsFile = warpMcpFile(scope);
  const data = readJsonFile(settingsFile);
  const mcpServers = ensureRecord(data, "mcpServers");
  const existing = mcpServers[entry.name];
  if (existing === undefined) {
    return resultSkipped("warp", settingsFile, entry.name);
  }

  mcpServers[entry.name] = undefined;
  const remaining = Object.fromEntries(
    Object.entries(mcpServers).filter(([, v]) => v !== undefined),
  );
  data.mcpServers = Object.keys(remaining).length === 0 ? undefined : remaining;
  const newJson = `${JSON.stringify(data, null, 2)}\n`;

  if (opts.dryRun) {
    return resultDryRun("warp", settingsFile, entry.name, [`mcpServers.${entry.name}: remove`]);
  }

  mkdirSync(dirname(settingsFile), { recursive: true });
  purgeStaleBackups(settingsFile);
  const backup = backupFile(settingsFile);
  atomicWriteFileSync(settingsFile, newJson);
  discardBackup(backup);
  return resultRemoved("warp", settingsFile, entry.name, null);
}

function readJsonFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf-8");
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("contenido no es un objeto JSON");
  } catch (err) {
    throw new McpWriterError(`JSON inválido en ${file}`, file, (err as Error).message);
  }
}

function readClaudeSettings(file: string): Record<string, unknown> {
  return readJsonFile(file);
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

// backupFile/purgeStaleBackups/escapeRegex live in multiroot/paths.ts (single
// backup mechanism for host-config files: keep-latest, purge-then-copy).

function discardBackup(backupPath: string | null): void {
  if (backupPath === null) return;
  try {
    if (existsSync(backupPath)) unlinkSync(backupPath);
  } catch {
    // best-effort: nunca bloquear el write OK por un cleanup fallido
  }
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
