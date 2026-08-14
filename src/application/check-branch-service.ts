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
 * Four answers, in the order that makes each one cheap to act on: the identity of
 * the flow could not be established at all (blocked — see below), the edit is in
 * this flow's unit (allowed, and its branch still verified), it is in another
 * flow's unit (blocked — that tree belongs to somebody else), or it is outside
 * every unit (blocked, with the command that gets one).
 *
 * The first answer is the one that fails CLOSED, and it is the whole point of the
 * order. An unresolved identity used to be indistinguishable from "no session
 * asked", both flattened to `null`, and a `null` identity let any unit answer
 * `inside_own_unit` — so the exact situation this feature exists for, two live
 * sessions and a conversation the resolver calls ambiguous, authorized editing
 * ANY of the trees. Not knowing whose tree it is is not permission to write in it.
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
  const identity = await flowSession(fs, paths, input);

  if (identity.kind !== "resolved") {
    return {
      alias: target.alias,
      path: target.path,
      session_code: input.sessionCode ?? null,
      actual_unit: actual,
      // There is no expected unit to name: which one it would be is precisely
      // what could not be resolved.
      expected_unit: null,
      match: false,
      reason: "unknown_identity",
      error: identity.reason,
      work_branch: actual?.branch ?? null,
      remedy: identity.action,
    };
  }

  const session = identity.session;
  const expected = units.find((u) => u.session === session) ?? null;
  const base = {
    alias: target.alias,
    path: target.path,
    session_code: session,
    actual_unit: actual,
    expected_unit: expected,
  };

  if (actual !== null) {
    // Inside a unit, and the conversation's session is known: the unit has to be
    // that one. A flow editing another flow's tree is the collision the whole
    // feature exists to prevent, and it looks like ordinary work until it lands.
    if (actual.session !== session) {
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
    work_branch: wanted.branch,
    remedy: `aw worktree ensure --source ${target.alias} --code ${session}`,
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

/** Who this conversation is working as — resolved, or why it could not be. */
type FlowIdentity =
  | { kind: "resolved"; session: string }
  | { kind: "unresolved"; reason: string; action: string };

/**
 * The session this conversation is working as.
 *
 * The whole precedence is walked, always — an explicit `--code`, then the
 * conversation's binding, then the sole active session — instead of giving up
 * when neither was passed. Giving up was what made a workspace with one session
 * and one with three answer the same thing, and the second is exactly where the
 * answer must not be "whatever tree you are in".
 *
 * READ-ONLY on purpose (`bind: false`): a branch check runs on every edit, and a
 * check that wrote the conversation association would turn a verification into a
 * state change nobody asked for.
 */
async function flowSession(
  fs: FileSystemPort,
  paths: PathsService,
  input: CheckBranchInput,
): Promise<FlowIdentity> {
  const resolution = await resolveSessionTarget(fs, paths, {
    ...(input.sessionCode !== undefined ? { code: input.sessionCode } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    bind: false,
  });
  if (resolution.outcome === "resolved") {
    return { kind: "resolved", session: resolution.session.folder };
  }
  return { kind: "unresolved", reason: resolution.message, action: resolution.action };
}

function unitFor(session: string, paths: PathsService, unitsRoot: string, alias: string): UnitRef {
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
