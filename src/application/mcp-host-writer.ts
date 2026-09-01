import {
  closeSync,
  existsSync,
  fchmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import {
  type McpEntry,
  type McpHost,
  type McpWriteAction,
  type McpWriteOpts,
  type McpWriteResult,
  mcpEntryShapeForHost,
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
// truncated/half-written file. `withHostConfigLock` serializes Workline
// writers; an external host can still race, so every caller must read back.
const MAX_ATOMIC_TEMP_ATTEMPTS = 64;

function atomicWriteFileSync(path: string, content: string): void {
  let descriptor: number | undefined;
  let tmp: string | undefined;
  try {
    const staged = reserveAtomicTempFile(path);
    descriptor = staged.descriptor;
    tmp = staged.path;
    // The temporary file is exclusively created with 0600. Tighten it again
    // where POSIX permissions exist; Windows ACL filesystems can reject
    // fchmod, and that must not turn an otherwise safe atomic replacement
    // into a platform-specific setup failure.
    try {
      fchmodSync(descriptor, 0o600);
    } catch {
      // The exclusive create mode above remains the only portable guarantee.
    }
    writeFileSync(descriptor, content, "utf-8");
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tmp, path);
    tmp = undefined;
  } catch (err) {
    if (descriptor !== undefined) closeAtomicTempFile(descriptor);
    if (tmp !== undefined) discardAtomicTempFile(tmp);
    throw err;
  }
}

function reserveAtomicTempFile(path: string): { path: string; descriptor: number } {
  for (let attempt = 0; attempt < MAX_ATOMIC_TEMP_ATTEMPTS; attempt += 1) {
    const tmp = `${path}.${process.pid}.${attempt + 1}.tmp`;
    try {
      return { path: tmp, descriptor: openSync(tmp, "wx", 0o600) };
    } catch (error) {
      if (filesystemErrorCode(error) === "EEXIST") continue;
      throw error;
    }
  }
  throw new McpWriterError(
    "no se pudo reservar un archivo temporal seguro para la configuración MCP",
    path,
  );
}

function closeAtomicTempFile(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // The failed write is reported below; cleanup is best-effort.
  }
}

function discardAtomicTempFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Only an exclusively-created temp reaches this branch. It may already
    // have been removed by the filesystem after a failed write.
  }
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function claudeMcpFile(scope: ScopeInput): string {
  return scope.kind === "global"
    ? join(scope.scopeDir, ".claude.json")
    : join(scope.scopeDir, ".mcp.json");
}

function legacyClaudeSettingsFile(scope: ScopeInput): string {
  return join(scope.scopeDir, ".claude", "settings.json");
}

type LegacyClaudeEntryInspection =
  | { state: "absent"; target: string }
  | {
      state: "owned";
      target: string;
      data: Record<string, unknown>;
      servers: Record<string, unknown>;
    }
  | { state: "conflict"; target: string };

/**
 * The old Claude settings location is still live user configuration. A
 * same-named server there is ours only when it has the exact current generated
 * Claude shape. Invalid containers are also a conflict: writing a second
 * location while one cannot be safely interpreted would make the operation
 * partially mutate the user's configuration.
 */
function inspectLegacyClaudeMcpEntry(
  scope: ScopeInput,
  entry: McpEntry,
  replaceLegacy?: McpEntry,
): LegacyClaudeEntryInspection {
  const target = legacyClaudeSettingsFile(scope);
  if (!existsSync(target)) return { state: "absent", target };

  let data: Record<string, unknown>;
  try {
    const text = readFileSync(target, "utf-8");
    if (text.trim().length === 0) return { state: "absent", target };
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return { state: "conflict", target };
    data = parsed;
  } catch {
    return { state: "conflict", target };
  }

  const current = data.mcpServers;
  if (current === undefined) return { state: "absent", target };
  if (!isRecord(current)) return { state: "conflict", target };
  if (!(entry.name in current)) return { state: "absent", target };
  const expected = mcpEntryShapeForHost("claude", entry);
  const legacy =
    replaceLegacy === undefined ? undefined : mcpEntryShapeForHost("claude", replaceLegacy);
  if (
    !isDeepStrictEqual(current[entry.name], expected) &&
    !isDeepStrictEqual(current[entry.name], legacy)
  ) {
    return { state: "conflict", target };
  }
  return { state: "owned", target, data, servers: current };
}

