import { basename, dirname, resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { ProcessPort } from "../ports/process.js";
import {
  type HubBlockUpsertError,
  type HubBlockUpsertInput,
  type HubBlockUpsertOutput,
  previewHubBlockUpsert,
  runHubBlockUpsertWrite,
} from "./hub-block-upsert-service.js";
import {
  VISIBILITY_GITIGNORE,
  type WorklineMaterialization,
  appendGitignoreEntries,
  ensureWorklineMaterialized,
  previewWorklineMaterialization,
  reconcileRuntimeGitignore,
} from "./hub-materialization-service.js";
import { registerHub } from "./hub-registry.js";
import { type HubUntrack, hubUntrack } from "./hub-untrack-service.js";
import { DEFAULT_LOCK_TTL_MS, isExpired, parseLock } from "./lock-service.js";
import { type MultirootError, type MultirootResult, runMultiroot } from "./multiroot-service.js";
import { normalizePath } from "./multiroot/paths.js";
import { readHubBlock, resolveHubSourcePath } from "./parsers/hub-block.js";
import { PathsService } from "./paths-service.js";

export { runtimeGitignoreEntries } from "./hub-materialization-service.js";

/**
 * docs/ taxonomy owned by Workline (one folder per category). NOT scaffolded
 * anymore: each folder is born on demand at the first numbered write
 * (`aw next-number docs/<cat>` mkdirps it). The list drives the reconcile prune.
 */
export const DOCS_FOLDERS = [
  "specs",
  "plans",
  "manuals",
  "scripts",
  "diagrams",
  "reports",
] as const;

/**
 * Visibility files (machine-specific absolute roots) — gitignored when external
 * sources exist. Trailing `*` also covers the timestamped `.bak.<epoch>` backups.
 * Exported for the code↔doctrine guard test (hub-init.md documents the set).
 */
export { VISIBILITY_GITIGNORE } from "./hub-materialization-service.js";

export interface HubSource {
  alias: string;
  path: string;
  mainBranch?: string;
}

export interface HubInitInput {
  /** Hub name; defaults to the hub directory basename. */
  proyecto?: string;
  /** 1+ sources (repos). A single source is just a hub with one source. */
  sources: HubSource[];
  /** Base branch for sources that do not declare one. Absent = leave the cell empty (the hub `principal` default resolves it). */
  mainBranch?: string;
  /** Working branches per source alias (rendered in the hub Status block). */
  workingBranches?: Record<string, string>;
  /** QA branches per source alias (rendered in the hub Status block). */
  qaBranches?: Record<string, string>;
  /** Override the target directory (defaults to cwd). */
  hub?: string;
  dryRun?: boolean;
  /** Remove Workline-ignored paths from Git's index, retaining their on-disk bytes. */
  untrack?: boolean;
  /** Fixed `Última actividad` value for deterministic tests. */
  lastActivity?: string;
}

export interface HubInitInputError {
  error: string;
  hint?: string;
}

export interface ScaffoldSummary {
  created: string[];
  existing: string[];
  /** Reconcile: legacy upfront-scaffold leftovers removed on re-run (lazy model). */
  pruned: string[];
}

export interface HubInitResult {
  ok: boolean;
  dry_run: boolean;
  hub: string;
  /** Present only when the hub could not be added to `~/.<ns>/hubs.json`. */
  registry_warning?: string;
  sources: number;
  source_actions?: { alias: string; action: "added" | "updated"; error?: string }[];
  scaffold: ScaffoldSummary;
  /** The exact first-write effects, also present in dry-run. */
  materialization: WorklineMaterialization;
  untrack?: HubUntrack;
  skills_toml: "created" | "exists" | "skipped";
  hub_block_files:
    | HubBlockUpsertOutput
    | HubBlockUpsertError
    | { skipped: true; reason: "materialization_only" };
  /** Skipped when no source lives outside the hub folder. */
  attach_multiroot: MultirootResult | MultirootError | { skipped: true; reason: string };
  /** Reconcile: detach of sources that were in the previous block and no longer are. */
  detached_removed?: MultirootResult | MultirootError;
}

/**
 * Initialize the current directory as an agent-workflow **hub**: one concept, a
 * hub simply has 1+ sources. Idempotent: re-running reconciles in place.
 *
 * The on-disk block carries NO `Mode:` line (the "hub" shape). Source BASE
 * branches live in the Fuentes table; WORKING branches (optional, via
 * --working-branch) render in the Status block unconditionally.
 */
export async function runHubInit(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: HubInitInput,
  process?: ProcessPort,
): Promise<HubInitResult | HubInitInputError> {
  // `paths` already carries the unique WorklineDirectory root.  An explicit
  // target remains an intentional override; otherwise a subdirectory invocation
  // configures the same root that status/resume/session commands read.
  const hub = input.hub ? resolve(input.hub) : resolve(paths.hubDir());
  // No default here on purpose: stamping a base branch into every Fuentes cell
  // would outrank — and on a re-init silently overwrite — the hub
  // `principal` default the user sets in [Config]. Undeclared stays undeclared.
  const mainBranch = input.mainBranch;
  const wsPaths = new PathsService(paths.namespace, env.homeDir(), hub);

  // No sources means no configuration intent.  `hub-init` is now a
  // convenient early materialization command, not a mandatory gate before
  // status/resume or every flow.  It deliberately does not create skills.toml,
  // a hub block, docs/, launch artifacts, HISTORY, or a Git repository.
  if (input.sources.length === 0 && input.proyecto === undefined) {
    return registered(
      fs,
      wsPaths,
      await materializeWithoutSources(fs, wsPaths, hub, input, process),
    );
  }

  // Source declarations are additive; omitted aliases keep their branches and visibility.
  const existing = await readExistingBlock(fs, hub, wsPaths);
  if (
    input.sources.length === 0 &&
    (input.mainBranch !== undefined ||
      input.workingBranches !== undefined ||
      input.qaBranches !== undefined)
  ) {
    return {
      error: "no_sources",
      hint: "las opciones de rama requieren una fuente; --nombre puede usarse solo",
    };
  }
  const validation = input.sources.length > 0 ? validateSources(input.sources) : null;
  if (validation) return validation;
  const sources = input.sources;
  const previousAliases = new Set(existing?.fuentes.map((f) => f.alias) ?? []);
  const sourceActions = sources.map((source) => ({
    alias: source.alias,
    action: previousAliases.has(source.alias) ? ("updated" as const) : ("added" as const),
  }));
  const proyecto = resolveProyecto(input.proyecto, existing?.proyecto, hub);

  // Built once: the preview must describe the very upsert the real run performs.
  const upsertInput = buildUpsertInput(input, proyecto, sources, mainBranch);

  if (input.dryRun) {
    const preview = await buildDryRunResult(fs, env, hub, wsPaths, sources, upsertInput);
    const untrack = process ? await hubUntrack(process, wsPaths, false) : undefined;
    return { ...preview, source_actions: sourceActions, ...(untrack ? { untrack } : {}) };
  }

  return registered(
    fs,
    wsPaths,
    await applyHubInit(
      fs,
      env,
      wsPaths,
      hub,
      input,
      process,
      sources,
      sourceActions,
      existing,
      upsertInput,
    ),
  );
}

/** An initialized hub enters the registry, so `aw hubs` knows it before any other command runs there. */
async function registered<T extends HubInitResult | HubInitInputError>(
  fs: FileSystemPort,
  wsPaths: PathsService,
  result: T,
): Promise<T> {
  // $HOME is never a hub, as in the implicit registration.
  if ("error" in result || result.dry_run || resolve(result.hub) === dirname(wsPaths.userRoot()))
    return result;
  // The hub is already materialized: a registry that cannot be written is
  // reported, as the implicit registration does, instead of failing the init.
  try {
    await registerHub(fs, wsPaths, result.hub);
    return result;
  } catch (error) {
    return {
      ...result,
      registry_warning: `No se pudo registrar el hub ${result.hub}: ${String(error)}`,
    };
  }
}

async function initMaterialization(
  fs: FileSystemPort,
  paths: PathsService,
  dryRun: boolean,
): Promise<WorklineMaterialization> {
  if (dryRun) return previewWorklineMaterialization(fs, paths);
  const receipt = await ensureWorklineMaterialized(fs, paths);
  if (receipt.materialized) return receipt;
  const ignore = await reconcileRuntimeGitignore(fs, paths);
  return {
    ...receipt,
    effects: [ignore, ...receipt.effects.filter((effect) => effect.kind !== "gitignore")],
  };
}

/** The upsert both the real run and the preview describe — one input, one truth. */
function buildUpsertInput(
  input: HubInitInput,
  proyecto: string,
  sources: HubSource[],
  mainBranch: string | undefined,
): HubBlockUpsertInput {
  return {
    op: "init",
    proyecto,
    fuentes: sources.map((s) => ({
      alias: s.alias,
      path: s.path,
      ...(s.mainBranch !== undefined ? { mainBranch: s.mainBranch } : {}),
    })),
    ...(mainBranch !== undefined ? { mainBranch } : {}),
    ...(input.workingBranches !== undefined ? { workingBranches: input.workingBranches } : {}),
    ...(input.qaBranches !== undefined ? { qaBranches: input.qaBranches } : {}),
    verbose: true,
    ...(input.lastActivity !== undefined ? { lastActivity: input.lastActivity } : {}),
  };
}

function scaffoldFromMaterialization(
  materialization: WorklineMaterialization,
  paths: PathsService,
): ScaffoldSummary {
  const sessions = materialization.effects.find((effect) => effect.kind === "sessions");
  return {
    created: sessions?.status === "created" ? [paths.cwdSessionsDir()] : [],
    existing: sessions?.status === "existing" ? [paths.cwdSessionsDir()] : [],
    pruned: [],
  };
}

/**
 * Preview derived from the hub as it IS. Every field here answers a
 * question about disk — does the activation marker exist, is skills.toml
 * already seeded, what would the block write do to each file — because a report
 * of canned values reads identically on a virgin hub and on an
 * initialized one, and so tells the reader nothing.
 */
async function buildDryRunResult(
  fs: FileSystemPort,
  env: EnvPort,
  hub: string,
  wsPaths: PathsService,
  sources: HubSource[],
  upsertInput: HubBlockUpsertInput,
): Promise<HubInitResult> {
  const anyExternal = sources.some((s) => isExternalToHub(s.path, hub));
  const materialization = await previewWorklineMaterialization(fs, wsPaths);
  return {
    ok: true,
    dry_run: true,
    hub: hub,
    sources: sources.length,
    materialization,
    scaffold: scaffoldFromMaterialization(materialization, wsPaths),
    skills_toml: (await fs.exists(wsPaths.cwdSkillsToml())) ? "exists" : "skipped",
    hub_block_files: await previewHubBlockUpsert(fs, env, wsPaths, upsertInput),
    attach_multiroot: anyExternal
      ? { skipped: true, reason: "dry_run" }
      : { skipped: true, reason: "no_external_sources" },
  };
}

/**
 * Remove a historical released/expired `.workflow/.lock` leftover. Current
 * release() unlinks the lock it owns; an empty file is only a legacy marker.
 * A live lock (non-empty, not expired) is never touched. Exported for direct
 * unit tests of the live-lock guard.
 */
export async function pruneReleasedLock(
  fs: FileSystemPort,
  wsPaths: PathsService,
  apply = true,
): Promise<string[]> {
  const lockFile = wsPaths.cwdLockFile();
  if (!(await fs.exists(lockFile))) return [];
  const raw = await fs.readText(lockFile);
  const lock = parseLock(raw);
  const removable =
    raw.trim().length === 0 || (lock !== null && isExpired(lock, Date.now(), DEFAULT_LOCK_TTL_MS));
  if (!removable) return [];
  if (apply) await fs.remove(lockFile);
  return [lockFile];
}

interface VisibilityOutcome {
  ok: boolean;
  attach: MultirootResult | MultirootError | { skipped: true; reason: string };
  detached?: MultirootResult | MultirootError;
}

async function reconcileVisibility(
  fs: FileSystemPort,
  env: EnvPort,
  wsPaths: PathsService,
  hub: string,
  sources: HubSource[],
  previousPaths: string[],
): Promise<VisibilityOutcome> {
  // Visibility must be configured for every source whose path lives OUTSIDE the
  // hub folder: the host (Claude/Codex) opened the hub dir, so an
  // external repo is invisible until added to additionalDirectories /
  // additional_writable_roots. This is independent of the source COUNT — a single
  // external source (the common hub case) still needs it; a source that IS the
  // hub (init in-place) needs nothing.
  const external = sources
    .filter((s) => isExternalToHub(s.path, hub))
    .map((s) => resolveHubSourcePath(hub, s.path));

  // Detach sources that were in the previous block and no longer are (reconcile),
  // regardless of whether any external source remains.
  const currentNorm = new Set(sources.map((s) => normalizePath(resolveHubSourcePath(hub, s.path))));
  const removed = previousPaths.filter((p) => !currentNorm.has(normalizePath(p)));
  const detached =
    removed.length > 0
      ? await runMultiroot(fs, env, wsPaths, "detach", { paths: removed, hub })
      : undefined;

  if (external.length === 0) {
    return {
      ok: true,
      attach: { skipped: true, reason: "no_external_sources" },
      ...(detached !== undefined ? { detached } : {}),
    };
  }

  const attach = await runMultiroot(fs, env, wsPaths, "attach", { paths: external, hub });
  await ensureVisibilityGitignore(fs, hub);

  return {
    ok: !("error" in attach),
    attach,
    ...(detached !== undefined ? { detached } : {}),
  };
}

/** A source path that lives outside the hub folder needs host visibility config. */
function isExternalToHub(sourcePath: string, hub: string): boolean {
  const src = normalizePath(resolveHubSourcePath(hub, sourcePath));
  const ws = normalizePath(resolve(hub));
  return src !== ws && !src.startsWith(`${ws}/`);
}

/** Proyecto + sources declared in the current block (before it is rewritten),
 *  used to preserve them on a reconcile re-run. Null when no block exists yet. */
async function readExistingBlock(
  fs: FileSystemPort,
  hub: string,
  paths: PathsService,
): Promise<{ proyecto: string; fuentes: HubSource[] } | null> {
  const block = await readHubBlock(fs, hub, paths.blockMarkers());
  if (!block) return null;
  return {
    proyecto: block.proyecto,
    fuentes: block.fuentes
      .filter((f) => f.path !== null)
      .map((f) => ({
        alias: f.alias,
        // Reconcile a legacy relative entry against the same root before it is
        // compared, detached or re-emitted as canonical metadata.
        path: f.path as string,
        ...(f.main_branch ? { mainBranch: f.main_branch } : {}),
      })),
  };
}

/** Hub description: explicit arg wins, else preserve the existing block's,
 *  else fall back to the hub folder name. */
function resolveProyecto(
  arg: string | undefined,
  existing: string | undefined,
  hub: string,
): string {
  if (arg && arg.trim().length > 0) return arg.trim();
  if (existing && existing.trim().length > 0) return existing.trim();
  return basename(hub);
}

/** Ensure the hub `.gitignore` ignores the visibility files (idempotent). */
async function ensureVisibilityGitignore(fs: FileSystemPort, hub: string): Promise<void> {
  await appendGitignoreEntries(
    fs,
    hub,
    "# Multi-root visibility (machine-specific paths — do not commit)",
    VISIBILITY_GITIGNORE,
  );
}

function validateSources(sources: HubSource[]): HubInitInputError | null {
  if (!sources || sources.length < 1) {
    return {
      error: "no_sources",
      hint: "declará una fuente con aw add-source <alias>:<ruta>:<rama>; hub-init --nombre <nombre> funciona sin fuentes",
    };
  }
  const aliases = new Set<string>();
  for (const s of sources) {
    if (!s.alias || !s.path) {
      return { error: "invalid_source", hint: `fuente sin alias o path: ${JSON.stringify(s)}` };
    }
    if (s.alias === "hub") {
      return {
        error: "reserved_source_alias",
        hint: "'hub' es la fuente implícita reservada para la raíz Workline; elegí otro alias para una fuente adicional",
      };
    }
    if (aliases.has(s.alias)) {
      return { error: "duplicate_alias", hint: `alias duplicado: ${s.alias}` };
    }
    aliases.add(s.alias);
  }
  return null;
}

async function materializeWithoutSources(
  fs: FileSystemPort,
  wsPaths: PathsService,
  hub: string,
  input: HubInitInput,
  process: ProcessPort | undefined,
): Promise<HubInitResult | HubInitInputError> {
  const metadataRequested =
    input.proyecto !== undefined ||
    input.mainBranch !== undefined ||
    input.workingBranches !== undefined ||
    input.qaBranches !== undefined ||
    input.lastActivity !== undefined;

  if (metadataRequested) {
    return {
      error: "no_sources",
      hint: "las opciones de rama requieren al menos una fuente (--source alias:path[:rama]); sin fuentes hub-init sólo materializa el runtime",
    };
  }
  const materialization = await initMaterialization(fs, wsPaths, input.dryRun === true);
  const untrack = process
    ? await hubUntrack(process, wsPaths, input.untrack === true && input.dryRun !== true)
    : undefined;
  return {
    ok: true,
    dry_run: input.dryRun === true,
    hub: hub,
    sources: 0,
    materialization,
    ...(untrack === undefined ? {} : { untrack }),
    scaffold: scaffoldFromMaterialization(materialization, wsPaths),
    skills_toml: (await fs.exists(wsPaths.cwdSkillsToml())) ? "exists" : "skipped",
    hub_block_files: { skipped: true, reason: "materialization_only" },
    attach_multiroot: { skipped: true, reason: "materialization_only" },
  };
}

async function applyHubInit(
  fs: FileSystemPort,
  env: EnvPort,
  wsPaths: PathsService,
  hub: string,
  input: HubInitInput,
  process: ProcessPort | undefined,
  sources: HubSource[],
  sourceActions: NonNullable<HubInitResult["source_actions"]>,
  existing: Awaited<ReturnType<typeof readExistingBlock>>,
  upsertInput: HubBlockUpsertInput,
): Promise<HubInitResult> {
  const materialization = await initMaterialization(fs, wsPaths, false);
  const untrack = process ? await hubUntrack(process, wsPaths, input.untrack === true) : undefined;
  const scaffold = scaffoldFromMaterialization(materialization, wsPaths);
  // An empty skills.toml has no semantic override.  Leave skill configuration
  // absent until a real override is requested through its dedicated surface.
  const skillsToml = (await fs.exists(wsPaths.cwdSkillsToml())) ? "exists" : "skipped";

  // Previous sources (to detach removed ones) come from the same existing block.
  const updatedAliases = new Set(sources.map((source) => source.alias));
  const previousPaths = (existing?.fuentes ?? [])
    .filter((f) => updatedAliases.has(f.alias) && f.path !== null)
    .map((f) => f.path as string);

  const hubBlock = await runHubBlockUpsertWrite(fs, env, wsPaths, upsertInput);

  if ("error" in hubBlock || !hubBlock.ok) {
    const cause =
      "error" in hubBlock
        ? hubBlock.error
        : (hubBlock.results?.find((file) => file.error)?.error ?? "el bloque no se publicó");
    return {
      ok: false,
      dry_run: false,
      hub: hub,
      sources: sources.length,
      source_actions: sourceActions.map((source) => ({ ...source, error: cause })),
      scaffold,
      materialization,
      ...(untrack === undefined ? {} : { untrack }),
      skills_toml: skillsToml,
      hub_block_files: hubBlock,
      attach_multiroot: { skipped: true, reason: "hub_block_failed" },
    };
  }

  const visibility = await reconcileVisibility(fs, env, wsPaths, hub, sources, previousPaths);

  return {
    ok: hubBlock.ok && visibility.ok,
    dry_run: false,
    hub: hub,
    sources: sources.length,
    source_actions: sourceActions,
    scaffold,
    materialization,
    ...(untrack === undefined ? {} : { untrack }),
    skills_toml: skillsToml,
    hub_block_files: hubBlock,
    attach_multiroot: visibility.attach,
    ...(visibility.detached !== undefined ? { detached_removed: visibility.detached } : {}),
  };
}
