import { basename, join, resolve } from "node:path";
import { BUILTIN_DEFAULT_SKILLS, SKILL_ROLES } from "../domain/skills.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import { DEFAULT_LOCK_TTL_MS, isExpired, parseLock } from "./lock-service.js";
import { type MultirootError, type MultirootResult, runMultiroot } from "./multiroot-service.js";
import { normalizePath } from "./multiroot/paths.js";
import { parseProjectBlock } from "./parsers/project-block.js";
import { PathsService } from "./paths-service.js";
import {
  type ProjectMdUpsertError,
  type ProjectMdUpsertOutput,
  runProjectMdUpsertWrite,
} from "./project-md-upsert-service.js";

/**
 * docs/ taxonomy owned by the workflow (one folder per category). NOT scaffolded
 * anymore: each folder is born on demand at the first numbered write
 * (`aw next-number docs/<cat>` mkdirps it). The list drives the reconcile prune.
 */
const DOCS_FOLDERS = ["specs", "plans", "manuals", "scripts", "diagrams", "reports"] as const;

/**
 * Visibility files (machine-specific absolute roots) — gitignored when external
 * sources exist. Trailing `*` also covers the timestamped `.bak.<epoch>` backups.
 * Exported for the code↔doctrine guard test (workspace-init.md documents the set).
 */
export const VISIBILITY_GITIGNORE = [".claude/settings.local.json*", ".codex/config.toml*"];

/**
 * Machine-local workflow artifacts — never committed. Sessions are the live log
 * (HISTORY.md is the durable, committable record); .lock/processes/launch/logs
 * are runtime. Exported for the code↔doctrine guard test.
 */
export function runtimeGitignoreEntries(ns: string): string[] {
  return [
    `.${ns}/sessions/`,
    `.${ns}/.lock`,
    `.${ns}/processes.json`,
    `.${ns}/launch/`,
    "docs/logs/",
  ];
}

/**
 * Migrate legacy per-source launch folders from `docs/tools/<x>/` to `.workflow/launch/<x>/`.
 * A legacy launch folder is identified by a `launch.json` carrying the generated
 * `_generated.sha256` marker — so creating-tools tool folders (a README, not a generated
 * launch.json) are never touched. Content is moved (preserving user-edited scripts); if the
 * destination already exists the legacy copy is just removed (superseded). Runs BEFORE
 * generation so moved edits survive the idempotent rewrite.
 */
async function isGeneratedLaunchFolder(fs: FileSystemPort, dir: string): Promise<boolean> {
  const file = join(dir, "launch.json");
  if (!(await fs.exists(file))) return false; // not a launch folder (e.g. a created tool)
  try {
    const parsed = JSON.parse(await fs.readText(file)) as { _generated?: { sha256?: string } };
    return typeof parsed._generated?.sha256 === "string"; // hand-authored → no marker → leave it
  } catch {
    return false;
  }
}

/** Copy every flat file from `src` to `dest`, preserving content (user-edited scripts survive). */
async function copyDirFiles(fs: FileSystemPort, src: string, dest: string): Promise<void> {
  await fs.mkdirp(dest);
  for (const f of await fs.list(src)) {
    if (f.type === "file") {
      await fs.writeText(join(dest, f.name), await fs.readText(join(src, f.name)));
    }
  }
}

async function migrateLegacyLaunchDirs(
  fs: FileSystemPort,
  docsToolsDir: string,
  launchDir: string,
): Promise<string[]> {
  if (!(await fs.exists(docsToolsDir))) return [];
  const migrated: string[] = [];
  for (const entry of await fs.list(docsToolsDir)) {
    if (entry.type !== "dir") continue;
    const legacyDir = join(docsToolsDir, entry.name);
    if (!(await isGeneratedLaunchFolder(fs, legacyDir))) continue;
    const dest = join(launchDir, entry.name);
    if (!(await fs.exists(dest))) await copyDirFiles(fs, legacyDir, dest);
    await fs.remove(legacyDir);
    migrated.push(entry.name);
  }
  return migrated;
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
  /** Reconcile: legacy upfront-scaffold leftovers removed on re-run (lazy model). */
  pruned: string[];
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
    return buildDryRunResult(fs, workspace, wsPaths, paths.namespace, sources);
  }

  // Everything is scoped to `workspace` (which may differ from the process cwd).
  const targetEnv = workspace !== resolve(env.cwd()) ? overrideCwd(env, workspace) : env;

  const scaffold = await scaffoldDirs(fs, workspace, wsPaths);
  const skillsToml = await seedSkillsToml(fs, wsPaths);
  // Machine-local workflow artifacts (sessions, lock, runtime) — gitignore always.
  await ensureRuntimeGitignore(fs, workspace, wsPaths.namespace);

  // Migrate legacy launch folders (docs/tools/<alias>/) to .workflow/launch/ so any
  // user-edited scripts survive. Launch artifacts themselves are NOT pregenerated
  // anymore: the launch flow regenerates them on demand at the first launch.
  await migrateLegacyLaunchDirs(fs, join(workspace, "docs", "tools"), wsPaths.cwdLaunchDir());

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

  // Last: the project-md upsert above just released its lock leaving the empty
  // marker — clean the leftover so init never ends with a stray .lock.
  scaffold.pruned.push(...(await pruneReleasedLock(fs, wsPaths)));

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
  };
}

/** Minimal activation scaffold: sessions/ is the operating-context marker. */
function plannedScaffold(workspace: string, ns: string): string[] {
  return [join(workspace, `.${ns}`, "sessions")];
}

