// Data layer for the TUI's WORKSPACE tab.
//
// Aggregates the workspace information the user needs without opening any AI
// host. No project/hub distinction: a workspace simply has 1+ sources.
// Purely read-only: no side effects on disk or on the remote.

import { basename, join } from "node:path";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort } from "../ports/git.js";
import type { ProcessPort } from "../ports/process.js";
import { type ParsedProjectBlock, parseProjectBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { type ProcessRecord, ProcessRegistryService } from "./process-registry-service.js";
import { detectLaunchDescriptor } from "./source-launch-scripts-service.js";

export interface ProjectGitData {
  branch: string;
  base: string;
  ahead: number;
  behind: number;
  dirty: number;
  staged: number;
  untracked: number;
  lastCommit: ProjectCommit | null;
}

export interface ProjectCommit {
  sha: string;
  title: string;
  author: string;
  /** ISO 8601 */
  whenIso: string;
  /** Human-readable relative text, e.g. "hace 2 h" */
  whenRel: string;
}

export interface ProjectBranch {
  name: string;
  current: boolean;
  ahead: number;
  /** Human-readable relative text of the last commit */
  whenRel: string | null;
}

export interface ProjectSource {
  alias: string;
  path: string;
  branch: string | null;
  mainBranch: string;
  dirty: boolean;
  changedFiles: number;
  /** True when a launch descriptor (.workflow/launch/<alias>/launch.json) exists with a command. */
  launchable: boolean;
}

export interface ProjectTabData {
  workspaceName: string;
  /** Absolute workspace path (cwd) */
  workspacePath: string;
  /**
   * True when the workspace has a WORKSPACE block in CLAUDE.md/AGENTS.md
   * (i.e. it was initialized with workspace-init).
   *
   * When false, the tab renders a landing with the init option instead of
   * the full content.
   */
  initialized: boolean;
  /** Git data for the primary repo (cwd, or the first declared source) */
  git: ProjectGitData | null;
  /** Recent branches sorted by last-commit-date desc */
  branches: ProjectBranch[];
  /** Declared sources (alias / path / main branch) */
  sources: ProjectSource[];
  /** Current working branches per source alias (WORKSPACE block > Status) */
  workingBranches: Record<string, string>;
  /** Current QA branches per source alias (WORKSPACE block > Status > Ramas QA) */
  qaBranches: Record<string, string>;
  /** Procesos lanzados en segundo plano (registry reconciliado contra liveness). */
  processes: ProcessRecord[];
  /** Partial fetch failures, if any */
  warnings: string[];
}

interface BuildOptions {
  /** Maximum number of branches to list (default 5) */
  branchLimit?: number;
}

export interface ProjectTabDataDeps {
  fs: FileSystemPort;
  env: EnvPort;
  git: GitPort;
  process: ProcessPort;
  paths: PathsService;
}

/**
 * Builds all the Workspace tab data in one pass.
 *
 * Each subfetch catches its own errors so the render never goes down — if
 * e.g. `git log` fails, the rest of the payload stays valid and the failure
 * lands in `warnings[]`.
 */
export async function buildProjectTabData(
  deps: ProjectTabDataDeps,
  options: BuildOptions = {},
): Promise<ProjectTabData> {
  const { fs, env, git, process: proc, paths } = deps;
  const cwd = env.cwd();
  const warnings: string[] = [];

  const block = await safeRun(
    "read-project-block",
    () => readProjectBlock(fs, cwd, paths),
    warnings,
    null as ParsedProjectBlock | null,
  );

  const workspaceName = block?.proyecto || basename(cwd);

  // Primary repo: the first declared source (if any), else the cwd.
  const primaryRepoPath = block && block.fuentes.length > 0 ? (block.fuentes[0]?.path ?? cwd) : cwd;
  const primaryMainBranch =
    block && block.fuentes.length > 0 ? (block.fuentes[0]?.main_branch ?? "main") : "main";
  // The GIT tile must show the working branch DEFINED in the workspace for the
  // primary source, not whatever branch the repo has checked out (could be any).
  const definedWorkingBranch = resolveDefinedWorkingBranch(block);

  const gitData = await safeRun(
    "git",
    () => buildGitData(git, proc, primaryRepoPath, primaryMainBranch, definedWorkingBranch),
    warnings,
    null,
  );

  const branches = await safeRun(
    "branches",
    () => buildBranches(proc, primaryRepoPath, options.branchLimit ?? 5),
    warnings,
    [] as ProjectBranch[],
  );

  const sources: ProjectSource[] = [];
  if (block) {
    for (const f of block.fuentes) {
      const repoPath = f.path;
      const isRepo = await safeRun(
        `is-repo:${f.alias}`,
        () => git.isGitRepo(repoPath),
        warnings,
        false,
      );
      if (!isRepo) continue;
      const branch = await safeRun(
        `branch:${f.alias}`,
        () => git.currentBranch(repoPath),
        warnings,
        undefined,
      );
      const changed = await safeRun(
        `dirty:${f.alias}`,
        () => git.changedFiles(repoPath),
        warnings,
        [] as string[],
      );
      const launchable = await safeRun(
        `launchable:${f.alias}`,
        () => readLaunchable(fs, paths.cwdLaunchDir(), f.alias, f.path),
        warnings,
        false,
      );
      sources.push({
        alias: f.alias,
        path: f.path,
        branch: branch ?? null,
        mainBranch: f.main_branch,
        dirty: changed.length > 0,
        changedFiles: changed.length,
        launchable,
      });
    }
  }

  // Background processes — the registry reconciles liveness in list().
  const registry = new ProcessRegistryService(fs, proc, paths.cwdProcessesFile());
  const processes = await safeRun(
    "processes",
    () => registry.list(),
    warnings,
    [] as ProcessRecord[],
  );

  return {
    workspaceName,
    workspacePath: cwd,
    initialized: block !== null,
    git: gitData,
    branches,
    sources,
    workingBranches: block?.working_branches ?? {},
    qaBranches: block?.qa_branches ?? {},
    processes,
    warnings,
  };
}

/**
 * True when the source can be launched: its descriptor declares a command, or —
 * without one (minimal init defers generation to the first launch; legacy
 * pregenerated descriptors may carry command:null; corrupt files count as
 * missing) — the stack detected from the source path is launchable. Mirrors
 * ensureDescriptor: activating the action regenerates/diagnoses precisely.
 */
async function readLaunchable(
  fs: FileSystemPort,
  launchDir: string,
  alias: string,
  sourcePath: string,
): Promise<boolean> {
  const file = join(launchDir, alias, "launch.json");
  if (await fs.exists(file)) {
    try {
      const desc = JSON.parse(await fs.readText(file)) as { command?: unknown };
      if (typeof desc.command === "string" && desc.command.length > 0) return true;
    } catch {
      // corrupt → fall through to stack detection (beginLaunch will diagnose)
    }
  }
  if (!(await fs.exists(sourcePath))) return false;
  try {
    return (await detectLaunchDescriptor(fs, sourcePath, alias)).command !== null;
  } catch {
    return false;
  }
}

// ---------- subfetchers ----------

async function buildGitData(
  git: GitPort,
  proc: ProcessPort,
  repoPath: string,
  mainBranch: string,
  workBranch?: string,
): Promise<ProjectGitData | null> {
  const isRepo = await git.isGitRepo(repoPath);
  if (!isRepo) return null;
  // `workBranch` (the workspace-defined working branch) takes precedence over
  // the checked-out branch: the GIT tile represents the workspace's work, not
  // the source's accidental HEAD. ahead/behind is computed against the branch shown.
  const branch = workBranch ?? (await git.currentBranch(repoPath)) ?? "(detached)";

  // ahead/behind vs `origin/<mainBranch>` — falls back to 0/0 on failure
  const aheadBehind = await runProc(
    proc,
    "git",
    ["rev-list", "--left-right", "--count", `origin/${mainBranch}...${branch}`],
    repoPath,
  );
  let ahead = 0;
  let behind = 0;
  if (aheadBehind.ok && aheadBehind.stdout) {
    const parts = aheadBehind.stdout.trim().split(/\s+/);
    behind = Number.parseInt(parts[0] ?? "0", 10) || 0;
    ahead = Number.parseInt(parts[1] ?? "0", 10) || 0;
  }

  const status = await runProc(proc, "git", ["status", "--porcelain=v1"], repoPath);
  let dirty = 0;
  let staged = 0;
  let untracked = 0;
  if (status.ok) {
    for (const line of status.stdout.split("\n")) {
      if (line.length === 0) continue;
      const x = line[0];
      const y = line[1];
      if (x === "?" && y === "?") {
        untracked++;
      } else {
        dirty++;
        if (x !== " " && x !== "?") staged++;
      }
    }
  }

  const last = await runProc(
    proc,
    "git",
    ["log", "-1", "--pretty=%H%x09%s%x09%an%x09%aI%x09%ar"],
    repoPath,
  );
  let lastCommit: ProjectCommit | null = null;
  if (last.ok && last.stdout) {
    const parts = last.stdout.trim().split("\t");
    if (parts.length >= 5 && parts[0] && parts[1] && parts[2] && parts[3] && parts[4]) {
      lastCommit = {
        sha: parts[0].slice(0, 7),
        title: parts[1],
        author: parts[2],
        whenIso: parts[3],
        whenRel: parts[4],
      };
    }
  }

  return {
    branch,
    base: mainBranch,
    ahead,
    behind,
    dirty,
    staged,
    untracked,
    lastCommit,
  };
}

async function buildBranches(
  proc: ProcessPort,
  repoPath: string,
  limit: number,
): Promise<ProjectBranch[]> {
  const out = await runProc(
    proc,
    "git",
    [
      "for-each-ref",
      `--count=${limit + 4}`,
      "--sort=-committerdate",
      "--format=%(HEAD)%09%(refname:short)%09%(committerdate:iso8601)%09%(committerdate:relative)",
      "refs/heads",
    ],
    repoPath,
  );
  if (!out.ok) return [];
  const branches: ProjectBranch[] = [];
  for (const line of out.stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const head = parts[0]?.trim() === "*";
    const name = parts[1]?.trim() ?? "";
    const whenRel = parts[3]?.trim() ?? null;
    if (!name) continue;
    branches.push({ name, current: head, ahead: 0, whenRel });
    if (branches.length >= limit) break;
  }
  return branches;
}

// ---------- utils ----------

async function safeRun<T>(
  label: string,
  fn: () => Promise<T>,
  warnings: string[],
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    warnings.push(`${label}: ${(err as Error).message}`);
    return fallback;
  }
}