function cleanupLegacyClaudeMcpEntry(
  scope: ScopeInput,
  entry: McpEntry,
  dryRun: boolean,
  replaceLegacy?: McpEntry,
): void {
  if (dryRun) return;
  const legacy = inspectLegacyClaudeMcpEntry(scope, entry, replaceLegacy);
  if (legacy.state !== "owned") return;
  legacy.servers[entry.name] = undefined;
  const remaining = Object.fromEntries(
    Object.entries(legacy.servers).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(remaining).length === 0) {
    legacy.data.mcpServers = undefined;
  } else {
    legacy.data.mcpServers = remaining;
  }
  purgeStaleBackups(legacy.target);
  const legacyBackup = backupFile(legacy.target);
  atomicWriteFileSync(legacy.target, `${JSON.stringify(legacy.data, null, 2)}\n`);
  discardBackup(legacyBackup);
}

export class McpWriterError extends Error {
  constructor(
    message: string,
    public readonly target: string,
  ) {
    super(message);
    this.name = "McpWriterError";
  }
}

/**
 * Both dispatchers are EXHAUSTIVE switches on purpose.
 *
 * They used to be if-chains ending in a bare `return …crush…`, so a host added
 * to `McpHost` without a branch here compiled cleanly and silently wrote its
 * entry into `crush.json` — the wrong file, no error, no warning. The
 * `assertNeverHost` default turns that into a compile error instead.
 */
export function writeMcpEntry(
  host: McpHost,
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts = {},
): McpWriteResult {
  if (opts.dryRun) return writeMcpEntryUnlocked(host, entry, scope, opts);
  return withHostConfigLock(hostConfigTarget(host, scope), () =>
    writeMcpEntryUnlocked(host, entry, scope, opts),
  );
}

export function removeMcpEntry(
  host: McpHost,
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts = {},
): McpWriteResult {
  if (opts.dryRun) return removeMcpEntryUnlocked(host, entry, scope, opts);
  return withHostConfigLock(hostConfigTarget(host, scope), () =>
    removeMcpEntryUnlocked(host, entry, scope, opts),
  );
}

function writeMcpEntryUnlocked(
  host: McpHost,
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  switch (host) {
    case "claude":
      return writeClaudeMcpEntry(entry, scope, opts);
    case "codex":
      return writeCodexMcpEntry(entry, scope, opts);
    case "warp":
      return writeJsonMcpEntry("warp", warpMcpFile(scope), "mcpServers", entry, opts);
    case "gemini":
      return writeJsonMcpEntry("gemini", geminiMcpFile(scope), "mcpServers", entry, opts);
    case "kimi":
      return writeJsonMcpEntry("kimi", kimiMcpFile(scope), "mcpServers", entry, opts);
    case "opencode":
      return writeJsonMcpEntry("opencode", opencodeMcpFile(scope), "mcp", entry, opts);
    case "crush":
      return writeJsonMcpEntry("crush", crushMcpFile(scope), "mcp", entry, opts);
    default:
      return assertNeverHost(host);
  }
}

function removeMcpEntryUnlocked(
  host: McpHost,
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  switch (host) {
    case "claude":
      return removeClaudeMcpEntry(entry, scope, opts);
    case "codex":
      return removeCodexMcpEntry(entry, scope, opts);
    case "warp":
      return removeJsonMcpEntry("warp", warpMcpFile(scope), "mcpServers", entry, opts);
    case "gemini":
      return removeJsonMcpEntry("gemini", geminiMcpFile(scope), "mcpServers", entry, opts);
    case "kimi":
      return removeJsonMcpEntry("kimi", kimiMcpFile(scope), "mcpServers", entry, opts);
    case "opencode":
      return removeJsonMcpEntry("opencode", opencodeMcpFile(scope), "mcp", entry, opts);
    case "crush":
      return removeJsonMcpEntry("crush", crushMcpFile(scope), "mcp", entry, opts);
    default:
      return assertNeverHost(host);
  }
}

