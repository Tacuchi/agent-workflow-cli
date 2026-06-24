import { basename, join, resolve } from "node:path";
import { BUILTIN_DEFAULT_SKILLS, SKILL_ROLES } from "../domain/skills.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { type MultirootError, type MultirootResult, runMultiroot } from "./multiroot-service.js";
import { normalizePath } from "./multiroot/paths.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import { PathsService } from "./paths-service.js";
import {
  type ProjectMdUpsertError,
  type ProjectMdUpsertOutput,
  runProjectMdUpsertWrite,
} from "./project-md-upsert-service.js";
import { resolveSkills } from "./skills-resolver-service.js";
import {
  type LaunchArtifactsSummary,
  generateLaunchArtifacts,
} from "./source-launch-scripts-service.js";

/** docs/ taxonomy scaffolded for every workspace (one folder per export category). */
const DOCS_FOLDERS = [
  "specs",
  "plans",
  "tools",
  "manuals",
  "scripts",
  "diagrams",
  "reports",
] as const;

/** Visibility files (machine-specific absolute roots) — gitignored when external sources exist. */
const VISIBILITY_GITIGNORE = [".claude/settings.local.json", ".codex/config.toml"];

/** Runtime artifacts of the source-launch feature — machine-specific, never committed. */
function runtimeGitignoreEntries(ns: string): string[] {
  return [`.${ns}/processes.json`, "docs/logs/"];
}

const DEFAULT_MAIN_BRANCH = "main";

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
  /** Default main branch for sources that do not declare one. Defaults to "main". */
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
}

export interface WorkspaceInitResult {
  ok: boolean;
  dry_run: boolean;
  workspace: string;
  sources: number;
  scaffold: ScaffoldSummary;
  skills_toml: "created" | "exists";
  project_md: ProjectMdUpsertOutput | ProjectMdUpsertError;
  /** Multi-root visibility only runs with 2+ sources; single-source skips it. */
  attach_multiroot: MultirootResult | MultirootError | { skipped: true; reason: string };
  /** Reconcile: detach of sources that were in the previous block and no longer are. */
  detached_removed?: MultirootResult | MultirootError;
  /** Per-source launch descriptor + scripts generated under docs/tools/ (gated on the `tools` role). */
  launch_artifacts: LaunchArtifactsSummary;
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
  const workspace = input.workspace ? resolve(input.workspace) : resolve(env.cwd());
  const mainBranch = input.mainBranch ?? DEFAULT_MAIN_BRANCH;
  const wsPaths = new PathsService(paths.namespace, env.homeDir(), workspace);

  // Reconcile: re-running on an initialized workspace PRESERVES the existing
  // sources + description unless explicitly overridden. A plain `workspace-init`
  // (no --source) brings a workspace onto the current schema WITHOUT re-passing
  // every source through the shell — where backslashes in Windows paths
  // (`C:\Source\…`) get eaten, corrupting the block and wiping multiroot.
  const existing = await readExistingBlock(fs, workspace, wsPaths);
  const sources = input.sources.length > 0 ? input.sources : (existing?.fuentes ?? []);
  const proyecto = resolveProyecto(input.proyecto, existing?.proyecto, workspace);

  const validation = validateSources(sources);
  if (validation) return validation;

  if (input.dryRun) {
    return buildDryRunResult(workspace, paths.namespace, sources);
  }

  // Everything is scoped to `workspace` (which may differ from the process cwd).
  const targetEnv = workspace !== resolve(env.cwd()) ? overrideCwd(env, workspace) : env;

  const scaffold = await scaffoldDirs(fs, workspace, wsPaths);
  const skillsToml = await seedSkillsToml(fs, wsPaths);
  // Runtime artifacts (process registry + launch logs) are machine-specific — gitignore always.
  await ensureRuntimeGitignore(fs, workspace, wsPaths.namespace);

  // Per-source launch artifacts under docs/tools/ (descriptor + run.sh/run.ps1),
  // gated on the `tools` capability and idempotent (preserves user-edited scripts).
  const skillsRes = await resolveSkills(fs, wsPaths);
  const launchArtifacts = await generateLaunchArtifacts(
    fs,
    join(workspace, "docs", "tools"),
    sources.map((s) => ({ alias: s.alias, path: s.path })),
    skillsRes.skills.tools.enabled,
  );

