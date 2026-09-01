import { basename, resolve } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { DEFAULT_LOCK_TTL_MS, isExpired, parseLock } from "./lock-service.js";
import { type MultirootError, type MultirootResult, runMultiroot } from "./multiroot-service.js";
import { normalizePath } from "./multiroot/paths.js";
import { readWorkspaceBlock, resolveWorkspaceSourcePath } from "./parsers/project-block.js";
import { PathsService } from "./paths-service.js";
import {
  type ProjectMdUpsertError,
  type ProjectMdUpsertInput,
  type ProjectMdUpsertOutput,
  previewProjectMdUpsert,
  runProjectMdUpsertWrite,
} from "./project-md-upsert-service.js";
import {
  type WorklineMaterialization,
  appendGitignoreEntries,
  ensureWorklineMaterialized,
  previewWorklineMaterialization,
} from "./workspace-materialization-service.js";

export { runtimeGitignoreEntries } from "./workspace-materialization-service.js";

/**
 * docs/ taxonomy owned by Workline (one folder per category). NOT scaffolded
 * anymore: each folder is born on demand at the first numbered write
 * (`aw next-number docs/<cat>` mkdirps it). The list drives the reconcile prune.
 */
export const DOCS_FOLDERS = [
  "specs",
  "plans",
  "designs",
  "manuals",
  "scripts",
  "diagrams",
  "reports",
] as const;

/**
 * Visibility files (machine-specific absolute roots) — gitignored when external
 * sources exist. Trailing `*` also covers the timestamped `.bak.<epoch>` backups.
 * Exported for the code↔doctrine guard test (workspace-init.md documents the set).
 */
export const VISIBILITY_GITIGNORE = [".claude/settings.local.json*", ".codex/config.toml*"];

export interface WorkspaceSource {
  alias: string;
  path: string;
  mainBranch?: string;
}

export interface WorkspaceInitInput {
  /** Workspace name; defaults to the workspace directory basename. */
  proyecto?: string;
  /** 1+ sources (repos). A single source is just a workspace with one source. */
  sources: WorkspaceSource[];
  /** Base branch for sources that do not declare one. Absent = leave the cell empty (the workspace `principal` default resolves it). */
  mainBranch?: string;
  /** Working branches per source alias (rendered in the WORKSPACE Status block). */
  workingBranches?: Record<string, string>;
  /** QA branches per source alias (rendered in the WORKSPACE Status block). */
  qaBranches?: Record<string, string>;
  /** Override the target directory (defaults to cwd). */
  workspace?: string;
  dryRun?: boolean;
  /** Fixed `Última actividad` value for deterministic tests. */
  lastActivity?: string;
}

export interface WorkspaceInitInputError {
  error: string;
  hint?: string;
}

export interface ScaffoldSummary {
  created: string[];
  existing: string[];
  /** Reconcile: legacy upfront-scaffold leftovers removed on re-run (lazy model). */
  pruned: string[];
}

export interface WorkspaceInitResult {
  ok: boolean;
  dry_run: boolean;
  workspace: string;
  sources: number;
  scaffold: ScaffoldSummary;
  /** The exact first-write effects, also present in dry-run. */
  materialization: WorklineMaterialization;
  skills_toml: "created" | "exists" | "skipped";
  project_md:
    | ProjectMdUpsertOutput
    | ProjectMdUpsertError
    | { skipped: true; reason: "materialization_only" };
  /** Skipped when no source lives outside the workspace folder. */
  attach_multiroot: MultirootResult | MultirootError | { skipped: true; reason: string };
  /** Reconcile: detach of sources that were in the previous block and no longer are. */
  detached_removed?: MultirootResult | MultirootError;
}

/**
 * Initialize the current directory as an agent-workflow **workspace**. Unifies the
 * legacy `hub-init` + `project-init`: there is no project/hub distinction — a
 * workspace simply has 1+ sources. Idempotent: re-running reconciles in place.
 *
 * The on-disk block carries NO `Mode:` line (the "WORKSPACE" shape). Source BASE
 * branches live in the Fuentes table; WORKING branches (optional, via
 * --working-branch) render in the Status block unconditionally.
 */