function hostConfigTarget(host: McpHost, scope: ScopeInput): string {
  switch (host) {
    case "claude":
      return claudeMcpFile(scope);
    case "codex":
      return join(scope.scopeDir, ".codex", "config.toml");
    case "warp":
      return warpMcpFile(scope);
    case "gemini":
      return geminiMcpFile(scope);
    case "kimi":
      return kimiMcpFile(scope);
    case "opencode":
      return opencodeMcpFile(scope);
    case "crush":
      return crushMcpFile(scope);
    default:
      return assertNeverHost(host);
  }
}

/**
 * Serializes the whole read-modify-write window, not merely the final rename.
 * A competing writer fails explicitly instead of silently dropping one host
 * entry. A stale lock is intentionally not guessed away: removing it requires
 * an operator decision because it may belong to another live process.
 */
function withHostConfigLock<T>(target: string, work: () => T): T {
  const lock = `${target}.agent-workflow.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  let descriptor: number;
  try {
    descriptor = openSync(lock, "wx", 0o600);
  } catch (error) {
    if (filesystemErrorCode(error) === "EEXIST") {
      throw new McpWriterError(
        "otro proceso está actualizando esta configuración MCP; reintentá cuando termine",
        target,
      );
    }
    throw error;
  }
  try {
    return work();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // A remaining lock is safer than claiming a concurrent write succeeded.
      }
    }
  }
}

/** Compile-time exhaustiveness; at runtime it refuses instead of writing somewhere wrong. */
function assertNeverHost(host: never): never {
  const id = String(host);
  throw new McpWriterError(`no MCP writer wired for host '${id}'`, id);
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
// Kimi resolves the same relative path in both scopes: `<KIMI_CODE_HOME>/mcp.json`
// globally (scopeDir = home) and `<cwd>/.kimi-code/mcp.json` per project.
// Verified against v0.29.2's resolver. It ALSO reads the project-root
// Claude-compatible `.mcp.json`, which we deliberately do not write for it —
// that file belongs to Claude's target.
function kimiMcpFile(scope: ScopeInput): string {
  return join(scope.scopeDir, ".kimi-code", "mcp.json");
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
  const bag = recordContainer(data, topKey, file) ?? {};
  const existing = bag[entry.name];
  const expected = mcpEntryShapeForHost(host, entry);
  const legacy =
    opts.replaceLegacy === undefined ? undefined : mcpEntryShapeForHost(host, opts.replaceLegacy);

  if (isDeepStrictEqual(existing, expected)) {
    return resultSkipped(host, file, entry.name);
  }
  // A matching name is not enough to establish ownership. Replacing a server
  // whose shape differs would overwrite somebody else's configuration.
  if (existing !== undefined && !isDeepStrictEqual(existing, legacy)) {
    return resultConflict(host, file, entry.name);
  }

  bag[entry.name] = expected;
  data[topKey] = bag;
  const newJson = `${JSON.stringify(data, null, 2)}\n`;

  if (opts.dryRun) {
    return resultDryRun(host, file, entry.name, [
      `${topKey}.${entry.name}: ${existing === undefined ? "add" : "replace known legacy"}`,
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
  const bag = recordContainer(data, topKey, file);
  if (bag === undefined) return resultSkipped(host, file, entry.name);
  const existing = bag[entry.name];
  const expected = mcpEntryShapeForHost(host, entry);
  const legacy =
    opts.replaceLegacy === undefined ? undefined : mcpEntryShapeForHost(host, opts.replaceLegacy);
  if (existing === undefined) {
    return resultSkipped(host, file, entry.name);
  }
  if (!isDeepStrictEqual(existing, expected) && !isDeepStrictEqual(existing, legacy)) {
    return resultConflict(host, file, entry.name);
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

// Claude = the generic JSON writer plus an ownership-checked legacy
// .claude/settings.json sweep. A foreign or malformed legacy entry stops before
// the primary file changes; an exact own entry is swept on a real write/remove.
function writeClaudeMcpEntry(
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  const legacy = inspectLegacyClaudeMcpEntry(scope, entry, opts.replaceLegacy);
  if (legacy.state === "conflict") return resultConflict("claude", legacy.target, entry.name);
  const res = writeJsonMcpEntry("claude", claudeMcpFile(scope), "mcpServers", entry, opts);
  // The canonical entry may already be present while the old location still
  // needs a cleanup. That is still an observable write: report it as such so
  // a caller's dry-run and first-mutation guard do not mistake it for a noop.
  if (legacy.state === "owned" && res.action === "skipped-idempotent") {
    if (opts.dryRun)
      return resultDryRun("claude", legacy.target, entry.name, [
        `mcpServers.${entry.name}: remove legacy entry`,
      ]);
    try {
      cleanupLegacyClaudeMcpEntry(scope, entry, false, opts.replaceLegacy);
      return resultWritten("claude", legacy.target, entry.name, null);
    } catch {
      return partialLegacyCleanup(res, legacy.target);
    }
  }
  if (legacy.state === "owned" && res.action === "written") {
    try {
      cleanupLegacyClaudeMcpEntry(scope, entry, false, opts.replaceLegacy);
    } catch {
      // The primary descriptor is already durable. Do not hide that mutation
      // or roll it back blindly: the old location might have been changed by a
      // host meanwhile. The caller will fail readback, withhold the receipt,
      // and a later explicit setup/migration can retry exact cleanup.
      return partialLegacyCleanup(res, legacy.target);
    }
  }
  return res;
}

function writeCodexMcpEntry(
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  const configFile = join(scope.scopeDir, ".codex", "config.toml");
  const oldContent = existsSync(configFile) ? readFileSync(configFile, "utf-8") : "";
  const parsed = parseCodexConfig(oldContent, configFile);
  const mcpServers = recordContainer(parsed, "mcp_servers", configFile) ?? {};
  const existing = mcpServers[entry.name];
  const expected = mcpEntryShapeForHost("codex", entry);
  const legacy =
    opts.replaceLegacy === undefined
      ? undefined
      : mcpEntryShapeForHost("codex", opts.replaceLegacy);

  if (isDeepStrictEqual(existing, expected)) {
    return resultSkipped("codex", configFile, entry.name);
  }
  if (existing !== undefined && !isDeepStrictEqual(existing, legacy)) {
    return resultConflict("codex", configFile, entry.name);
  }

  const cleaned = removeCodexMcpBlocks(oldContent, entry.name);
  const newContent = appendCodexMcpBlocks(cleaned, entry);

  if (newContent === oldContent) {
    return resultSkipped("codex", configFile, entry.name);
  }

  if (opts.dryRun) {
    return resultDryRun("codex", configFile, entry.name, [
      `[mcp_servers.${entry.name}]: ${existing === undefined ? "add" : "replace known legacy"}`,
      `[mcp_servers.${entry.name}.env]: add`,
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
  const legacy = inspectLegacyClaudeMcpEntry(scope, entry, opts.replaceLegacy);
  if (legacy.state === "conflict") return resultConflict("claude", legacy.target, entry.name);
  const res = removeJsonMcpEntry("claude", claudeMcpFile(scope), "mcpServers", entry, opts);
  // See the matching setup path above: removing an own entry left only in the
  // legacy file is a removal, not an idempotent skip.
  if (legacy.state === "owned" && res.action === "skipped-idempotent") {
    if (opts.dryRun)
      return resultDryRun("claude", legacy.target, entry.name, [
        `mcpServers.${entry.name}: remove legacy entry`,
      ]);
    try {
      cleanupLegacyClaudeMcpEntry(scope, entry, false, opts.replaceLegacy);
      return resultRemoved("claude", legacy.target, entry.name, null);
    } catch {
      return partialLegacyCleanup(res, legacy.target);
    }
  }
  if (legacy.state === "owned" && res.action === "removed") {
    try {
      cleanupLegacyClaudeMcpEntry(scope, entry, false, opts.replaceLegacy);
    } catch {
      // As in setup, the primary removal is real but legacy retirement is not
      // complete. Keep the receipt and registry through the caller's partial
      // error path so the next explicit remove can recover safely.
      return partialLegacyCleanup(res, legacy.target);
    }
  }
  return res;
}

function removeCodexMcpEntry(
  entry: McpEntry,
  scope: ScopeInput,
  opts: McpWriteOpts,
): McpWriteResult {
  const configFile = join(scope.scopeDir, ".codex", "config.toml");
  const oldContent = existsSync(configFile) ? readFileSync(configFile, "utf-8") : "";
  const parsed = parseCodexConfig(oldContent, configFile);
  const mcpServers = recordContainer(parsed, "mcp_servers", configFile);
  if (mcpServers === undefined) return resultSkipped("codex", configFile, entry.name);
  const existing = mcpServers[entry.name];
  if (existing === undefined) {
    return resultSkipped("codex", configFile, entry.name);
  }
  const legacy =
    opts.replaceLegacy === undefined
      ? undefined
      : mcpEntryShapeForHost("codex", opts.replaceLegacy);
  if (
    !isDeepStrictEqual(existing, mcpEntryShapeForHost("codex", entry)) &&
    !isDeepStrictEqual(existing, legacy)
  ) {
    return resultConflict("codex", configFile, entry.name);
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
 * per-platform registry path (Linux/Windows differ from ~/.warp — DEC-W3).
 * scopeDir acts as homedir at global scope, so tests can inject a tmpdir.
 */
function warpMcpFile(scope: ScopeInput): string {
  if (scope.kind === "global") {
    const globalPath = resolveWarpGlobalMcpPath(process.platform, () => scope.scopeDir);
    if (globalPath) return globalPath;
  }
  return resolveWarpProjectMcpPath(scope.scopeDir);
}

function readJsonFile(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf-8");
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) return parsed;
    throw new Error("contenido no es un objeto JSON");
  } catch {
    throw new McpWriterError(`JSON inválido en ${file}`, file);
  }
}

function parseCodexConfig(content: string, configFile: string): Record<string, unknown> {
  if (content.trim().length === 0) return {};
  try {
    const parsed = parseToml(content);
    if (isRecord(parsed)) return parsed;
    throw new Error("contenido TOML no es un objeto");
  } catch {
    throw new McpWriterError(`config.toml inválido en ${configFile}`, configFile);
  }
}

/**
 * Missing MCP containers are created only by a successful write. A present
 * scalar, null, or array is malformed user configuration and must never be
 * replaced with an empty object behind their back.
 */
function recordContainer(
  parent: Record<string, unknown>,
  key: string,
  file: string,
): Record<string, unknown> | undefined {
  const current = parent[key];
  if (current === undefined) return undefined;
  if (isRecord(current)) return current;
  throw new McpWriterError(`contenedor '${key}' inválido en ${file}`, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// backupFile/purgeStaleBackups/escapeRegex live in multiroot/paths.ts (single
// backup mechanism for host-config files: keep-latest, purge-then-copy).

function discardBackup(backupPath: string | null): void {
  if (backupPath === null) return;
  try {
    if (existsSync(backupPath)) unlinkSync(backupPath);
  } catch {
    // best-effort: never fail the successful write over a failed cleanup
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
  if (entry.optional) buffer.push("required = false");
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

function resultConflict(host: McpHost, target: string, name: string): McpWriteResult {
  return action(host, target, name, "conflict", null);
}

function partialLegacyCleanup(result: McpWriteResult, target: string): McpWriteResult {
  return {
    ...result,
    partial: {
      code: "MCP_LEGACY_CLEANUP_FAILED",
      target,
      message:
        "No se pudo retirar la ubicación legacy de Claude; no recargues el host y reintentá la operación.",
    },
  };
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