  // Previous sources (to detach removed ones) come from the same existing block.
  const previousPaths = (existing?.fuentes ?? []).map((f) => f.path).filter((p) => p.length > 0);

  const projectMd = await runProjectMdUpsertWrite(fs, targetEnv, wsPaths, {
    op: "init",
    // Block without `Mode:` line; Fuentes table holds N sources. Working branches
    // render in the Status block.
    proyecto,
    fuentes: sources.map((s) => ({
      alias: s.alias,
      path: s.path,
      ...(s.mainBranch !== undefined ? { mainBranch: s.mainBranch } : {}),
    })),
    // Declared set is authoritative (supports removing a source by re-running).
    replaceFuentes: true,
    mainBranch,
    ...(input.workingBranches !== undefined ? { workingBranches: input.workingBranches } : {}),
    ...(input.qaBranches !== undefined ? { qaBranches: input.qaBranches } : {}),
    verbose: true,
    ...(input.lastActivity !== undefined ? { lastActivity: input.lastActivity } : {}),
  });

  if ("error" in projectMd) {
    return {
      ok: false,
      dry_run: false,
      workspace,
      sources: sources.length,
      scaffold,
      skills_toml: skillsToml,
      project_md: projectMd,
      attach_multiroot: { skipped: true, reason: "project_md_failed" },
      launch_artifacts: launchArtifacts,
    };
  }

  // Multi-root visibility only matters with 2+ sources. Single source → no-op.
  const visibility = await reconcileVisibility(
    fs,
    targetEnv,
    wsPaths,
    workspace,
    sources,
    previousPaths,
  );

  return {
    ok: projectMd.ok && visibility.ok,
    dry_run: false,
    workspace,
    sources: sources.length,
    scaffold,
    skills_toml: skillsToml,
    project_md: projectMd,
    attach_multiroot: visibility.attach,
    ...(visibility.detached !== undefined ? { detached_removed: visibility.detached } : {}),
    launch_artifacts: launchArtifacts,
  };
}

function plannedScaffold(workspace: string, ns: string): string[] {
  const out = [join(workspace, `.${ns}`, "sessions")];
  for (const f of DOCS_FOLDERS) out.push(join(workspace, "docs", f));
  return out;
}

function buildDryRunResult(
  workspace: string,
  namespace: string,
  sources: WorkspaceSource[],
): WorkspaceInitResult {
  const anyExternal = sources.some((s) => isExternalToWorkspace(s.path, workspace));
  return {
    ok: true,
    dry_run: true,
    workspace,
    sources: sources.length,
    scaffold: { created: plannedScaffold(workspace, namespace), existing: [] },
    skills_toml: "created",
    project_md: { ok: true, action: "init" },
    attach_multiroot: anyExternal
      ? { skipped: true, reason: "dry_run" }
      : { skipped: true, reason: "no_external_sources" },
    launch_artifacts: {
      toolsRole: "enabled",
      generated: [],
      skipped: sources.map((s) => ({ alias: s.alias, reason: "path_not_found" as const })),
    },
  };
}

async function scaffoldDirs(
  fs: FileSystemPort,
  workspace: string,
  wsPaths: PathsService,
): Promise<ScaffoldSummary> {
  const created: string[] = [];
  const existing: string[] = [];
  const dirs = [wsPaths.cwdSessionsDir(), ...DOCS_FOLDERS.map((f) => join(workspace, "docs", f))];
  for (const dir of dirs) {
    if (await fs.exists(dir)) {
      existing.push(dir);
      continue;
    }
    await fs.mkdirp(dir);
    // .gitkeep so the empty taxonomy folders survive in git.
    const keep = join(dir, ".gitkeep");
    if (!(await fs.exists(keep))) await fs.writeText(keep, "");
    created.push(dir);
  }
  // Runtime launch logs — created (no .gitkeep: the folder is gitignored).
  const logsDir = join(workspace, "docs", "logs");
  if (await fs.exists(logsDir)) {
    existing.push(logsDir);
  } else {
    await fs.mkdirp(logsDir);
    created.push(logsDir);
  }
  return { created, existing };
}

