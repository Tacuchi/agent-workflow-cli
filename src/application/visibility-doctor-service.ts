import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseUnitPath, unitPath } from "../domain/isolation-unit.js";
import type { McpHost } from "../domain/mcp-entry.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { normalizePath } from "./multiroot/paths.js";
import { readHubBlock, requireSourcePath } from "./parsers/hub-block.js";
import { PathsService } from "./paths-service.js";
import { readCustody } from "./session-custody-service.js";
import { listSessionFolders } from "./session-resolver.js";
import { hubUnitPaths } from "./unit-membership.js";

export type VisibilityDriftStatus =
  | "ok"
  | "missing-paths"
  | "extra-paths"
  | "no-settings"
  | "no-hub-block"
  | "source-path-missing"
  | "global-pollution";

export interface VisibilityHostReport {
  host: McpHost;
  scope: "hub" | "global";
  /**
   * Single-path pointer kept for consumers that read one file name: the FIRST
   * file the registered paths were actually read from. `targets` carries the
   * whole answer when a host reads more than one.
   */
  target: string;
  /**
   * Every config file the registered paths came from, in host precedence order.
   * With no file present it holds the one a fix has to create — which is exactly
   * what `status: "no-settings"` reports.
   */
  targets: string[];
  declared_paths: string[];
  registered_paths: string[];
  missing: string[];
  extra: string[];
  status: VisibilityDriftStatus;
  detail?: string;
}

/**
 * The config file(s) a report is about.
 *
 * Claude Code reads `settings.json` AND `settings.local.json`, so naming a
 * single hardcoded file makes the report point at a path that may not exist
 * while the paths were read from the other one. `primary` preserves the
 * one-path shape; `all` is the honest answer about where the data came from.
 */
interface HostTargets {
  primary: string;
  all: string[];
}

/** A host whose registered paths live in exactly one file. */
function oneTarget(file: string): HostTargets {
  return { primary: file, all: [file] };
}

export interface VisibilityDoctorInput {
  hub?: string;
  global?: boolean;
}

export interface VisibilityDoctorResult {
  hub_dir: string;
  unreadable_sources?: string[];
  reports: VisibilityHostReport[];
  global_reports: VisibilityHostReport[];
  summary: {
    ok: number;
    missing_paths: number;
    extra_paths: number;
    no_settings: number;
    global_pollution: number;
    no_hub_block: number;
  };
}

export async function runVisibilityDoctor(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: VisibilityDoctorInput,
): Promise<VisibilityDoctorResult> {
  const hub = input.hub ? resolve(input.hub) : paths.hubDir();
  const scoped = new PathsService(paths.namespace, dirname(paths.userRoot()), hub);
  const sourceReading = await readDeclaredFuentes(fs, scoped, hub);
  const initial = sourceReading.paths;
  const visible = [inspectClaude(hub, initial, "hub"), inspectCodex(hub, initial, "hub")];
  const unitsRoot = await fs.realPath(scoped.userUnitsDir()).catch(() => scoped.userUnitsDir());
  const owns = await hubUnitPaths(fs, scoped, unitsRoot);
  const livingUnits: string[] = [];
  for (const path of new Set(visible.flatMap((report) => report.registered_paths))) {
    const identity = parseUnitPath(unitsRoot, path);
    if (
      identity === null ||
      normalizePath(path) !== normalizePath(unitPath(unitsRoot, identity)) ||
      !owns(path)
    )
      continue;
    const stat = await fs.lstat(path);
    if (stat?.type === "dir" && !stat.isSymlink) livingUnits.push(path);
  }
  const declared = initial === null ? null : [...new Set([...initial, ...livingUnits])];
  const reports: VisibilityHostReport[] = [
    inspectClaude(hub, declared, "hub"),
    inspectCodex(hub, declared, "hub"),
    inspectWarp(hub, declared, "hub"),
  ];

  const globalReports: VisibilityHostReport[] = [];
  if (input.global) {
    // Home comes from the injected EnvPort, like the hub does: reading
    // node:os directly made the global scope unobservable from a test, which is
    // the half of the doctor that touches files outside the hub.
    const home = env.homeDir();
    globalReports.push(inspectClaudeGlobal(home, declared), inspectCodexGlobal(home, declared));
  }

  // Without every declared source path the comparison is incomplete. In particular,
  // an existing registration must not be proposed for deletion as an "extra".
  if (sourceReading.errors.length > 0) {
    for (const report of [...reports, ...globalReports]) {
      report.status = "source-path-missing";
      report.detail = sourceReading.errors.join("; ");
      report.missing = [];
      report.extra = [];
    }
  }

  return {
    hub_dir: hub,
    ...(sourceReading.errors.length > 0 ? { unreadable_sources: sourceReading.errors } : {}),
    reports,
    global_reports: globalReports,
    summary: buildSummary([...reports, ...globalReports]),
  };
}