async function runProc(
  proc: ProcessPort,
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const res = await proc.run(cmd, args, { cwd });
  return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Working branch to display in the GIT tile.
 *
 * The tile represents the primary repo (`fuentes[0]`), but its label must be
 * the working branch DEFINED in the workspace (section `## Status > Ramas de
 * trabajo actuales`), not the branch the source has checked out. That way the
 * tile does not change depending on which branch the sources are on.
 *
 * Returns `undefined` when no working branch is declared for the primary
 * source → the caller falls back to the repo's current branch.
 */
export function resolveDefinedWorkingBranch(block: ParsedProjectBlock | null): string | undefined {
  if (!block) return undefined;
  const primaryAlias = block.fuentes[0]?.alias;
  if (primaryAlias === undefined) return undefined;
  return block.working_branches[primaryAlias];
}

// Local helper — mirrors the private `readProjectBlock` in sources-service.ts.
async function readProjectBlock(
  fs: FileSystemPort,
  cwd: string,
  paths: PathsService,
): Promise<ParsedProjectBlock | null> {
  for (const file of [join(cwd, "CLAUDE.md"), join(cwd, "AGENTS.md")]) {
    if (!(await fs.exists(file))) continue;
    const block = parseProjectBlock(await fs.readText(file), paths.blockMarkers());
    if (block) return block;
  }
  return null;
}