/** Seed `.workflow/skills.toml` with a commented template. Never clobbers an existing file. */
async function seedSkillsToml(
  fs: FileSystemPort,
  wsPaths: PathsService,
): Promise<"created" | "exists"> {
  const file = wsPaths.cwdSkillsToml();
  if (await fs.exists(file)) return "exists";
  await fs.mkdirp(wsPaths.cwdRoot());
  await fs.writeText(file, renderSkillsTomlTemplate());
  return "created";
}

function renderSkillsTomlTemplate(): string {
  const header = [
    "# agent-workflow — capability skill bindings",
    "#",
    "# Maps each capability ROLE to the SKILL that implements it.",
    "# Cascade (later wins): built-in default -> ~/.workflow/skills.toml (global) -> .workflow/skills.toml (workspace)",
    "#",
    "# To override a role, uncomment its line and set a value:",
    "#   - a skill name (built-in, or a third-party skill installed via skills.sh)",
    '#   - "off" to disable the capability',
    "# A commented role keeps its built-in default (shown after the #).",
    "#",
    "# Inspect the resolved bindings with: aw skills",
    "",
    "[skills]",
  ];
  const roleLines = SKILL_ROLES.map((role) => `# ${role} = "${BUILTIN_DEFAULT_SKILLS[role]}"`);
  return `${[...header, ...roleLines].join("\n")}\n`;
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
  const src = normalizePath(resolve(sourcePath));
  const ws = normalizePath(resolve(workspace));
  return src !== ws && !src.startsWith(`${ws}/`);
}

function overrideCwd(env: EnvPort, cwd: string): EnvPort {
  return {
    get: (k) => env.get(k),
    homeDir: () => env.homeDir(),
    cwd: () => cwd,
  };
}

/** Proyecto + sources declared in the current block (before it is rewritten),
 *  used to preserve them on a reconcile re-run. Null when no block exists yet. */
async function readExistingBlock(
  fs: FileSystemPort,
  workspace: string,
  paths: PathsService,
): Promise<{ proyecto: string; fuentes: WorkspaceSource[] } | null> {
  const markers = paths.blockMarkers();
  for (const fname of ["CLAUDE.md", "AGENTS.md"]) {
    const file = join(workspace, fname);
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), markers);
    if (block) {
      return {
        proyecto: block.proyecto,
        fuentes: block.fuentes
          .filter((f) => f.path.length > 0)
          .map((f) => ({
            alias: f.alias,
            path: f.path,
            ...(f.main_branch ? { mainBranch: f.main_branch } : {}),
          })),
      };
    }
  }
  return null;
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

/** Append any missing entries under a header to the workspace `.gitignore` (idempotent). */
async function appendGitignoreEntries(
  fs: FileSystemPort,
  workspace: string,
  header: string,
  entries: string[],
): Promise<void> {
  const file = join(workspace, ".gitignore");
  const existing = (await fs.exists(file)) ? await fs.readText(file) : "";
  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  const missing = entries.filter((e) => !present.has(e));
  if (missing.length === 0) return;
  const block = `${header}\n${missing.join("\n")}\n`;
  const body = existing.replace(/\s+$/, "");
  await fs.writeText(file, body.length === 0 ? block : `${body}\n\n${block}`);
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

/** Ensure the workspace `.gitignore` ignores source-launch runtime artifacts (idempotent, always). */
async function ensureRuntimeGitignore(
  fs: FileSystemPort,
  workspace: string,
  ns: string,
): Promise<void> {
  await appendGitignoreEntries(
    fs,
    workspace,
    "# agent-workflow runtime (machine-specific — do not commit)",
    runtimeGitignoreEntries(ns),
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
    if (aliases.has(s.alias)) {
      return { error: "duplicate_alias", hint: `alias duplicado: ${s.alias}` };
    }
    aliases.add(s.alias);
  }
  return null;
}