async function readDeclaredFuentes(
  fs: FileSystemPort,
  paths: PathsService,
  hub: string,
): Promise<{ paths: string[] | null; errors: string[] }> {
  const block = await readHubBlock(fs, hub, paths.blockMarkers(), (b) => b.fuentes.length > 0);
  if (!block) return { paths: null, errors: [] };
  const pathsFound: string[] = [];
  const errors: string[] = [];
  for (const source of block.fuentes) {
    try {
      pathsFound.push(await requireSourcePath(fs, source));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  const unitsRoot = await fs.realPath(paths.userUnitsDir()).catch(() => paths.userUnitsDir());
  const owns = await hubUnitPaths(fs, paths, unitsRoot);
  await appendOwnedUnitPaths(fs, paths, owns, pathsFound);
  return { paths: pathsFound, errors };
}

function inspectClaude(
  scopeDir: string,
  declared: string[] | null,
  scope: "hub" | "global",
): VisibilityHostReport {
  const claudeDir = join(scopeDir, ".claude");
  // The file a fix has to create when neither settings file exists yet.
  const canonical = join(claudeDir, "settings.json");
  if (declared === null) {
    return baseNoBlock("claude", scope, oneTarget(canonical));
  }
  // Claude Code reads settings.json and settings.local.json (local takes precedence);
  // the doctor merges additionalDirectories from both to avoid false negatives
  // when the paths live in the .local file (the per-machine, gitignored convention).
  const read = readClaudeAdditionalDirsMerged(claudeDir);
  if (!read.found) {
    return noSettingsReport(
      "claude",
      scope,
      oneTarget(canonical),
      declared,
      `Falta ${canonical} o settings.local.json`,
    );
  }
  return diffReport("claude", scope, read.targets, declared, read.paths);
}

function inspectCodex(
  scopeDir: string,
  declared: string[] | null,
  scope: "hub" | "global",
): VisibilityHostReport {
  const target = join(scopeDir, ".codex", "config.toml");
  const targets = oneTarget(target);
  if (declared === null) {
    return baseNoBlock("codex", scope, targets);
  }
  if (!existsSync(target)) {
    return noSettingsReport("codex", scope, targets, declared, `Falta ${target}`);
  }
  const registered = readCodexWritableRoots(target);
  return diffReport("codex", scope, targets, declared, registered);
}

function inspectClaudeGlobal(home: string, declared: string[] | null): VisibilityHostReport {
  const claudeDir = join(home, ".claude");
  const read = readClaudeAdditionalDirsMerged(claudeDir);
  const targets = read.found ? read.targets : oneTarget(join(claudeDir, "settings.json"));
  const registered = read.found ? read.paths : [];
  return globalPollutionReport("claude", targets, declared ?? [], registered);
}

function inspectCodexGlobal(home: string, declared: string[] | null): VisibilityHostReport {
  const target = join(home, ".codex", "config.toml");
  const registered = existsSync(target) ? readCodexWritableRoots(target) : [];
  return globalPollutionReport("codex", oneTarget(target), declared ?? [], registered);
}

/** Declared sources with no host config file to compare them against. */
function noSettingsReport(
  host: McpHost,
  scope: "hub" | "global",
  targets: HostTargets,
  declared: string[],
  detail: string,
): VisibilityHostReport {
  return {
    host,
    scope,
    target: targets.primary,
    targets: targets.all,
    declared_paths: declared,
    registered_paths: [],
    missing: [...declared],
    extra: [],
    status: declared.length === 0 ? "ok" : "no-settings",
    ...(declared.length > 0 ? { detail } : {}),
  };
}

function inspectWarp(
  _scopeDir: string,
  _declared: string[] | null,
  scope: "hub" | "global",
): VisibilityHostReport {
  // Warp Terminal does not have a hub additionalDirectories concept.
  // Report is always ok — hub path management is not applicable for Warp.
  const target = join(_scopeDir, ".warp", "settings.toml");
  return {
    host: "warp",
    scope,
    target,
    targets: [target],
    declared_paths: [],
    registered_paths: [],
    missing: [],
    extra: [],
    status: "ok",
    detail: "Warp Terminal does not require hub path registration (noop)",
  };
}

function diffReport(
  host: McpHost,
  scope: "hub" | "global",
  targets: HostTargets,
  declared: string[],
  rawRegistered: string[],
): VisibilityHostReport {
  const registered = dedupeRegistered(rawRegistered);
  const where = describeTargets(targets);
  const declaredSet = new Set(declared.map(normalize));
  const registeredSet = new Set(registered.map(normalize));
  const missing = declared.filter((p) => !registeredSet.has(normalize(p)));
  const extra = registered.filter((p) => !declaredSet.has(normalize(p)));
  let status: VisibilityDriftStatus = "ok";
  if (missing.length > 0) status = "missing-paths";
  else if (extra.length > 0) status = "extra-paths";
  return {
    host,
    scope,
    target: targets.primary,
    targets: targets.all,
    declared_paths: declared,
    registered_paths: registered,
    missing,
    extra,
    status,
    ...(status !== "ok"
      ? {
          detail:
            status === "missing-paths"
              ? `${missing.length} path(s) declarado(s) no registrado(s) en ${where}`
              : `${extra.length} path(s) registrado(s) que no son fuentes declaradas`,
        }
      : {}),
  };
}

function globalPollutionReport(
  host: McpHost,
  targets: HostTargets,
  declared: string[],
  rawRegistered: string[],
): VisibilityHostReport {
  const registered = dedupeRegistered(rawRegistered);
  const declaredSet = new Set(declared.map(normalize));
  const polluted = registered.filter((p) => declaredSet.has(normalize(p)));
  const status: VisibilityDriftStatus = polluted.length > 0 ? "global-pollution" : "ok";
  return {
    host,
    scope: "global",
    target: targets.primary,
    targets: targets.all,
    declared_paths: declared,
    registered_paths: registered,
    missing: [],
    extra: polluted,
    status,
    ...(polluted.length > 0
      ? {
          detail: `${polluted.length} path(s) del hub también en ${describeTargets(targets)}. Sugerencia: 'agent-workflow detach-multiroot --global --from-sources'`,
        }
      : {}),
  };
}

/**
 * One registration per path, first occurrence wins.
 *
 * The same directory declared in settings.json AND in settings.local.json is ONE
 * registration, not two. Dedup is by the RAW string and not by `normalize`:
 * `registered_paths` is a literal inventory of what the config files contain —
 * the strings a person has to delete by hand — so two spellings of the same
 * directory stay two entries. `normalize` governs only the comparison against
 * the declared sources, which is where the two spellings already collapse; that
 * is also why this cannot change `missing`/`extra` beyond dropping exact repeats.
 */
function dedupeRegistered(registered: string[]): string[] {
  return [...new Set(registered)];
}

/** Every file the report was actually read from, for the user-facing message. */
function describeTargets(targets: HostTargets): string {
  return targets.all.join(" + ");
}

function baseNoBlock(
  host: McpHost,
  scope: "hub" | "global",
  targets: HostTargets,
): VisibilityHostReport {
  return {
    host,
    scope,
    target: targets.primary,
    targets: targets.all,
    declared_paths: [],
    registered_paths: [],
    missing: [],
    extra: [],
    status: "no-hub-block",
    detail: "bloque del hub no encontrado o sin fuentes en CLAUDE.md/AGENTS.md",
  };
}

type ClaudeSettingsRead = { found: false } | { found: true; targets: HostTargets; paths: string[] };

/**
 * Merges additionalDirectories from settings.json + settings.local.json (Claude
 * Code reads both) and says WHICH of the two it actually read.
 *
 * Reporting the merge without its provenance is what let the doctor answer `ok`
 * while pointing at a settings.json that does not exist.
 */
function readClaudeAdditionalDirsMerged(claudeDir: string): ClaudeSettingsRead {
  const files: string[] = [];
  const paths: string[] = [];
  for (const fname of ["settings.json", "settings.local.json"]) {
    const file = join(claudeDir, fname);
    if (!existsSync(file)) continue;
    files.push(file);
    paths.push(...readClaudeAdditionalDirs(file));
  }
  const [primary, ...rest] = files;
  if (primary === undefined) return { found: false };
  return { found: true, targets: { primary, all: [primary, ...rest] }, paths };
}

function readClaudeAdditionalDirs(file: string): string[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf-8"));
    if (!data || typeof data !== "object") return [];
    const perms = (data as Record<string, unknown>).permissions as
      | Record<string, unknown>
      | undefined;
    const arr = perms?.additionalDirectories;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

function readCodexWritableRoots(file: string): string[] {
  try {
    const text = readFileSync(file, "utf-8");
    const m = text.match(/^additional_writable_roots\s*=\s*\[([\s\S]*?)\]/m);
    if (!m) return [];
    const block = m[1] ?? "";
    const items = [...block.matchAll(/["']([^"']+)["']/g)].map((x) => x[1] as string);
    return items;
  } catch {
    return [];
  }
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function buildSummary(reports: VisibilityHostReport[]): VisibilityDoctorResult["summary"] {
  return {
    ok: reports.filter((r) => r.status === "ok").length,
    missing_paths: reports.filter((r) => r.status === "missing-paths").length,
    extra_paths: reports.filter((r) => r.status === "extra-paths").length,
    no_settings: reports.filter((r) => r.status === "no-settings").length,
    global_pollution: reports.filter((r) => r.status === "global-pollution").length,
    no_hub_block: reports.filter((r) => r.status === "no-hub-block").length,
  };
}

async function appendOwnedUnitPaths(
  fs: FileSystemPort,
  paths: PathsService,
  owns: (path: string) => boolean,
  pathsFound: string[],
): Promise<void> {
  for (const session of await listSessionFolders(fs, paths.cwdSessionsDir())) {
    const custody = await readCustody(fs, session.path);
    if (custody.status !== "present") continue;
    for (const source of custody.custody.sources) {
      const stat = source.unit_path ? await fs.lstat(source.unit_path) : null;
      if (source.unit_path && owns(source.unit_path) && stat?.type === "dir" && !stat.isSymlink) {
        pathsFound.push(source.unit_path);
      }
    }
  }
}