export async function runWorkspaceInit(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: WorkspaceInitInput,
): Promise<WorkspaceInitResult | WorkspaceInitInputError> {
  // `paths` already carries the unique WorklineDirectory root.  An explicit
  // target remains an intentional override; otherwise a subdirectory invocation
  // configures the same root that status/resume/session commands read.
  const workspace = input.workspace ? resolve(input.workspace) : resolve(paths.workspaceDir());
  // No default here on purpose: stamping a base branch into every Fuentes cell
  // would outrank — and on a re-init silently overwrite — the workspace
  // `principal` default the user sets in [Config]. Undeclared stays undeclared.
  const mainBranch = input.mainBranch;
  const wsPaths = new PathsService(paths.namespace, env.homeDir(), workspace);

  const metadataRequested =
    input.proyecto !== undefined ||
    input.mainBranch !== undefined ||
    input.workingBranches !== undefined ||
    input.qaBranches !== undefined ||
    input.lastActivity !== undefined;

  // No sources means no configuration intent.  `workspace-init` is now a
  // convenient early materialization command, not a mandatory gate before
  // status/resume or every flow.  It deliberately does not create skills.toml,
  // a WORKSPACE block, docs/, launch artifacts, HISTORY, or a Git repository.
  if (input.sources.length === 0) {
    if (metadataRequested) {
      return {
        error: "no_sources",
        hint: "las opciones de configuración requieren al menos una fuente (--source alias:path[:rama]); sin fuentes workspace-init sólo materializa el runtime",
      };
    }
    const materialization = input.dryRun
      ? await previewWorklineMaterialization(fs, wsPaths)
      : await ensureWorklineMaterialized(fs, wsPaths);
    return {
      ok: true,
      dry_run: input.dryRun === true,
      workspace,
      sources: 0,
      materialization,
      scaffold: scaffoldFromMaterialization(materialization, wsPaths),
      skills_toml: (await fs.exists(wsPaths.cwdSkillsToml())) ? "exists" : "skipped",
      project_md: { skipped: true, reason: "materialization_only" },
      attach_multiroot: { skipped: true, reason: "materialization_only" },
    };
  }

  // Reconcile: an explicit source declaration is authoritative, while the
  // previous block is read first to detach only sources it actually replaces.
  const existing = await readExistingBlock(fs, workspace, wsPaths);
  const validation = validateSources(input.sources);
  if (validation) return validation;
  // Source locations become workspace-rooted at the configuration boundary.
  // A nested invocation must not leave a relative path whose meaning changes
  // with the next process cwd (or with the TUI's later Git/launch probes).
  const sources = canonicalSources(input.sources, workspace);
  const proyecto = resolveProyecto(input.proyecto, existing?.proyecto, workspace);

  // Built once: the preview must describe the very upsert the real run performs.
  const upsertInput = buildUpsertInput(input, proyecto, sources, mainBranch);

  if (input.dryRun) {
    return buildDryRunResult(fs, env, workspace, wsPaths, sources, upsertInput);
  }

  const materialization = await ensureWorklineMaterialized(fs, wsPaths);
  const scaffold = scaffoldFromMaterialization(materialization, wsPaths);
  // An empty skills.toml has no semantic override.  Leave skill configuration
  // absent until a real override is requested through its dedicated surface.
  const skillsToml = (await fs.exists(wsPaths.cwdSkillsToml())) ? "exists" : "skipped";

  // Previous sources (to detach removed ones) come from the same existing block.
  const previousPaths = (existing?.fuentes ?? []).map((f) => f.path).filter((p) => p.length > 0);

  const projectMd = await runProjectMdUpsertWrite(fs, env, wsPaths, upsertInput);

  if ("error" in projectMd) {
    return {
      ok: false,
      dry_run: false,
      workspace,
      sources: sources.length,
      scaffold,
      materialization,
      skills_toml: skillsToml,
      project_md: projectMd,
      attach_multiroot: { skipped: true, reason: "project_md_failed" },
    };
  }

  const visibility = await reconcileVisibility(fs, env, wsPaths, workspace, sources, previousPaths);

  return {
    ok: projectMd.ok && visibility.ok,
    dry_run: false,
    workspace,
    sources: sources.length,
    scaffold,
    materialization,
    skills_toml: skillsToml,
    project_md: projectMd,
    attach_multiroot: visibility.attach,
    ...(visibility.detached !== undefined ? { detached_removed: visibility.detached } : {}),
  };
}

