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
import { runMultiroot } from "./multiroot-service.js";
import { normalizePath } from "./multiroot/paths.js";
import { type ProjectFuente, readWorkspaceBlock } from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { listSessionFolders, resolveSessionTarget } from "./session-resolver.js";

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

export interface WorktreeListOutput {
  workspace_key: string;
  units: Array<IsolationUnit & { session_active: boolean }>;
  orphans: OrphanUnit[];
  /** Sources whose worktrees could not be read; their units are NOT in the lists. */
  unreadable: Array<{ alias: string; error: string }>;
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
  | WorktreeError;

export async function runWorktree(
  deps: WorktreeDeps,
  input: WorktreeInput,
): Promise<WorktreeOutput> {
  if (input.action === "list") return listUnits(deps);
  const target = await resolveTarget(deps, input);
  if ("error" in target) return target;
  if (input.action === "ensure") return ensureUnit(deps, target);
  if (input.action === "integrate") return integrateUnit(deps, target);
  return releaseUnit(deps, target);
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
  const merge = await deps.git.merge(source.path, branch);

  if (!merge.ok) {
    return {
      alias: source.alias,
      session: identity.session,
      into: base,
      branch,
      integrated: false,
      conflicted: merge.conflicted,
      // The unit SURVIVES a conflict: its commits are the only copy of one side
      // of the merge, and releasing it here would delete them to tidy up.
      released: false,
      next: `aw fix-git --path ${source.path}`,
    };
  }

  const release = await releaseUnit(deps, target);
  return {
    alias: source.alias,
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
  if (resolution.outcome !== "resolved") {
    return {
      error: "session_unresolved",
      message: "una unidad de aislamiento pertenece a una sesión y no se pudo resolver cuál",
      hint: "pasá --code <NNN> con la sesión del flujo",
    };
  }
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

async function listUnits(deps: WorktreeDeps): Promise<WorktreeListOutput> {
  const block = await readWorkspaceBlock(deps.fs, deps.env.cwd(), deps.paths.blockMarkers());
  const key = workspaceKey(deps.paths.workspaceDir());
  const root = await canonicalUnitsRoot(deps);
  const sessions = await sessionStates(deps);

  const units: WorktreeListOutput["units"] = [];
  const orphans: OrphanUnit[] = [];
  const unreadable: WorktreeListOutput["unreadable"] = [];
  for (const source of block?.fuentes ?? []) {
    if (!(await deps.git.isGitRepo(source.path))) continue;
    let trees: WorktreeEntry[];
    try {
      trees = await deps.git.worktreeList(source.path);
    } catch (err) {
      // Reported, never skipped in silence: a source whose trees cannot be read
      // would otherwise show up as "no units", which is the one answer that is
      // certainly wrong — its flows are exactly the ones nobody would clean up.
      unreadable.push({ alias: source.alias, error: (err as Error).message });
      continue;
    }
    for (const tree of trees) {
      const identity = tree.main ? null : parseUnitPath(root, tree.path);
      if (identity === null || identity.workspaceKey !== key) continue;
      const reason = orphanReason(identity.session, sessions, tree.prunable);
      if (reason === null) units.push(liveUnit(identity, source.path, tree));
      else orphans.push(orphanOf(identity, tree, reason));
    }
  }
  return { workspace_key: key, units, orphans, unreadable };
}

function liveUnit(
  identity: UnitIdentity,
  sourcePath: string,
  tree: WorktreeEntry,
): WorktreeListOutput["units"][number] {
  return {
    alias: identity.alias,
    source_path: sourcePath,
    session: identity.session,
    path: tree.path,
    branch: tree.branch ?? unitBranch(identity.session),
    created: false,
    session_active: true,
  };
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
