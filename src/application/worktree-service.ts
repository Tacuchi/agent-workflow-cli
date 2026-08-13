import { dirname, join } from "node:path";
import {
  type UnitIdentity,
  parseUnitPath,
  unitBranch,
  unitPath,
  workspaceKey,
} from "../domain/isolation-unit.js";
import type { EnvPort } from "../ports/env.js";
import type { FileSystemPort } from "../ports/file-system.js";
import type { GitPort, WorktreeEntry } from "../ports/git.js";
import { resolveSourceBranches } from "./branch-resolver.js";
import { locateRun, readRun } from "./flow/run-state-service.js";
import { withCwdLock } from "./lock-service.js";
import { runMultiroot } from "./multiroot-service.js";
import { normalizePath } from "./multiroot/paths.js";
import { type ProjectFuente, readWorkspaceBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import {
  type SessionResolutionError,
  listSessionFolders,
  resolveSessionTarget,
} from "./session-resolver.js";

/**
 * How long an integration waits for the workspace lock before giving up.
 *
 * Longer than the registry's and the claim's, because what is behind this lock is
 * a merge: the wait is bounded by another merge finishing, not by a file write.
 */
const INTEGRATE_LOCK_WAIT_MS = 10_000;

/**
 * Lifecycle of a flow's isolation unit: obtain one, see the live ones, give one
 * back.
 *
 * The convention in `domain/isolation-unit` says where a unit lives; this
 * service is what materializes it against a real repository and the host's
 * multi-root visibility. It writes no registry — every answer here is read back
 * out of `git worktree list` and the sessions folder.
 */

export interface IsolationUnit {
  alias: string;
  /** The source repository the unit was cut from. */
  source_path: string;
  session: string;
  /** Absolute path of the unit's working tree. */
  path: string;
  branch: string;
  /** True when this call created it; false when it already existed. */
  created: boolean;
}

export interface OrphanUnit {
  alias: string;
  session: string;
  path: string;
  branch: string | null;
  /** Why it is reported: its session is closed or gone, or its directory vanished. */
  reason: "session_closed" | "session_absent" | "directory_missing";
  /** The command that gives it back. */
  release: string;
}

export interface WorktreeError {
  error: string;
  message: string;
  hint?: string;
  /** Present on `unit_occupied`: who is holding the unit right now. */
  occupant?: { path: string; branch: string };
}

export type WorktreeEnsureOutput = IsolationUnit & { visibility: "attached" | "unavailable" };

/**
 * One live unit as the list reports it: what it is, plus what its tree is doing.
 *
 * `dirty` and `head` are the two facts a branch or commit boundary needs and the
 * ones no other reading of this workspace can supply — `aw sources` answers them
 * about the shared checkout, which under isolation is precisely the tree the flow
 * does NOT edit. `null` on either means the read failed, never "clean" and never
 * "no commit": a tree nobody could stat must not pass as a tree with nothing
 * pending.
 */
export type ListedUnit = IsolationUnit & {
  session_active: boolean;
  dirty: boolean | null;
  head: string | null;
};

export interface WorktreeListOutput {
  workspace_key: string;
  units: ListedUnit[];
  orphans: OrphanUnit[];
  /** Sources whose worktrees could not be read; their units are NOT in the lists. */
  unreadable: Array<{ alias: string; error: string }>;
  /** The session the list was narrowed to, when the caller named one. */
  session?: string;
}

export interface WorktreeReleaseOutput {
  alias: string;
  session: string;
  path: string;
  branch: string;
  released: boolean;
  visibility: "detached" | "unavailable";
}

export interface WorktreeDeps {
  fs: FileSystemPort;
  env: EnvPort;
  git: GitPort;
  paths: PathsService;
}

export interface WorktreeIntegrateOutput {
  alias: string;
  /** The repository the merge landed in — what `aw fix-git --path` needs. */
  source_path: string;
  session: string;
  /** Branch the unit's work was merged INTO. */
  into: string;
  branch: string;
  integrated: boolean;
  /** Files left in conflict; empty on a clean integration. */
  conflicted: string[];
  /** Whether the unit was given back — a conflicted merge keeps it. */
  released: boolean;
  /** What to run next: resolve the conflict, or nothing. */
  next: string | null;
}

/**
 * Every unit of one session, integrated one by one over the live branch.
 *
 * This is the form the directed run invokes, and the reason it exists is that a
 * run scopes SOURCES, not a source: naming one alias per call would make the
 * journey's integration boundary either wrong for a two-source plan or a
 * placeholder the engine cannot fill. Alias order is the order, so two readings
 * of the same session report the same sequence.
 *
 * Nothing is aborted by a neighbour: each entry is its own merge into its own
 * repository, so a conflict in one alias must not hide whether the others landed
 * — the receipt is the whole set, and `pending` is what is left to act on.
 */
export interface WorktreeIntegrateSessionOutput {
  session: string;
  /**
   * The plan this session's run executes, or `null` when it has no flow state.
   *
   * It is here because a conflict is read by a person who has two flows open: the
   * files and the branch say WHERE the merge stopped, and only this says which
   * piece of work it was.
   */
  plan: string | null;
  /** One entry per unit, in alias order: the merge, or why it was refused. */
  results: Array<WorktreeIntegrateOutput | (WorktreeError & { alias: string })>;
  /** Aliases whose work is on the working branch and whose unit was given back. */
  integrated: string[];
  /** Aliases still holding a unit: conflicted, or refused before merging. */
  pending: string[];
  /** What to run for the first pending alias; `null` when nothing is pending. */
  next: string | null;
}

export interface WorktreeInput {
  action: "ensure" | "list" | "release" | "integrate";
  alias?: string;
  sessionCode?: string;
  contextId?: string;
}

export type WorktreeOutput =
  | WorktreeEnsureOutput
  | WorktreeListOutput
  | WorktreeReleaseOutput
  | WorktreeIntegrateOutput
  | WorktreeIntegrateSessionOutput
  | WorktreeError;

export async function runWorktree(
  deps: WorktreeDeps,
  input: WorktreeInput,
): Promise<WorktreeOutput> {
  if (input.action === "list") return listUnits(deps, input);
  // Integrating without naming a source is not a missing argument: it is the
  // whole session, which is what a run holds and what a close has to answer for.
  if (input.action === "integrate" && input.alias === undefined) {
    return integrateSession(deps, input);
  }
  const target = await resolveTarget(deps, input);
  if ("error" in target) return target;
  if (input.action === "ensure") return ensureUnit(deps, target);
  if (input.action === "integrate") return integrateUnit(deps, target);
  return releaseUnit(deps, target);
}

/**
 * Integrate every unit the session holds, in alias order.
 *
 * The session is resolved ONCE and each alias goes through the same single-unit
 * path, so what a person gets running the command per source and what the run
 * gets from one call are the same merges in the same order.
 */
async function integrateSession(
  deps: WorktreeDeps,
  input: WorktreeInput,
): Promise<WorktreeIntegrateSessionOutput | WorktreeError> {
  const resolution = await resolveSessionTarget(deps.fs, deps.paths, {
    ...(input.sessionCode !== undefined ? { code: input.sessionCode } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
  });
  if (resolution.outcome !== "resolved") return sessionRefusal(resolution);
  const session = resolution.session.folder;
  const listed = await listUnits(deps, { action: "list" });
  if ("error" in listed) return listed;
  const mine = listed.units.filter((unit) => unit.session === session);
  const results: WorktreeIntegrateSessionOutput["results"] = [];
  const integrated: string[] = [];
  const pending: string[] = [];
  let next: string | null = null;
  for (const unit of [...mine].sort((a, b) => a.alias.localeCompare(b.alias))) {
    const target = await resolveTarget(deps, { ...input, alias: unit.alias });
    const result = "error" in target ? target : await integrateUnit(deps, target);
    if ("error" in result) {
      results.push({ ...result, alias: unit.alias });
      pending.push(unit.alias);
      next ??= `aw worktree integrate --source ${unit.alias} --code ${session}`;
      continue;
    }
    results.push(result);
    if (result.integrated) integrated.push(unit.alias);
    else {
      pending.push(unit.alias);
      next ??= result.next;
    }
  }
  return { session, plan: await planOf(deps, session), results, integrated, pending, next };
}

/** The plan the session's run declared, or `null` when there is no readable run. */
async function planOf(deps: WorktreeDeps, session: string): Promise<string | null> {
  const read = await readRun(deps.fs, locateRun(deps.paths, session));
  return read.ok ? (read.state.scope?.plan ?? null) : null;
}

/**
 * Merge the flow's branch into the source's declared working branch.
 *
 * **Merge and never rebase**, and the reason is not taste: the git port already
 * carries merge plus the three-stage conflict machinery `aw fix-git` reads, so a
 * conflict has somewhere to go. A rebase would need new primitives AND would
 * rewrite commits the flow already treated as done.
 *
 * The ORDER is whoever closes last, and that is what makes the second
 * integration start from what the first one left: the merge runs against the
 * live branch in the main checkout, not against a snapshot taken earlier.
 */
async function integrateUnit(
  deps: WorktreeDeps,
  target: ResolvedTarget,
): Promise<WorktreeIntegrateOutput | WorktreeError> {
  const { source, path, branch, base, identity } = target;
  if (!(await deps.git.isGitRepo(source.path))) {
    return {
      error: "not_a_repo",
      message: `${source.alias} (${source.path}) no es un repositorio git`,
    };
  }
  const units = await deps.git.worktreeList(source.path);
  if (!units.some((w) => samePath(w.path, path))) {
    return {
      error: "unit_absent",
      message: `${source.alias} no tiene una unidad para ${identity.session}`,
      hint: `creála con 'aw worktree ensure --source ${source.alias} --code ${identity.session}'`,
    };
  }

  // Both preconditions are refusals BEFORE anything moves: a merge started over
  // uncommitted work is the one state where "report the conflict" is no longer
  // enough, because the losing side was never recorded anywhere.
  if (await deps.git.isDirty(path)) {
    return {
      error: "unit_not_committed",
      message: `la unidad de ${identity.session} tiene cambios sin commitear`,
      hint: "commiteá el trabajo del flujo en su unidad antes de integrarlo",
    };
  }
  if (await deps.git.isDirty(source.path)) {
    return {
      error: "checkout_dirty",
      message: `el checkout principal de ${source.alias} tiene cambios sin commitear`,
      hint: "commiteá o guardá esos cambios: la integración no los va a mezclar con los del flujo",
    };
  }

  // Never switch the user's branch to make the command succeed. The declared
  // working branch is where the checkout is SUPPOSED to be — the git-safe
  // invariant says so — and a checkout that is somewhere else is a state the
  // person has to see, not one to be quietly corrected under a merge.
  const current = await deps.git.currentBranch(source.path);
  if (current !== base) {
    return {
      error: "checkout_off_branch",
      message: `el checkout principal de ${source.alias} está en '${current}' y la integración va a '${base}'`,
      hint: `posicioná el checkout en '${base}' y volvé a integrar; la integración nunca cambia de rama por su cuenta`,
    };
  }
  // The merge itself is the serialized part, and only it. Two runs integrating
  // into the same checkout would fight over one index and one MERGE_HEAD, and the
  // loser would find a repository mid-merge it never started. Waiting rather than
  // failing fast for the same reason a correlative claim waits: by the time this
  // lock is taken there is committed work with nowhere else to go, so losing the
  // race would lose real work instead of a retry.
  const merged = await withCwdLock(
    deps.fs,
    deps.paths,
    async () => {
      const merge = await deps.git.merge(source.path, branch);
      if (merge.ok) return { ok: true as const };
      return { ok: false as const, conflicted: merge.conflicted };
    },
    { waitMs: INTEGRATE_LOCK_WAIT_MS },
  );
  if ("error" in merged) {
    return {
      error: "integration_locked",
      message: `no se pudo serializar la integración de ${source.alias}: ${merged.error}`,
      hint: "esperá a que la otra integración termine y volvé a integrar; el merge no se empieza a medias",
    };
  }

  if (!merged.ok) {
    return {
      alias: source.alias,
      source_path: source.path,
      session: identity.session,
      into: base,
      branch,
      integrated: false,
      conflicted: merged.conflicted,
      // The unit SURVIVES a conflict: its commits are the only copy of one side
      // of the merge, and releasing it here would delete them to tidy up.
      released: false,
      next: `aw fix-git --path ${source.path}`,
    };
  }

  const release = await releaseUnit(deps, target);
  return {
    alias: source.alias,
    source_path: source.path,
    session: identity.session,
    into: base,
    branch,
    integrated: true,
    conflicted: [],
    released: "released" in release ? release.released : false,
    next: null,
  };
}

interface ResolvedTarget {
  source: ProjectFuente;
  identity: UnitIdentity;
  path: string;
  branch: string;
  /** Branch the unit is cut FROM: the source's declared working branch. */
  base: string;
}

async function resolveTarget(
  deps: WorktreeDeps,
  input: WorktreeInput,
): Promise<ResolvedTarget | WorktreeError> {
  const block = await readWorkspaceBlock(deps.fs, deps.env.cwd(), deps.paths.blockMarkers());
  const sources = block?.fuentes ?? [];
  if (sources.length === 0) {
    return {
      error: "no_sources_declared",
      message: "el bloque WORKSPACE no declara ninguna fuente",
      hint: "declará la fuente en la tabla Fuentes antes de pedir una unidad",
    };
  }
  if (input.alias === undefined) {
    return {
      error: "alias_required",
      message: "no se indicó sobre qué fuente se pide la unidad",
      hint: `usá --source con uno de: ${sources.map((s) => s.alias).join(", ")}`,
    };
  }
  const source = sources.find((s) => s.alias === input.alias);
  if (source === undefined) {
    return {
      error: "unknown_source",
      message: `'${input.alias}' no es una fuente declarada`,
      hint: `fuentes declaradas: ${sources.map((s) => s.alias).join(", ")}`,
    };
  }

  const resolution = await resolveSessionTarget(deps.fs, deps.paths, {
    ...(input.sessionCode !== undefined ? { code: input.sessionCode } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
  });
  if (resolution.outcome !== "resolved") return sessionRefusal(resolution);
  const session = resolution.session.folder;
  const identity: UnitIdentity = {
    workspaceKey: workspaceKey(deps.paths.workspaceDir()),
    alias: source.alias,
    session,
  };
  return {
    source,
    identity,
    path: unitPath(await canonicalUnitsRoot(deps), identity),
    branch: unitBranch(session),
    base: resolveSourceBranches(source, block).work,
  };
}

/**
 * A unit's session could not be resolved — said with the resolver's own words.
 *
 * The refusal used to be written here, and it flattened every reason into "pasá
 * --code <NNN>": useless advice to somebody who already passed one, and actively
 * wrong for the case this feature creates. A session that CLOSED still holding a
 * unit resolves to a refusal whose action is `aw session-resume --code <NNN>
 * --reopen` — the only move that gets the work merged — and rewriting it into a
 * generic hint is what turned the receipt's own remedy into a dead end.
 */
function sessionRefusal(resolution: SessionResolutionError): WorktreeError {
  return {
    error: "session_unresolved",
    message: `una unidad de aislamiento pertenece a una sesión: ${resolution.message}`,
    hint: resolution.action,
  };
}

/**
 * The units root in the OS's own spelling.
 *
 * Every comparison in this service is against a path GIT reported, and git
 * resolves symlinks. Building ours from a non-canonical root would make
 * `~/.workflow/worktrees/...` and the `/private/...` git answers with look like
 * two different directories: `ensure` would never recognize its own unit, see
 * its own branch as somebody else's, and refuse the flow its tree.
 */
async function canonicalUnitsRoot(deps: WorktreeDeps): Promise<string> {
  const root = deps.paths.userUnitsDir();
  await deps.fs.mkdirp(root);
  return deps.fs.realPath(root);
}

async function ensureUnit(
  deps: WorktreeDeps,
  target: ResolvedTarget,
): Promise<WorktreeEnsureOutput | WorktreeError> {
  const { source, path, branch, base } = target;
  if (!(await deps.git.isGitRepo(source.path))) {
    return {
      error: "not_a_repo",
      message: `${source.alias} (${source.path}) no es un repositorio git`,
    };
  }

  // Vanished directories keep holding their branch until git is told, so the
  // prune runs BEFORE the occupancy read — otherwise a unit whose folder the
  // user deleted by hand would look occupied forever.
  await deps.git.worktreePrune(source.path);
  const existing = await deps.git.worktreeList(source.path);

  const mine = existing.find((w) => samePath(w.path, path));
  if (mine !== undefined) {
    // Idempotent: the unit is already there, on its own branch.
    return { ...unitOf(target, false), visibility: await attach(deps, path) };
  }

  const occupant = existing.find((w) => w.branch === branch);
  if (occupant !== undefined) {
    return {
      error: "unit_occupied",
      message: `la rama ${branch} ya está tomada por otro árbol de ${source.alias}`,
      hint: "cerrá o liberá ese flujo, o usá la sesión que lo posee",
      occupant: { path: occupant.path, branch },
    };
  }

  await deps.fs.mkdirp(dirname(path));
  // An existing branch is checked out, not recreated: a flow that released its
  // unit and asks again must land back on its own commits, not on a fresh branch
  // that silently drops them.
  const from = (await deps.git.branchExists(source.path, branch)) ? null : base;
  try {
    await deps.git.worktreeAdd(source.path, path, branch, from);
  } catch (err) {
    return {
      error: "worktree_add_failed",
      message: (err as Error).message,
      hint: `verificá que la rama base '${base}' exista en ${source.alias}`,
    };
  }
  return { ...unitOf(target, true), visibility: await attach(deps, path) };
}

async function releaseUnit(
  deps: WorktreeDeps,
  target: ResolvedTarget,
): Promise<WorktreeReleaseOutput | WorktreeError> {
  const { source, path, branch, identity } = target;
  if (!(await deps.git.isGitRepo(source.path))) {
    return {
      error: "not_a_repo",
      message: `${source.alias} (${source.path}) no es un repositorio git`,
    };
  }
  const existing = await deps.git.worktreeList(source.path);
  if (!existing.some((w) => samePath(w.path, path))) {
    await deps.git.worktreePrune(source.path);
    return {
      alias: source.alias,
      session: identity.session,
      path,
      branch,
      released: false,
      visibility: await detach(deps, path),
    };
  }
  try {
    await deps.git.worktreeRemove(source.path, path);
  } catch (err) {
    return {
      error: "unit_not_clean",
      message: (err as Error).message,
      hint: "commiteá o descartá los cambios de la unidad y volvé a liberarla; nada se borra por la fuerza",
    };
  }
  return {
    alias: source.alias,
    session: identity.session,
    path,
    branch,
    released: true,
    visibility: await detach(deps, path),
  };
}

/**
 * The workspace's live units — every one of them, or only one session's.
 *
 * The filter is what makes this reading usable as a run's own evidence: a flow
 * asking "is my tree there, on my branch, with my work committed?" must not be
 * answered with somebody else's unit, and a list that always returned all of them
 * would leave that narrowing to whoever read the output. Naming a session that
 * cannot be resolved is REFUSED rather than widened back to everything.
 *
 * It narrows on an explicit `--code` and on nothing else. The conversation's own
 * binding is deliberately not consulted: this is also the inventory command that
 * surfaces orphans, and one that quietly showed only the caller's units would hide
 * exactly the trees nobody is going to come back for.
 */
async function listUnits(
  deps: WorktreeDeps,
  input: WorktreeInput,
): Promise<WorktreeListOutput | WorktreeError> {
  const narrowed = await narrowTo(deps, input.sessionCode);
  if (typeof narrowed !== "string" && narrowed !== null) return narrowed;
  const only = narrowed;

  const block = await readWorkspaceBlock(deps.fs, deps.env.cwd(), deps.paths.blockMarkers());
  const key = workspaceKey(deps.paths.workspaceDir());
  const root = await canonicalUnitsRoot(deps);
  const sessions = await sessionStates(deps);

  const units: ListedUnit[] = [];
  const orphans: OrphanUnit[] = [];
  const unreadable: WorktreeListOutput["unreadable"] = [];
  for (const source of block?.fuentes ?? []) {
    const scanned = await scanSource(deps, source, { root, key, only, sessions });
    if ("error" in scanned) {
      // Reported, never skipped in silence: a source whose trees cannot be read
      // would otherwise show up as "no units", which is the one answer that is
      // certainly wrong — its flows are exactly the ones nobody would clean up.
      unreadable.push({ alias: source.alias, error: scanned.error });
      continue;
    }
    units.push(...scanned.units);
    orphans.push(...scanned.orphans);
  }
  return {
    workspace_key: key,
    units,
    orphans,
    unreadable,
    ...(only !== null ? { session: only } : {}),
  };
}

/** What one source contributes to the list, or why its trees could not be read. */
async function scanSource(
  deps: WorktreeDeps,
  source: ProjectFuente,
  ctx: { root: string; key: string; only: string | null; sessions: SessionStates },
): Promise<{ units: ListedUnit[]; orphans: OrphanUnit[] } | { error: string }> {
  const empty = { units: [], orphans: [] };
  // Not a repo is not unreadable: it has no worktrees to report, and calling it
  // an error would put every non-git source in front of the reader forever.
  if (!(await deps.git.isGitRepo(source.path))) return empty;
  let trees: WorktreeEntry[];
  try {
    trees = await deps.git.worktreeList(source.path);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const units: ListedUnit[] = [];
  const orphans: OrphanUnit[] = [];
  for (const tree of trees) {
    const identity = tree.main ? null : parseUnitPath(ctx.root, tree.path);
    if (identity === null || identity.workspaceKey !== ctx.key) continue;
    if (ctx.only !== null && identity.session !== ctx.only) continue;
    const reason = orphanReason(identity.session, ctx.sessions, tree.prunable);
    if (reason === null) units.push(await liveUnit(deps, identity, source.path, tree));
    else orphans.push(orphanOf(identity, tree, reason));
  }
  return { units, orphans };
}

/**
 * The session folder the list is narrowed to: `null` for the whole workspace, or
 * the refusal when the caller named one nobody can resolve.
 */
async function narrowTo(
  deps: WorktreeDeps,
  code: string | undefined,
): Promise<string | null | WorktreeError> {
  if (code === undefined) return null;
  const resolution = await resolveSessionTarget(deps.fs, deps.paths, {
    code,
    allowClosed: true,
    bind: false,
  });
  if (resolution.outcome === "resolved") return resolution.session.folder;
  return {
    error: "session_unresolved",
    message: `se pidió la lista de '${code}' y no se pudo resolver esa sesión`,
    hint: "pasá --code <NNN> con la sesión del flujo",
  };
}

async function liveUnit(
  deps: WorktreeDeps,
  identity: UnitIdentity,
  sourcePath: string,
  tree: WorktreeEntry,
): Promise<ListedUnit> {
  return {
    alias: identity.alias,
    source_path: sourcePath,
    session: identity.session,
    path: tree.path,
    branch: tree.branch ?? unitBranch(identity.session),
    created: false,
    session_active: true,
    dirty: await treeDirty(deps, tree.path),
    head: tree.head,
  };
}

/** `null` when git could not answer — never the reassuring half of a boolean. */
async function treeDirty(deps: WorktreeDeps, path: string): Promise<boolean | null> {
  try {
    return await deps.git.isDirty(path);
  } catch {
    return null;
  }
}

function orphanOf(
  identity: UnitIdentity,
  tree: WorktreeEntry,
  reason: OrphanUnit["reason"],
): OrphanUnit {
  return {
    alias: identity.alias,
    session: identity.session,
    path: tree.path,
    branch: tree.branch,
    reason,
    release: `aw worktree release --source ${identity.alias} --code ${identity.session}`,
  };
}

interface SessionStates {
  known: Set<string>;
  active: Set<string>;
}

async function sessionStates(deps: WorktreeDeps): Promise<SessionStates> {
  const folders = await listSessionFolders(deps.fs, deps.paths.cwdSessionsDir());
  const active = new Set<string>();
  for (const folder of folders) {
    // `.closed` is the only source of a session's state (the session resolver's
    // own rule); re-deriving it from anything else would let the two disagree.
    if (!(await deps.fs.exists(join(folder.path, ".closed")))) active.add(folder.name);
  }
  return { known: new Set(folders.map((f) => f.name)), active };
}

/** Why a live worktree is no longer somebody's working unit — `null` when it still is. */
function orphanReason(
  session: string,
  sessions: SessionStates,
  prunable: boolean,
): OrphanUnit["reason"] | null {
  if (prunable) return "directory_missing";
  if (!sessions.known.has(session)) return "session_absent";
  if (!sessions.active.has(session)) return "session_closed";
  return null;
}

function unitOf(target: ResolvedTarget, created: boolean): IsolationUnit {
  return {
    alias: target.source.alias,
    source_path: target.source.path,
    session: target.identity.session,
    path: target.path,
    branch: target.branch,
    created,
  };
}

/**
 * Give the unit's root multi-root visibility, or say it could not be given.
 *
 * Units live outside every repository on purpose, so without this step the host
 * simply cannot open the files the flow is supposed to edit. A visibility
 * failure is reported, never swallowed: a unit nobody can see is not a usable
 * unit, and the caller has to know which of the two it got.
 */
async function attach(deps: WorktreeDeps, path: string): Promise<"attached" | "unavailable"> {
  const result = await runMultiroot(deps.fs, deps.env, deps.paths, "attach", { paths: [path] });
  return "error" in result ? "unavailable" : "attached";
}

async function detach(deps: WorktreeDeps, path: string): Promise<"detached" | "unavailable"> {
  const result = await runMultiroot(deps.fs, deps.env, deps.paths, "detach", { paths: [path] });
  return "error" in result ? "unavailable" : "detached";
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}
