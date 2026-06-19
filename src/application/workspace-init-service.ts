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

/** Visibility files (machine-specific absolute roots) — gitignored, multi-source only. */
const VISIBILITY_GITIGNORE = [".claude/settings.local.json", ".codex/config.toml"];

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
}

/**
 * Initialize the current directory as an agent-workflow **workspace**. Unifies the
 * legacy `hub-init` + `project-init`: there is no project/hub distinction — a
 * workspace simply has 1+ sources. Idempotent: re-running reconciles in place.
 *
 * Note: the on-disk block is rendered with mode "project" so it carries NO `Mode:`
 * line (the new "WORKSPACE" shape). Source BASE branches live in the Fuentes table;
 * WORKING branches (optional, via --working-branch) render in the Status block
 * MODE-INDEPENDENTLY. The legacy ProjectMode enum is kept for back-compat parsing
 * only and is slated for removal in a later cleanup.
 */
export async function runWorkspaceInit(
  fs: FileSystemPort,
  env: EnvPort,
  paths: PathsService,
  input: WorkspaceInitInput,
): Promise<WorkspaceInitResult | WorkspaceInitInputError> {
  const validation = validateInput(input);
  if (validation) return validation;

  const workspace = input.workspace ? resolve(input.workspace) : resolve(env.cwd());
  const proyecto =
    input.proyecto && input.proyecto.trim().length > 0
      ? input.proyecto.trim()
      : basename(workspace);
  const mainBranch = input.mainBranch ?? DEFAULT_MAIN_BRANCH;

  if (input.dryRun) {
    return {
      ok: true,
      dry_run: true,
      workspace,
      sources: input.sources.length,
      scaffold: { created: plannedScaffold(workspace, paths.namespace), existing: [] },
      skills_toml: "created",
      project_md: { ok: true, action: "init" },
      attach_multiroot:
        input.sources.length > 1
          ? { skipped: true, reason: "dry_run" }
          : { skipped: true, reason: "single_source" },
    };
  }

  // Everything is scoped to `workspace` (which may differ from the process cwd).
  const targetEnv = workspace !== resolve(env.cwd()) ? overrideCwd(env, workspace) : env;
  const wsPaths = new PathsService(paths.namespace, env.homeDir(), workspace);

  const scaffold = await scaffoldDirs(fs, workspace, wsPaths);
  const skillsToml = await seedSkillsToml(fs, wsPaths);

  // Capture the previous block's sources before overwriting, to detach removed ones.
  const previousPaths = await readBlockSourcePaths(fs, workspace, wsPaths);

  const projectMd = await runProjectMdUpsertWrite(fs, targetEnv, wsPaths, {
    op: "init",
    // mode "project" → block without `Mode:` line; Fuentes table holds N sources.
    // Working branches render MODE-INDEPENDENTLY (a kept workspace property).
    mode: "project",
    proyecto,
    fuentes: input.sources.map((s) => ({
      alias: s.alias,
      path: s.path,
      ...(s.mainBranch !== undefined ? { mainBranch: s.mainBranch } : {}),
    })),
    // Declared set is authoritative (supports removing a source by re-running).
    replaceFuentes: true,
    mainBranch,
    ...(input.workingBranches !== undefined ? { workingBranches: input.workingBranches } : {}),
    verbose: true,
    ...(input.lastActivity !== undefined ? { lastActivity: input.lastActivity } : {}),
  });

  if ("error" in projectMd) {
    return {
      ok: false,
      dry_run: false,
      workspace,
      sources: input.sources.length,
      scaffold,
      skills_toml: skillsToml,
      project_md: projectMd,
      attach_multiroot: { skipped: true, reason: "project_md_failed" },
    };
  }

  // Multi-root visibility only matters with 2+ sources. Single source → no-op.
  const visibility = await reconcileVisibility(
    fs,
    targetEnv,
    wsPaths,
    workspace,
    input.sources,
    previousPaths,
  );

  return {
    ok: projectMd.ok && visibility.ok,
    dry_run: false,
    workspace,
    sources: input.sources.length,
    scaffold,
    skills_toml: skillsToml,
    project_md: projectMd,
    attach_multiroot: visibility.attach,
    ...(visibility.detached !== undefined ? { detached_removed: visibility.detached } : {}),
  };
}

function plannedScaffold(workspace: string, ns: string): string[] {
  const out = [join(workspace, `.${ns}`, "sessions")];
  for (const f of DOCS_FOLDERS) out.push(join(workspace, "docs", f));
  return out;
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
  if (sources.length <= 1) {
    return { ok: true, attach: { skipped: true, reason: "single_source" } };
  }

  const currentNorm = new Set(sources.map((s) => normalizePath(s.path)));
  const removed = previousPaths.filter((p) => !currentNorm.has(normalizePath(p)));
  const detached =
    removed.length > 0
      ? await runMultiroot(fs, env, wsPaths, "detach", { paths: removed, workspace })
      : undefined;

  const attach = await runMultiroot(fs, env, wsPaths, "attach", { fromSources: true, workspace });
  await ensureVisibilityGitignore(fs, workspace);

  return {
    ok: !("error" in attach),
    attach,
    ...(detached !== undefined ? { detached } : {}),
  };
}

function overrideCwd(env: EnvPort, cwd: string): EnvPort {
  return {
    get: (k) => env.get(k),
    homeDir: () => env.homeDir(),
    cwd: () => cwd,
  };
}

/** Source paths declared in the current block (before it is rewritten). */
async function readBlockSourcePaths(
  fs: FileSystemPort,
  workspace: string,
  paths: PathsService,
): Promise<string[]> {
  const markers = paths.blockMarkers();
  for (const fname of ["CLAUDE.md", "AGENTS.md"]) {
    const file = join(workspace, fname);
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), markers);
    if (block && block.fuentes.length > 0) {
      return block.fuentes.map((f) => f.path).filter((p) => p.length > 0);
    }
  }
  return [];
}

/** Ensure the workspace `.gitignore` ignores the visibility files (idempotent). */
async function ensureVisibilityGitignore(fs: FileSystemPort, workspace: string): Promise<void> {
  const file = join(workspace, ".gitignore");
  const existing = (await fs.exists(file)) ? await fs.readText(file) : "";
  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0),
  );
  const missing = VISIBILITY_GITIGNORE.filter((e) => !present.has(e));
  if (missing.length === 0) return;
  const block = `# Multi-root visibility (machine-specific paths — do not commit)\n${missing.join("\n")}\n`;
  const body = existing.replace(/\s+$/, "");
  await fs.writeText(file, body.length === 0 ? block : `${body}\n\n${block}`);
}

function validateInput(input: WorkspaceInitInput): WorkspaceInitInputError | null {
  if (!input.sources || input.sources.length < 1) {
    return {
      error: "no_sources",
      hint: "workspace-init requiere al menos 1 fuente (--source alias:path[:rama])",
    };
  }
  const aliases = new Set<string>();
  for (const s of input.sources) {
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