/** The upsert both the real run and the preview describe — one input, one truth. */
function buildUpsertInput(
  input: WorkspaceInitInput,
  proyecto: string,
  sources: WorkspaceSource[],
  mainBranch: string | undefined,
): ProjectMdUpsertInput {
  return {
    op: "init",
    proyecto,
    fuentes: sources.map((s) => ({
      alias: s.alias,
      path: s.path,
      ...(s.mainBranch !== undefined ? { mainBranch: s.mainBranch } : {}),
    })),
    // Declared set is authoritative (supports removing a source by re-running),
    // which is also what makes the upsert prune the branches it leaves behind.
    replaceFuentes: true,
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
 * Preview derived from the workspace as it IS. Every field here answers a
 * question about disk — does the activation marker exist, is skills.toml
 * already seeded, what would the block write do to each file — because a report
 * of canned values reads identically on a virgin workspace and on an
 * initialized one, and so tells the reader nothing.
 */
async function buildDryRunResult(
  fs: FileSystemPort,
  env: EnvPort,
  workspace: string,
  wsPaths: PathsService,
  sources: WorkspaceSource[],
  upsertInput: ProjectMdUpsertInput,
): Promise<WorkspaceInitResult> {
  const anyExternal = sources.some((s) => isExternalToWorkspace(s.path, workspace));
  const materialization = await previewWorklineMaterialization(fs, wsPaths);
  return {
    ok: true,
    dry_run: true,
    workspace,
    sources: sources.length,
    materialization,
    scaffold: scaffoldFromMaterialization(materialization, wsPaths),
    skills_toml: (await fs.exists(wsPaths.cwdSkillsToml())) ? "exists" : "skipped",
    project_md: await previewProjectMdUpsert(fs, env, wsPaths, upsertInput),
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
  workspace: string,
  sources: WorkspaceSource[],
  previousPaths: string[],
): Promise<VisibilityOutcome> {
  // Visibility must be configured for every source whose path lives OUTSIDE the
  // workspace folder: the host (Claude/Codex) opened the workspace dir, so an
  // external repo is invisible until added to additionalDirectories /
  // additional_writable_roots. This is independent of the source COUNT — a single
  // external source (the common hub case) still needs it; a source that IS the
  // workspace (init in-place) needs nothing.
  const external = sources
    .filter((s) => isExternalToWorkspace(s.path, workspace))
    .map((s) => s.path);

  // Detach sources that were in the previous block and no longer are (reconcile),
  // regardless of whether any external source remains.
  const currentNorm = new Set(sources.map((s) => normalizePath(s.path)));
  const removed = previousPaths.filter((p) => !currentNorm.has(normalizePath(p)));
  const detached =
    removed.length > 0
      ? await runMultiroot(fs, env, wsPaths, "detach", { paths: removed, workspace })
      : undefined;

  if (external.length === 0) {
    return {
      ok: true,
      attach: { skipped: true, reason: "no_external_sources" },
      ...(detached !== undefined ? { detached } : {}),
    };
  }

  const attach = await runMultiroot(fs, env, wsPaths, "attach", { paths: external, workspace });
  await ensureVisibilityGitignore(fs, workspace);

  return {
    ok: !("error" in attach),
    attach,
    ...(detached !== undefined ? { detached } : {}),
  };
}

/** A source path that lives outside the workspace folder needs host visibility config. */
function isExternalToWorkspace(sourcePath: string, workspace: string): boolean {
  const src = normalizePath(resolveWorkspaceSourcePath(workspace, sourcePath));
  const ws = normalizePath(resolve(workspace));
  return src !== ws && !src.startsWith(`${ws}/`);
}

/** Persist source paths as absolute coordinates rooted in the resolved workspace. */
function canonicalSources(sources: WorkspaceSource[], workspace: string): WorkspaceSource[] {
  return sources.map((source) => ({
    ...source,
    path: resolveWorkspaceSourcePath(workspace, source.path),
  }));
}

/** Proyecto + sources declared in the current block (before it is rewritten),
 *  used to preserve them on a reconcile re-run. Null when no block exists yet. */
async function readExistingBlock(
  fs: FileSystemPort,
  workspace: string,
  paths: PathsService,
): Promise<{ proyecto: string; fuentes: WorkspaceSource[] } | null> {
  const block = await readWorkspaceBlock(fs, workspace, paths.blockMarkers());
  if (!block) return null;
  return {
    proyecto: block.proyecto,
    fuentes: block.fuentes
      .filter((f) => f.path.length > 0)
      .map((f) => ({
        alias: f.alias,
        // Reconcile a legacy relative entry against the same root before it is
        // compared, detached or re-emitted as canonical metadata.
        path: resolveWorkspaceSourcePath(workspace, f.path),
        ...(f.main_branch ? { mainBranch: f.main_branch } : {}),
      })),
  };
}

/** Project description: explicit arg wins, else preserve the existing block's,
 *  else fall back to the workspace folder name. */
function resolveProyecto(
  arg: string | undefined,
  existing: string | undefined,
  workspace: string,
): string {
  if (arg && arg.trim().length > 0) return arg.trim();
  if (existing && existing.trim().length > 0) return existing.trim();
  return basename(workspace);
}

/** Ensure the workspace `.gitignore` ignores the visibility files (idempotent). */
async function ensureVisibilityGitignore(fs: FileSystemPort, workspace: string): Promise<void> {
  await appendGitignoreEntries(
    fs,
    workspace,
    "# Multi-root visibility (machine-specific paths — do not commit)",
    VISIBILITY_GITIGNORE,
  );
}

function validateSources(sources: WorkspaceSource[]): WorkspaceInitInputError | null {
  if (!sources || sources.length < 1) {
    return {
      error: "no_sources",
      hint: "workspace-init requiere al menos 1 fuente (--source alias:path[:rama]); o re-corré en un workspace ya inicializado para reconciliar preservando las existentes",
    };
  }
  const aliases = new Set<string>();
  for (const s of sources) {
    if (!s.alias || !s.path) {
      return { error: "invalid_source", hint: `fuente sin alias o path: ${JSON.stringify(s)}` };
    }
    if (s.alias === "workspace") {
      return {
        error: "reserved_source_alias",
        hint: "'workspace' es la fuente implícita reservada para la raíz Workline; elegí otro alias para una fuente adicional",
      };
    }
    if (aliases.has(s.alias)) {
      return { error: "duplicate_alias", hint: `alias duplicado: ${s.alias}` };
    }
    aliases.add(s.alias);
  }
  return null;
}