async function buildDryRunResult(
  fs: FileSystemPort,
  workspace: string,
  wsPaths: PathsService,
  namespace: string,
  sources: WorkspaceSource[],
): Promise<WorkspaceInitResult> {
  const anyExternal = sources.some((s) => isExternalToWorkspace(s.path, workspace));
  // The prune preview is read-only but REAL: a re-run deletes git-tracked
  // .gitkeep files, so plan mode must show exactly what would be removed.
  const pruned = [
    ...(await pruneLegacyScaffold(fs, workspace, wsPaths, false)),
    ...(await pruneReleasedLock(fs, wsPaths, false)),
  ];
  return {
    ok: true,
    dry_run: true,
    workspace,
    sources: sources.length,
    scaffold: { created: plannedScaffold(workspace, namespace), existing: [], pruned },
    skills_toml: "created",
    project_md: { ok: true, action: "init" },
    attach_multiroot: anyExternal
      ? { skipped: true, reason: "dry_run" }
      : { skipped: true, reason: "no_external_sources" },
  };
}

/**
 * Minimal scaffold + reconcile. Creates only `.workflow/sessions/` (the marker that
 * activates the operating context); docs/<cat> folders are born on demand at the
 * first `aw next-number docs/<cat>`. On re-run it PRUNES the legacy upfront
 * scaffold: .gitkeep-only taxonomy dirs, stray .gitkeep files, an empty docs/logs
 * and an empty/expired `.workflow/.lock` leftover.
 */
async function scaffoldDirs(
  fs: FileSystemPort,
  workspace: string,
  wsPaths: PathsService,
): Promise<ScaffoldSummary> {
  const created: string[] = [];
  const existing: string[] = [];
  const sessionsDir = wsPaths.cwdSessionsDir();
  if (await fs.exists(sessionsDir)) {
    existing.push(sessionsDir);
  } else {
    await fs.mkdirp(sessionsDir);
    created.push(sessionsDir);
  }
  const pruned = await pruneLegacyScaffold(fs, workspace, wsPaths);
  return { created, existing, pruned };
}

/** True when the dir's only content is a `.gitkeep` (or nothing at all). */
async function isGitkeepOnly(fs: FileSystemPort, dir: string): Promise<boolean> {
  const entries = await fs.list(dir);
  return entries.every((e) => e.type === "file" && e.name === ".gitkeep");
}

/**
 * Legacy upfront-scaffold leftovers. With `apply=false` it only DETECTS (the
 * dry-run preview must show what a real run would delete — these are often
 * git-tracked files).
 */
async function pruneLegacyScaffold(
  fs: FileSystemPort,
  workspace: string,
  wsPaths: PathsService,
  apply = true,
): Promise<string[]> {
  const pruned: string[] = [];
  // Taxonomy dirs from the upfront-scaffold era: drop the empty ones, and the
  // now-meaningless .gitkeep inside the ones that already have content.
  for (const f of DOCS_FOLDERS) {
    const dir = join(workspace, "docs", f);
    if (!(await fs.exists(dir))) continue;
    if (await isGitkeepOnly(fs, dir)) {
      if (apply) await fs.remove(dir);
      pruned.push(dir);
      continue;
    }
    const keep = join(dir, ".gitkeep");
    if (await fs.exists(keep)) {
      if (apply) await fs.remove(keep);
      pruned.push(keep);
    }
  }
  // docs/logs: recreated on demand by the launch flow; drop it when empty.
  const logsDir = join(workspace, "docs", "logs");
  if ((await fs.exists(logsDir)) && (await fs.list(logsDir)).length === 0) {
    if (apply) await fs.remove(logsDir);
    pruned.push(logsDir);
  }
  // sessions/.gitkeep: pointless now that sessions/ is gitignored.
  const sessionsKeep = join(wsPaths.cwdSessionsDir(), ".gitkeep");
  if (await fs.exists(sessionsKeep)) {
    if (apply) await fs.remove(sessionsKeep);
    pruned.push(sessionsKeep);
  }
  return pruned;
}

/**
 * Remove a released/expired `.workflow/.lock` leftover. release() intentionally
 * leaves an empty marker file (lock-service protocol), so this must run at the
 * END of init — after the project-md upsert released its lock. A live lock
 * (non-empty, not expired) is never touched. Exported for direct unit tests of
 * the live-lock guard (unreachable through runWorkspaceInit: a busy lock makes
 * the upsert fail before this runs).
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

/**
 * Ensure the entries exist in the workspace `.gitignore` under the given header
 * (idempotent, block-aware): missing entries are inserted at the end of the
 * existing header's block — never as a second block with a duplicate header.
 * User lines are never touched; dedupe is per trimmed line across the whole file.
 */
async function appendGitignoreEntries(
  fs: FileSystemPort,
  workspace: string,
  header: string,
  entries: string[],
): Promise<void> {
  const file = join(workspace, ".gitignore");
  const existing = (await fs.exists(file)) ? await fs.readText(file) : "";
  const lines = existing.split(/\r?\n/);
  const present = new Set(lines.map((l) => l.trim()).filter((l) => l.length > 0));
  const missing = entries.filter((e) => !present.has(e));
  if (missing.length === 0) return;

  const headerIdx = lines.findIndex((l) => l.trim() === header);
  if (headerIdx >= 0) {
    // End of the header's block = last consecutive non-empty line after it.
    let end = headerIdx + 1;
    while (end < lines.length && (lines[end] ?? "").trim().length > 0) end++;
    lines.splice(end, 0, ...missing);
    // Preserve the file's dominant EOL: a CRLF .gitignore must not be rewritten
    // wholesale to LF (that would churn every user line in the diff).
    const eol = existing.includes("\r\n") ? "\r\n" : "\n";
    await fs.writeText(file, lines.join(eol));
    return;
  }
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
