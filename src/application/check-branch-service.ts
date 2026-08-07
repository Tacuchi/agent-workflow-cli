import {
  parseUnitPath,
  unitBranch,
  workspaceKey as workspaceKeyOf,
} from "../domain/isolation-unit.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort, WorktreeEntry } from "../ports/git.js";
import { expectedWorkBranch, findOwningSource } from "./branch-resolver.js";
import { normalizePath } from "./multiroot/paths.js";
import { type ProjectFuente, readWorkspaceBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { resolveSessionTarget } from "./session-resolver.js";

export interface CheckBranchInput {
  alias?: string;
  pathArg?: string;
  fileArg?: string;
  sessionCode?: string;
  /** Conversation identity, when the caller has one (hook payload / env var). */
  contextId?: string;
}

/** An isolation unit, as the branch check reports it. */
export interface UnitRef {
  session: string;
  path: string;
  branch: string;
}

export interface CheckBranchOutput {
  match: boolean;
  reason?: string;
  alias?: string;
  path?: string;
  current_branch?: string | null;
  expected_work_branch?: string | null;
  dirty?: boolean | null;
  changed_files?: string[];
  is_repo?: boolean;
  error?: string | null;
  /** Base branch DECLARED for the source; null when the Fuentes cell is empty. */
  main_branch?: string | null;
  session_code?: string | null;
  work_branch?: string | null;
  /** The unit the checked file actually falls in; null when it is the checkout. */
  actual_unit?: UnitRef | null;
  /** The unit this flow is expected to edit in; null when none applies. */
  expected_unit?: UnitRef | null;
  /** The exact command that obtains the expected unit, when one is missing. */
  remedy?: string | null;
}

export async function runCheckBranch(
  fs: FileSystemPort,
  env: EnvPort,
  git: GitPort,
  paths: PathsService,
  input: CheckBranchInput,
): Promise<CheckBranchOutput> {
  const cwd = env.cwd();
  const block = await readWorkspaceBlock(fs, cwd, paths.blockMarkers());
  const sources = block?.fuentes ?? [];
  if (sources.length === 0) {
    return { match: true, reason: "no_sources_declared" };
  }

  const unitsRoot = await fs.realPath(paths.userUnitsDir());
  const target = resolveTarget(sources, input, unitsRoot);
  if (!target) {
    return { match: true, reason: "file_not_in_managed_source" };
  }

  // The isolation verdict comes FIRST, and only when the source actually has
  // units: with none, nobody is running isolated and the check is exactly the
  // one this workspace had before the feature existed.
  const units = await unitsOf(git, paths, unitsRoot, target);
  if (units.length > 0) {
    return unitVerdict(fs, paths, unitsRoot, target, units, input);
  }

  // Expected work branch comes from the WORKSPACE block working_branches for the
  // owning source. Decoupled from sessions/flow.
  const expected = expectedWorkBranch(target, block?.working_branches ?? {});

  if (expected === null) {
    return {
      match: true,
      reason: "no_expected_branch_declared",
      alias: target.alias,
      path: target.path,
    };
  }

  // Live git status
  if (!(await fs.exists(target.path))) {
    return {
      ...target,
      match: false,
      expected_work_branch: expected,
      current_branch: null,
      dirty: null,
      changed_files: [],
      is_repo: false,
      error: `Path does not exist: ${target.path}`,
      session_code: input.sessionCode ?? null,
      work_branch: expected,
    };
  }
  if (!(await git.isGitRepo(target.path))) {
    return {
      ...target,
      match: false,
      expected_work_branch: expected,
      current_branch: null,
      dirty: null,
      changed_files: [],
      is_repo: false,
      error: "Not a git repository",
      session_code: input.sessionCode ?? null,
      work_branch: expected,
    };
  }

  const current = (await git.currentBranch(target.path)) ?? null;
  const match = current === expected;
  return {
    ...target,
    expected_work_branch: expected,
    current_branch: current,
    match,
    ...(await treeState(git, target.path)),
    is_repo: true,
    error: null,
    session_code: input.sessionCode ?? null,
    work_branch: expected,
  };
}

/**
 * The verdict when the source HAS isolation units.
 *
 * Three answers, in the order that makes each one cheap to act on: the edit is
 * in this flow's unit (allowed, and its branch still verified), it is in another
 * flow's unit (blocked — that tree belongs to somebody else), or it is outside
 * every unit (blocked, with the command that gets one).
 */
async function unitVerdict(
  fs: FileSystemPort,
  paths: PathsService,
  unitsRoot: string,
  target: ProjectFuente,
  units: UnitRef[],
  input: CheckBranchInput,
): Promise<CheckBranchOutput> {
  const file = input.fileArg ?? input.pathArg ?? null;
  const actual = file === null ? null : (units.find((u) => inside(file, u.path)) ?? null);
  const session = await flowSession(fs, paths, input);
  const expected = session === null ? null : (units.find((u) => u.session === session) ?? null);

  const base = {
    alias: target.alias,
    path: target.path,
    session_code: session ?? input.sessionCode ?? null,
    actual_unit: actual,
    expected_unit: expected,
  };

  if (actual !== null) {
    // Inside a unit. When the conversation names a session, the unit has to be
    // that one: a flow editing another flow's tree is the collision the whole
    // feature exists to prevent, and it looks like ordinary work until it lands.
    if (session !== null && actual.session !== session) {
      return {
        ...base,
        match: false,
        reason: "other_session_unit",
        work_branch: actual.branch,
        remedy: `aw worktree ensure --source ${target.alias} --code ${session}`,
      };
    }
    return { ...base, match: true, reason: "inside_own_unit", work_branch: actual.branch };
  }

  // Outside every unit: the main checkout, while some flow is isolated there.
  const wanted = expected ?? unitFor(session, paths, unitsRoot, target.alias);
  return {
    ...base,
    match: false,
    reason: "outside_unit",
    expected_unit: wanted,
    work_branch: wanted?.branch ?? null,
    remedy:
      session === null
        ? `aw worktree ensure --source ${target.alias} --code <NNN>`
        : `aw worktree ensure --source ${target.alias} --code ${session}`,
  };
}

/** Units of `source` that belong to THIS workspace, read from git itself. */
async function unitsOf(
  git: GitPort,
  paths: PathsService,
  unitsRoot: string,
  source: ProjectFuente,
): Promise<UnitRef[]> {
  let trees: WorktreeEntry[];
  try {
    trees = await git.worktreeList(source.path);
  } catch {
    // A source whose trees cannot be listed answers "no units", which lands on
    // the pre-existing branch check — the conservative side: it never invents a
    // block out of a failed read.
    return [];
  }
  const key = paths.workspaceDir();
  const refs: UnitRef[] = [];
  for (const tree of trees) {
    if (tree.main) continue;
    const identity = parseUnitPath(unitsRoot, tree.path);
    if (identity === null || identity.alias !== source.alias) continue;
    if (identity.workspaceKey !== workspaceKeyOf(key)) continue;
    refs.push({
      session: identity.session,
      path: tree.path,
      branch: tree.branch ?? unitBranch(identity.session),
    });
  }
  return refs;
}

/**
 * The session this conversation is working as, or `null`.
 *
 * READ-ONLY on purpose (`bind: false`): a branch check runs on every edit, and a
 * check that wrote the conversation association would turn a verification into
 * a state change nobody asked for.
 */
async function flowSession(
  fs: FileSystemPort,
  paths: PathsService,
  input: CheckBranchInput,
): Promise<string | null> {
  if (input.sessionCode === undefined && input.contextId === undefined) return null;
  const resolution = await resolveSessionTarget(fs, paths, {
    ...(input.sessionCode !== undefined ? { code: input.sessionCode } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    bind: false,
  });
  return resolution.outcome === "resolved" ? resolution.session.folder : null;
}

function unitFor(
  session: string | null,
  paths: PathsService,
  unitsRoot: string,
  alias: string,
): UnitRef | null {
  if (session === null) return null;
  return {
    session,
    path: `${unitsRoot}/${workspaceKeyOf(paths.workspaceDir())}/${alias}/${session}`,
    branch: unitBranch(session),
  };
}

async function treeState(
  git: GitPort,
  repoPath: string,
): Promise<{ dirty: boolean; changed_files: string[] }> {
  let changed: string[] = [];
  try {
    changed = await git.changedFiles(repoPath);
  } catch {
    changed = [];
  }
  return { dirty: changed.length > 0, changed_files: changed };
}

function inside(file: string, dir: string): boolean {
  const f = normalizePath(file);
  const d = normalizePath(dir);
  return f === d || f.startsWith(`${d}/`);
}

function resolveTarget(
  sources: ProjectFuente[],
  input: CheckBranchInput,
  unitsRoot: string,
): ProjectFuente | null {
  if (input.alias) {
    return sources.find((s) => s.alias === input.alias) ?? null;
  }
  if (input.pathArg) {
    return (
      sources.find((s) => s.path === input.pathArg) ??
      findOwningSource(sources, input.pathArg, unitsRoot)
    );
  }
  if (input.fileArg) {
    return findOwningSource(sources, input.fileArg, unitsRoot);
  }
  return null;
}
