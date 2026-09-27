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
import { isWorkingBranch, resolveSourceBranches } from "./branch-resolver.js";
import { documentOfSession, resolveDocBranch } from "./doc-branch-ledger.js";
import { locateRun, readRun } from "./flow/run-state-service.js";
import { withCwdLock } from "./lock-service.js";
import { runMultiroot } from "./multiroot-service.js";
import { normalizePath } from "./multiroot/paths.js";
import {
  type ProjectFuente,
  readWorkspaceBlock,
  requireSourcePath,
} from "./parsers/project-block.js";
import type { PathsService } from "./paths-service.js";
import { recordIntegration, recordUnitTaken } from "./session-custody-recorder.js";
import { readCustody } from "./session-custody-service.js";
import {
  type SessionResolutionError,
  listSessionFolders,
  resolveSessionTarget,
  sessionFolderMatches,
} from "./session-resolver.js";
import {
  type UnitDependencyState,
  linkUnitDependencies,
  removeUnitSafely,
} from "./unit-dependencies.js";
import { hubUnitPaths } from "./unit-membership.js";
import { finishResidue } from "./unit-residue.js";
import { ensureWorklineMaterialized } from "./workspace-materialization-service.js";

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
  /**
   * The command that actually recovers it.
   *
   * It used to name `worktree release`, and that was a dead remedy for the two
   * reasons above: `release` reaches its unit through a session resolved with
   * write intent, so an orphan of a CLOSED session was refused asking for a
   * reopen and one of an ABSENT session never resolved at all — precisely the
   * states this field is printed next to. `reclaim` reads the residue off the
   * inventory instead of off a session, which is why it can be offered here.
   */
  release: string;
}

export interface WorktreeError {
  error: string;
  message: string;
  hint?: string;
  /** Present on `unit_occupied`: who is holding the unit right now. */
  occupant?: { path: string; branch: string };
}

export type WorktreeEnsureOutput = IsolationUnit & {
  visibility: "attached" | "unavailable";
  visibility_error?: string;
  base: string | null;
  dependencies: UnitDependencyState;
  longpaths_enabled: boolean;
};

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
  unreadable: Array<{ alias: string; error: string; code?: "SOURCE_PATH_MISSING" }>;
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
  visibility_error?: string;
  branch_kept?: string;
  residue_completed?: boolean;
}

export interface WorktreeDeps {
  fs: FileSystemPort;
  env: EnvPort;
  git: GitPort;
  paths: PathsService;
  platform?: NodeJS.Platform;
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
  branch_kept?: string;
  visibility_error?: string;
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
  /**
   * Units of this session collected once every merge was done.
   *
   * Integrating already gives back each unit it merged, so what this catches is
   * the leftover: a unit whose release did not happen, or one this round never
   * reached. Closing a session is the last moment anybody is looking, which is
   * why the sweep rides here instead of waiting to become an orphan.
   */
  reclaimed: ReclaimedUnit[];
  /** Units of this session left standing, each with why and its next step. */
  retained: RetainedUnit[];
  /** Declared sources whose units could not be inspected on this host. */
  unreadable?: WorktreeListOutput["unreadable"];
  /** What to run for the first pending alias or retained unit; `null` when there is none. */
  next: string | null;
}

/**
 * Why a unit was eligible to be collected at all.
 *
 * `already_on_work_branch` is the one that is not an orphan: the unit is alive,
 * its session is too, and it simply holds nothing the source's working branch
 * does not already have — the state a session's own close sweeps up.
 */
export type ReclaimReason = OrphanUnit["reason"] | "already_on_work_branch";

export interface ReclaimedUnit {
  alias: string;
  session: string;
  path: string;
  branch: string | null;
  reason: ReclaimReason;
  branch_kept?: string;
  visibility_error?: string;
}

/**
 * Why a unit was left standing — the work it still holds, in git's own terms.
 *
 * `unreadable` is the one that carries the whole design: a read that could not be
 * completed retains. Collecting is irreversible in the tree, so the reading that
 * fails must not be the reading that clears the way.
 */
export type RetentionReason =
  | "uncommitted_changes"
  | "operation_in_progress"
  | "commits_outside_work_branch"
  | "unreadable"
  | "remove_refused"
  | "archivos_no_recuperables";

export interface RetainedUnit {
  alias: string;
  session: string;
  path: string;
  branch: string | null;
  reason: RetentionReason;
  /** What it still holds, verbatim from git when git is the one that said it. */
  detail: string;
  /** The next step that recovers this unit — never a generic instruction. */
  next: string;
}

export interface WorktreeReclaimOutput {
  workspace_key: string;
  /** The session the sweep was narrowed to, when the caller named one. */
  session?: string;
  reclaimed: ReclaimedUnit[];
  retained: RetainedUnit[];
  /** Sources whose trees could not be read; nothing of theirs was collected. */
  unreadable: Array<{ alias: string; error: string; code?: "SOURCE_PATH_MISSING" }>;
  /** What to run for the first retained unit; `null` when nothing was retained. */
  next: string | null;
}

export interface WorktreeInput {
  action: "ensure" | "list" | "release" | "integrate" | "reclaim";
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
  | WorktreeReclaimOutput
  | WorktreeError;

export async function runWorktree(
  deps: WorktreeDeps,
  input: WorktreeInput,
): Promise<WorktreeOutput> {
  if (input.action === "list") return listUnits(deps, input);
  // Collecting residue resolves NO session: the units it acts on are the ones
  // whose session is closed or already gone, so a resolver that refuses those is
  // the reason the inventory's remedy never worked. It reads the same trees the
  // inventory reads and decides per unit.
  if (input.action === "reclaim") return reclaimUnits(deps, input);
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
    intent: "write",
    allowClosed: input.sessionCode !== undefined,
    ...(input.sessionCode !== undefined ? { code: input.sessionCode } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
  });
  if (resolution.outcome !== "resolved") return sessionRefusal(resolution);
  const session = resolution.session.folder;
  const listed = await listUnits(deps, { action: "list" });
  if ("error" in listed) return listed;
  const mine = listed.units.filter((unit) => unit.session === session);
  const { results, integrated, pending, nextOf } = await mergeEach(deps, input, session, mine);
  // Every merge is done: what is still standing is residue, and the same
  // reclaimability rule that governs an orphan governs it here. A conflicted unit
  // retains itself — its commits are precisely the ones NOT on the working
  // branch — so this cannot take the side of a merge nobody resolved.
  const swept = await reclaimUnits(deps, { action: "reclaim", sessionCode: session });
  const residue =
    "error" in swept
      ? {
          reclaimed: [] as ReclaimedUnit[],
          retained: [] as RetainedUnit[],
          unreadable: [
            { alias: "workspace", error: swept.message },
          ] as WorktreeReclaimOutput["unreadable"],
          next: null,
        }
      : swept;
  const unreadable = [
    ...new Map(
      [...listed.unreadable, ...residue.unreadable].map((item) => [item.alias, item] as const),
    ).values(),
  ];
  // An alias whose unit was collected is no longer holding one, so it leaves
  // `pending`. That is not hiding its refusal — the refusal stays in `results` —
  // it is that a unit with nothing the working branch lacks had no merge pending
  // in the first place, and leaving it listed would send somebody to integrate a
  // tree that is gone.
  const taken = new Set(residue.reclaimed.map((u) => u.alias));
  const holding = pending.filter((alias) => !taken.has(alias));
  const first = holding[0];
  return {
    session,
    plan: await planOf(deps, session),
    results,
    integrated,
    pending: holding,
    reclaimed: residue.reclaimed,
    retained: residue.retained,
    ...(unreadable.length > 0 ? { unreadable } : {}),
    next:
      (first !== undefined ? (nextOf.get(first) ?? null) : null) ??
      residue.next ??
      (unreadable[0]?.code === "SOURCE_PATH_MISSING"
        ? `aw add-source ${unreadable[0].alias}:<ruta>`
        : null),
  };
}

/**
 * Every unit merged in alias order, with what is still pending and how to act on it.
 *
 * Nothing is aborted by a neighbour: each alias is its own merge into its own
 * repository, so a conflict in one must not hide whether the others landed.
 */
async function mergeEach(
  deps: WorktreeDeps,
  input: WorktreeInput,
  session: string,
  mine: ListedUnit[],
): Promise<{
  results: WorktreeIntegrateSessionOutput["results"];
  integrated: string[];
  pending: string[];
  nextOf: Map<string, string>;
}> {
  const results: WorktreeIntegrateSessionOutput["results"] = [];
  const integrated: string[] = [];
  const pending: string[] = [];
  const nextOf = new Map<string, string>();
  for (const unit of [...mine].sort((a, b) => a.alias.localeCompare(b.alias))) {
    const target = await resolveTarget(deps, { ...input, alias: unit.alias });
    const result = "error" in target ? target : await integrateUnit(deps, target);
    if ("error" in result) {
      results.push({ ...result, alias: unit.alias });
      pending.push(unit.alias);
      nextOf.set(unit.alias, `aw worktree integrate --source ${unit.alias} --code ${session}`);
      continue;
    }
    results.push(result);
    if (result.integrated) integrated.push(unit.alias);
    else {
      pending.push(unit.alias);
      if (result.next !== null) nextOf.set(unit.alias, result.next);
    }
  }
  return { results, integrated, pending, nextOf };
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
  if (base === null) return undeclaredWorkBranch(source.alias);
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

  if ((await deps.git.operationState(path)) !== "clean") {
    return {
      error: "unit_operation_in_progress",
      message: `la unidad ${path} tiene una operación git pendiente`,
      hint: `resolvé el merge con aw fix-git --path ${path} antes de integrar otra vez`,
    };
  }
  if (await deps.git.isDirty(path)) {
    return {
      error: "unit_not_committed",
      message: `la unidad de ${identity.session} tiene cambios sin commitear`,
      hint: "commiteá el trabajo del flujo en su unidad antes de integrarlo",
    };
  }
  const current = await deps.git.currentBranch(source.path);
  if (current === base && (await deps.git.isDirty(source.path))) {
    return {
      error: "checkout_dirty",
      message: `el checkout principal de ${source.alias} tiene cambios sin commitear`,
      hint: "commiteá o guardá esos cambios: la integración no los va a mezclar con los del flujo",
    };
  }

  await ensureWorklineMaterialized(deps.fs, deps.paths);
  const merged = await withCwdLock(
    deps.fs,
    deps.paths,
    () => integrateLocked(deps, { ...target, base }),
    {
      waitMs: INTEGRATE_LOCK_WAIT_MS,
    },
  );
  if ("error" in merged) {
    return {
      error: "integration_locked",
      message: `no se pudo serializar la integración de ${source.alias}: ${merged.error}`,
      hint: "esperá a que la otra integración termine y volvé a integrar; el merge no se empieza a medias",
    };
  }

  if (merged.state === "refused") return merged.refusal;
  if (merged.state === "conflict") {
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
      next: `aw fix-git --path ${merged.path}`,
    };
  }
  if (merged.before !== null && merged.after !== null && merged.before !== merged.after) {
    const tip = await deps.git.head(path);
    if (tip === null)
      return {
        error: "custody_unreadable",
        message: `no se pudo leer la punta de la unidad ${path} antes de liberarla`,
      };
    const recorded = await recordIntegration(deps, identity.session, {
      alias: source.alias,
      into: base,
      before: merged.before,
      after: merged.after,
      unitTip: tip,
    });
    if (recorded.status === "unreadable")
      return {
        error: "custody_unreadable",
        message: `la integración de ${source.alias} llegó a ${base}, pero no se pudo registrar la punta ${tip} en la custodia: ${recorded.reason}; la unidad conserva su rama`,
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
    ...("branch_kept" in release && release.branch_kept
      ? { branch_kept: release.branch_kept }
      : {}),
    ...("visibility_error" in release && release.visibility_error
      ? { visibility_error: release.visibility_error }
      : {}),
    ...("visibility_error" in release && release.visibility_error
      ? { visibility_error: release.visibility_error }
      : {}),
    next:
      "released" in release && release.released
        ? null
        : `aw worktree release --source ${source.alias} --code ${identity.session}`,
  };
}

type LockedIntegration =
  | { state: "done"; before: string | null; after: string | null }
  | { state: "conflict"; conflicted: string[]; path: string }
  | { state: "refused"; refusal: WorktreeError };

/** All ref reads, occupancy checks and the move happen under the integration lock. */
async function integrateLocked(
  deps: WorktreeDeps,
  target: ResolvedTarget & { base: string },
): Promise<LockedIntegration> {
  const { source, path, branch, base, roles } = target;
  const current = await deps.git.currentBranch(source.path);
  if (current === base) {
    const before = await deps.git.head(source.path);
    const merge = await deps.git.merge(source.path, branch);
    return merge.ok
      ? { state: "done", before, after: await deps.git.head(source.path) }
      : { state: "conflict", conflicted: merge.conflicted, path: source.path };
  }

  const ref = `refs/heads/${base}`;
  const before = await deps.git.refValue(source.path, ref);
  if (before === null)
    return {
      state: "refused",
      refusal: {
        error: "target_missing",
        message: `la rama destino '${base}' no existe en local`,
        hint: `restaurá ${base} antes de integrar; la unidad queda intacta`,
      },
    };
  const trees = await deps.git.worktreeList(source.path);
  const occupied = trees.find((tree) => tree.branch === base && !samePath(tree.path, source.path));
  if (occupied)
    return {
      state: "refused",
      refusal: {
        error: "target_occupied",
        message: `${base} está puesta en otro árbol: ${occupied.path}`,
        hint: `liberá ese árbol antes de mover la referencia ${ref}`,
      },
    };
  let head = await deps.git.head(path);
  if (head === null)
    return {
      state: "refused",
      refusal: {
        error: "unit_not_committed",
        message: `la unidad ${path} no tiene HEAD`,
      },
    };
  if (await deps.git.isAncestor(source.path, head, before)) {
    return { state: "done", before, after: before };
  }
  if (!(await deps.git.isAncestor(source.path, before, head))) {
    if (!isWorkingBranch(base, roles))
      return {
        state: "refused",
        refusal: {
          error: "checkout_off_branch",
          message: `la rama de rol ${base} no admite integración divergente fuera de su checkout`,
          hint: `posicioná el checkout en '${base}' y volvé a integrar`,
        },
      };
    const merge = await deps.git.merge(path, base);
    if (!merge.ok) return { state: "conflict", conflicted: merge.conflicted, path };
    head = await deps.git.head(path);
    if (head === null)
      return {
        state: "refused",
        refusal: {
          error: "unit_not_committed",
          message: `no se pudo leer HEAD de la unidad ${path} después del merge`,
        },
      };
  }
  const moved = await deps.git.updateRefCas(source.path, ref, head, before);
  if (!moved.ok)
    return {
      state: "refused",
      refusal: {
        error: "integration_raced",
        message: `la referencia ${ref} avanzó durante la integración: ${moved.why}`,
        hint: `la unidad queda intacta: volvé a correr aw worktree integrate --source ${source.alias} --code ${target.identity.session}`,
      },
    };
  return { state: "done", before, after: head };
}

interface ResolvedTarget {
  source: ProjectFuente & { path: string };
  identity: UnitIdentity;
  path: string;
  branch: string;
  /** Branch the unit is cut FROM: the source's declared working branch. */
  base: string | null;
  roles: ReturnType<typeof resolveSourceBranches>;
}

async function resolveTarget(
  deps: WorktreeDeps,
  input: WorktreeInput,
): Promise<ResolvedTarget | WorktreeError> {
  const block = await readWorkspaceBlock(
    deps.fs,
    deps.paths.workspaceDir(),
    deps.paths.blockMarkers(),
  );
  const sources = block?.fuentes ?? [];
  if (sources.length === 0) {
    return {
      error: "no_sources_declared",
      message: "el bloque WORKSPACE no declara ninguna fuente",
      hint: "declará la fuente con aw add-source <alias>:<ruta>:<rama> antes de pedir una unidad",
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

  let sourcePath: string;
  try {
    sourcePath = await requireSourcePath(deps.fs, source);
  } catch (err) {
    return { error: "SOURCE_PATH_MISSING", message: (err as Error).message };
  }

  const resolution = await resolveSessionTarget(deps.fs, deps.paths, {
    intent: "write",
    allowClosed: input.action !== "ensure" && input.sessionCode !== undefined,
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
  const roles = resolveSourceBranches(source, block);
  const custody = await readCustody(deps.fs, join(deps.paths.cwdSessionsDir(), session));
  if (custody.status === "unreadable")
    return {
      error: "custody_unreadable",
      message: `la custodia de ${session} no se puede leer: ${custody.reason}`,
    };
  const sealed =
    custody.status === "present"
      ? custody.custody.sources.find((s) => s.alias === source.alias)?.base_branch
      : undefined;
  const recorded =
    custody.status === "present"
      ? custody.custody.sources.find((s) => s.alias === source.alias)
      : undefined;
  if (recorded?.unit_path) {
    const oldIdentity = parseUnitPath(await canonicalUnitsRootForRead(deps), recorded.unit_path);
    if (oldIdentity?.alias === source.alias && oldIdentity.session === session)
      identity.workspaceKey = oldIdentity.workspaceKey;
  }
  let previous: WorktreeEntry | undefined;
  if (custody.status === "absent") {
    const root = await canonicalUnitsRootForRead(deps);
    const owns = await hubUnitPaths(deps.fs, deps.paths, root);
    try {
      previous = (await deps.git.worktreeList(sourcePath)).find((tree) => {
        const found = parseUnitPath(root, tree.path);
        return found?.session === session && found.alias === source.alias && owns(tree.path);
      });
    } catch {
      /* a broken git inventory is reported by ensure/list itself */
    }
    if (previous) {
      const found = parseUnitPath(root, previous.path);
      if (found) identity.workspaceKey = found.workspaceKey;
    }
  }
  const effective =
    sealed === undefined
      ? await resolveDocBranch(
          deps.fs,
          deps.paths,
          source,
          block,
          await documentOfSession(deps.fs, deps.paths, session),
        )
      : null;
  if (effective?.origin === "unreadable")
    return {
      error: "custody_unreadable",
      message: effective.reason ?? "custodia ilegible",
    };
  return {
    source: { ...source, path: sourcePath },
    identity,
    path:
      recorded?.unit_path ?? previous?.path ?? unitPath(await canonicalUnitsRoot(deps), identity),
    branch:
      recorded?.unit_branch ?? previous?.branch ?? unitBranch(session, deps.paths.workspaceDir()),
    base: sealed ?? effective?.branch ?? null,
    roles,
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

function undeclaredWorkBranch(alias: string): WorktreeError {
  return {
    error: "working_branch_undeclared",
    message: `rama de trabajo no declarada para ${alias}`,
    hint: `usá 'aw set-working-branch ${alias} <rama>'`,
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

/**
 * Read-only counterpart of {@link canonicalUnitsRoot}.
 *
 * `worktree list` backs `status` and `resume`, so it cannot manufacture the
 * user-level worktree directory merely to canonicalize a path.  If the root
 * already exists, retain the real-path comparison used by writers; when it does
 * not, its lexical spelling is enough because there can be no live unit beneath
 * a directory that has not been created.
 */
async function canonicalUnitsRootForRead(deps: WorktreeDeps): Promise<string> {
  const root = deps.paths.userUnitsDir();
  try {
    return await deps.fs.realPath(root);
  } catch {
    return root;
  }
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
  const longpathsEnabled = await enableLongPaths(deps, source.path);

  // Vanished directories keep holding their branch until git is told, so the
  // prune runs BEFORE the occupancy read — otherwise a unit whose folder the
  // user deleted by hand would look occupied forever.
  // The worktree itself lives under the user runtime, not under the workspace
  // root, so materialize explicitly before this first Git mutation rather than
  // relying on a workspace-path filesystem write to notice it.
  await ensureWorklineMaterialized(deps.fs, deps.paths);
  const unitsRoot = await canonicalUnitsRootForRead(deps);
  const owns = await hubUnitPaths(deps.fs, deps.paths, unitsRoot);
  const staleErrors: string[] = [];
  for (const tree of await deps.git.worktreeList(source.path)) {
    if (!tree.prunable || !owns(tree.path) || (await deps.fs.lstat(tree.path)) !== null) continue;
    const result = await detach(deps, tree.path);
    if (result.error) staleErrors.push(`${tree.path}: ${result.error}`);
  }
  await deps.git.worktreePrune(source.path);
  const existing = await deps.git.worktreeList(source.path);

  const mine = existing.find((w) => samePath(w.path, path));
  if (mine !== undefined) {
    const custody = await readCustody(
      deps.fs,
      join(deps.paths.cwdSessionsDir(), target.identity.session),
    );
    const recorded =
      custody.status === "present"
        ? custody.custody.sources.find((s) => s.alias === source.alias)
        : undefined;
    if (
      custody.status === "present" &&
      (recorded?.unit_path !== path || recorded.unit_branch !== branch || mine.branch !== branch)
    ) {
      return {
        error: "unit_foreign",
        message: `La unidad ${path} no está registrada en la custodia de esta sesión.`,
      };
    }
    // Idempotent: the unit is already there, on its own branch. The baseline is
    // sealed here too — it is idempotent by alias, so the FIRST reading wins and a
    // second `ensure` can never overwrite it with a state the session produced.
    const sealed = base === null ? null : await sealBaseline(deps, { ...target, base });
    if (sealed !== null) return sealed;
    const visible = await attach(deps, path);
    const visibilityError = [...staleErrors, visible.error].filter(Boolean).join("; ");
    return {
      ...unitOf(target, false),
      base,
      visibility: visible.state,
      ...(visibilityError ? { visibility_error: visibilityError } : {}),
      longpaths_enabled: longpathsEnabled,
      dependencies: await linkUnitDependencies(deps.fs, deps.git, source.path, path),
    };
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
  const exists = await deps.git.branchExists(source.path, branch);
  const custody = await readCustody(
    deps.fs,
    join(deps.paths.cwdSessionsDir(), target.identity.session),
  );
  const recorded =
    custody.status === "present"
      ? custody.custody.sources.find((s) => s.alias === source.alias)
      : undefined;
  if (
    exists &&
    custody.status === "present" &&
    (recorded?.unit_branch !== branch || recorded.unit_path !== path)
  ) {
    return {
      error: "unit_foreign",
      message: `La rama ${branch} no está registrada en la custodia de esta sesión.`,
    };
  }
  const from = exists ? null : base;
  if (from === null && !exists) return undeclaredWorkBranch(source.alias);
  if (from !== null && !(await deps.git.branchExists(source.path, from))) {
    return {
      error: "base_missing",
      message: `la rama base '${from}' no existe en ${source.alias}`,
      hint: `restaurá '${from}' antes de abrir la unidad`,
    };
  }
  try {
    await deps.git.worktreeAdd(source.path, path, branch, from);
  } catch (err) {
    return {
      error: "worktree_add_failed",
      message: (err as Error).message,
    };
  }
  const sealed = base === null ? null : await sealBaseline(deps, { ...target, base });
  if (sealed !== null) return sealed;
  const visible = await attach(deps, path);
  const visibilityError = [...staleErrors, visible.error].filter(Boolean).join("; ");
  return {
    ...unitOf(target, true),
    base,
    visibility: visible.state,
    ...(visibilityError ? { visibility_error: visibilityError } : {}),
    longpaths_enabled: longpathsEnabled,
    dependencies: await linkUnitDependencies(deps.fs, deps.git, source.path, path),
  };
}

async function enableLongPaths(deps: WorktreeDeps, repo: string): Promise<boolean> {
  if ((deps.platform ?? process.platform) !== "win32") return false;
  if (!deps.git.readConfig || !deps.git.writeLocalConfig)
    throw new Error("git no permite configurar core.longpaths localmente");
  if ((await deps.git.readConfig(repo, "core.longpaths"))?.toLowerCase() === "true") return false;
  await deps.git.writeLocalConfig(repo, "core.longpaths", "true");
  return true;
}

/**
 * Seal how the source stood before this unit gets edited, or refuse the unit.
 *
 * Taking a unit is the moment a session starts being able to mutate a source, so
 * it is the moment its baseline has to exist. A custody that is present but
 * unreadable REFUSES here rather than proceeding: the session already carries the
 * promise that it can be retired, and letting it mutate under a broken record is
 * how that promise turns out to be unkeepable later — when the work is done and
 * nobody can say what was there before. A session with no custody at all is a
 * legacy one and passes through untouched.
 */
async function sealBaseline(
  deps: WorktreeDeps,
  target: ResolvedTarget & { base: string },
): Promise<WorktreeError | null> {
  const update = await recordUnitTaken(deps, target.identity.session, {
    alias: target.source.alias,
    sourcePath: target.source.path,
    unitPath: target.path,
    unitBranch: target.branch,
    base: target.base,
  });
  if (update.status !== "unreadable") return null;
  return {
    error: "custody_unreadable",
    message: `la custodia de ${target.identity.session} no se puede leer: ${update.reason}`,
    hint: "restaurá o retirá el registro de custodia de la sesión antes de editar la fuente; sin baseline no hay retiro que prometer",
  };
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
  const registered = existing.find((w) => samePath(w.path, path));
  if (registered && (await deps.fs.lstat(path)) === null) {
    await deps.git.worktreePrune(source.path);
    if ((await deps.git.worktreeList(source.path)).some((w) => samePath(w.path, path)))
      return { error: "remove_blocked", message: `git aún registra la unidad sin carpeta ${path}` };
    return releaseUnit(deps, target);
  }
  if (registered === undefined) {
    await ensureWorklineMaterialized(deps.fs, deps.paths);
    await deps.git.worktreePrune(source.path);
    let completed = false;
    if ((await deps.fs.lstat(path)) !== null) {
      try {
        const blockers = await finishResidue(deps.fs, deps.git, source.path, path, branch);
        if (blockers.length > 0)
          return {
            error: "remove_blocked",
            message: `quedó residuo en ${path}: ${blockers.join(", ")}`,
            hint: `revisá los archivos nombrados y volvé a correr 'aw worktree release --source ${source.alias} --code ${identity.session}'`,
          };
        completed = true;
      } catch (err) {
        return {
          error: "remove_blocked",
          message: `quedó residuo en ${path}: ${(err as Error).message}`,
        };
      }
    }
    const branchKept = await deleteContainedUnitBranch(deps, target);
    const visible = await detach(deps, path);
    return {
      alias: source.alias,
      session: identity.session,
      path,
      branch,
      released: completed,
      residue_completed: completed,
      ...(branchKept ? { branch_kept: branchKept } : {}),
      visibility: visible.state,
      ...(visible.error ? { visibility_error: visible.error } : {}),
    };
  }
  if (registered.branch !== branch)
    return {
      error: "unit_foreign",
      message: `la unidad ${path} usa ${registered.branch}, no ${branch}`,
    };
  await ensureWorklineMaterialized(deps.fs, deps.paths);
  try {
    await removeUnitSafely(deps.fs, deps.git, source.path, path);
  } catch (err) {
    const now = await deps.git.worktreeList(source.path);
    if (!now.some((w) => samePath(w.path, path))) return releaseUnit(deps, target);
    return {
      error: (await deps.git.isDirty(path)) ? "unit_not_clean" : "remove_blocked",
      message: `quedó ${path}: ${(err as Error).message}`,
      hint: `revisá ${path} y volvé a correr 'aw worktree release --source ${source.alias} --code ${identity.session}'`,
    };
  }
  if ((await deps.fs.lstat(path)) !== null) {
    const blockers = await finishResidue(deps.fs, deps.git, source.path, path, branch);
    if (blockers.length > 0)
      return { error: "remove_blocked", message: `quedó ${path}: ${blockers.join(", ")}` };
  }
  const branchKept = await deleteContainedUnitBranch(deps, target);
  const visible = await detach(deps, path);
  return {
    alias: source.alias,
    session: identity.session,
    path,
    branch,
    released: true,
    ...(branchKept ? { branch_kept: branchKept } : {}),
    visibility: visible.state,
    ...(visible.error ? { visibility_error: visible.error } : {}),
  };
}

/** Only a unit branch, only with a sealed/effective base, only by the observed tip. */
async function deleteContainedUnitBranch(
  deps: WorktreeDeps,
  target: Pick<ResolvedTarget, "source" | "path" | "branch" | "base">,
): Promise<string | null> {
  const { source, path, branch, base } = target;
  if (!branch.startsWith("aw/") || branch === base) return "no es una rama de unidad borrable";
  if (
    (await deps.fs.lstat(path)) !== null ||
    (await deps.git.worktreeList(source.path)).some((tree) => tree.branch === branch)
  )
    return "la carpeta o la rama siguen ocupadas; no se borra";
  const tip = await deps.git.refValue(source.path, `refs/heads/${branch}`);
  if (tip === null) return null;
  if (base === null) return "sin base sellada o rama de trabajo; la rama se conserva";
  const baseTip = await deps.git.refValue(source.path, `refs/heads/${base}`);
  if (baseTip === null || !(await deps.git.isAncestor(source.path, tip, baseTip)))
    return `commits de ${branch} no contenidos en ${base}; la rama se conserva`;
  const deleted = await deps.git.deleteRef(source.path, `refs/heads/${branch}`, tip);
  return deleted.ok ? null : `no se pudo borrar ${branch} con punta ${tip}: ${deleted.why}`;
}

/**
 * Collect the residue: one act over the whole workspace, or over one session.
 *
 * Every unit it looks at is one the inventory already names — and the inventory
 * names units whose session is CLOSED or GONE. That is the whole reason this
 * path resolves no session: `release` reaches its tree through
 * `resolveSessionTarget({ intent: "write" })`, which refuses a closed session
 * asking for a reopen and never resolves an absent one, so the remedy printed
 * next to every orphan could not be run on the orphans that exist. Here the
 * identity comes off the unit's own path, exactly as the listing derives it, and
 * what a session is allowed to do to ITS OWN artifacts is left untouched.
 *
 * Narrowing with a session goes further than an orphan sweep on purpose: that is
 * the form integration uses at its own close, where the session is still alive
 * and what is left over is its own units, not orphans.
 */
async function reclaimUnits(
  deps: WorktreeDeps,
  input: WorktreeInput,
): Promise<WorktreeReclaimOutput | WorktreeError> {
  const block = await readWorkspaceBlock(
    deps.fs,
    deps.paths.workspaceDir(),
    deps.paths.blockMarkers(),
  );
  const sources = block?.fuentes ?? [];
  if (sources.length === 0) {
    return {
      error: "no_sources_declared",
      message: "el bloque WORKSPACE no declara ninguna fuente",
      hint: "declará la fuente con aw add-source <alias>:<ruta>:<rama> antes de pedir una recogida",
    };
  }
  if (input.alias !== undefined && !sources.some((s) => s.alias === input.alias)) {
    return {
      error: "unknown_source",
      message: `'${input.alias}' no es una fuente declarada`,
      hint: `fuentes declaradas: ${sources.map((s) => s.alias).join(", ")}`,
    };
  }
  const key = workspaceKey(deps.paths.workspaceDir());
  const root = await canonicalUnitsRootForRead(deps);
  const sessions = await sessionStates(deps);
  const owns = await hubUnitPaths(deps.fs, deps.paths, root);
  const only = input.sessionCode ?? null;

  const reclaimed: ReclaimedUnit[] = [];
  const retained: RetainedUnit[] = [];
  const unreadable: WorktreeReclaimOutput["unreadable"] = [];
  for (const source of sources) {
    if (input.alias !== undefined && source.alias !== input.alias) continue;
    const swept = await sweepSource(deps, source, { root, key, only, sessions, block, owns });
    if ("error" in swept) {
      unreadable.push({
        alias: source.alias,
        error: swept.error,
        ...(swept.code ? { code: swept.code } : {}),
      });
      continue;
    }
    reclaimed.push(...swept.reclaimed);
    retained.push(...swept.retained);
  }
  return {
    workspace_key: key,
    ...(only !== null ? { session: only } : {}),
    reclaimed,
    retained,
    unreadable,
    next:
      retained[0]?.next ??
      (unreadable[0]?.code === "SOURCE_PATH_MISSING"
        ? `aw add-source ${unreadable[0].alias}:<ruta>`
        : null),
  };
}

/** What one source's residue produced, or why its trees could not be read. */
async function sweepSource(
  deps: WorktreeDeps,
  source: ProjectFuente,
  ctx: {
    root: string;
    key: string;
    only: string | null;
    sessions: SessionStates;
    owns: (path: string) => boolean;
    block: Awaited<ReturnType<typeof readWorkspaceBlock>>;
  },
): Promise<
  | { reclaimed: ReclaimedUnit[]; retained: RetainedUnit[] }
  | { error: string; code?: "SOURCE_PATH_MISSING" }
> {
  let repo: string;
  try {
    repo = await requireSourcePath(deps.fs, source);
  } catch (err) {
    return { error: (err as Error).message, code: "SOURCE_PATH_MISSING" };
  }
  if (!(await deps.git.isGitRepo(repo))) return { reclaimed: [], retained: [] };
  let trees: WorktreeEntry[];
  try {
    trees = await deps.git.worktreeList(repo);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const reclaimed: ReclaimedUnit[] = [];
  const retained: RetainedUnit[] = [];
  const vanished: ReclaimedUnit[] = [];
  for (const tree of trees) {
    const candidate = candidateOf(tree, ctx);
    if (candidate === null) continue;
    const work = await baseForReclaim(
      deps,
      source.alias,
      candidate.session,
      resolveSourceBranches(source, ctx.block).work,
    );
    const swept = await sweepOne(deps, { ...source, path: repo }, tree, work, candidate);
    if ("retained" in swept) {
      retained.push(swept.retained);
      continue;
    }
    // A vanished tree is only collected once git has actually dropped its entry,
    // and the prune is one call for all of them. Reporting them before it ran
    // would turn a prune that failed into a collection that never happened.
    if (swept.prune) vanished.push(swept.reclaimed);
    else reclaimed.push(swept.reclaimed);
  }
  if (vanished.length > 0) {
    const settled = await prune(deps, { ...source, path: repo }, vanished, ctx.block);
    reclaimed.push(...settled.reclaimed);
    retained.push(...settled.retained);
  }
  const registered = new Set(trees.map((tree) => normalizePath(tree.path)));
  // Also visit previous workspace keys registered by 075, without claiming another hub's units.
  for (const keyEntry of (await deps.fs.lstat(ctx.root)) === null
    ? []
    : await deps.fs.list(ctx.root)) {
    if (keyEntry.type !== "dir") continue;
    const aliasDir = join(keyEntry.path, source.alias);
    if ((await deps.fs.lstat(aliasDir))?.type !== "dir") continue;
    for (const sessionEntry of await deps.fs.list(aliasDir)) {
      if (
        sessionEntry.type !== "dir" ||
        registered.has(normalizePath(sessionEntry.path)) ||
        !ctx.owns(sessionEntry.path)
      )
        continue;
      const identity = parseUnitPath(ctx.root, sessionEntry.path);
      if (
        identity?.alias !== source.alias ||
        (ctx.only !== null && !sessionFolderMatches(identity.session, ctx.only))
      )
        continue;
      const orphan = orphanReason(identity.session, ctx.sessions, false);
      if (orphan === null && ctx.only === null) continue;
      const branch = await branchForResidue(deps, repo, identity, sessionEntry.path);
      const where = {
        alias: source.alias,
        session: identity.session,
        path: sessionEntry.path,
        branch,
      };
      try {
        const blockers = await finishResidue(deps.fs, deps.git, repo, sessionEntry.path, branch);
        if (blockers.length > 0) {
          retained.push({
            ...where,
            reason: "archivos_no_recuperables",
            detail: blockers.join(", "),
            next: `revisá ${sessionEntry.path} y volvé a correr 'aw worktree reclaim --code ${identity.session}'`,
          });
          continue;
        }
        await deps.git.worktreePrune(repo);
        const base = await baseForReclaim(
          deps,
          source.alias,
          identity.session,
          resolveSourceBranches(source, ctx.block).work,
        );
        const kept = await deleteContainedUnitBranch(deps, {
          source: { ...source, path: repo },
          path: sessionEntry.path,
          branch: branch ?? "",
          base,
        });
        const visible = await detach(deps, sessionEntry.path);
        reclaimed.push({
          ...where,
          reason: orphan ?? "already_on_work_branch",
          ...(kept ? { branch_kept: kept } : {}),
          ...(visible.error ? { visibility_error: visible.error } : {}),
        });
      } catch (err) {
        retained.push({
          ...where,
          reason: "unreadable",
          detail: (err as Error).message,
          next: `revisá ${sessionEntry.path} antes de recoger`,
        });
      }
    }
  }
  return { reclaimed, retained };
}

async function branchForResidue(
  deps: WorktreeDeps,
  repo: string,
  identity: UnitIdentity,
  path: string,
): Promise<string | null> {
  const custody = await readCustody(deps.fs, join(deps.paths.cwdSessionsDir(), identity.session));
  const recorded =
    custody.status === "present"
      ? custody.custody.sources.find((s) => s.alias === identity.alias && s.unit_path === path)
      : undefined;
  if (recorded?.unit_branch) return recorded.unit_branch;
  const names = [
    `aw/${identity.workspaceKey.slice(-8)}/${identity.session}`,
    unitBranch(identity.session),
  ];
  for (const branch of names) if (await deps.git.branchExists(repo, branch)) return branch;
  return null;
}

async function baseForReclaim(
  deps: WorktreeDeps,
  alias: string,
  session: string,
  fallback: string | null,
): Promise<string | null> {
  const read = await readCustody(deps.fs, join(deps.paths.cwdSessionsDir(), session));
  if (read.status === "unreadable") return null;
  return read.status === "present"
    ? (read.custody.sources.find((source) => source.alias === alias)?.base_branch ?? fallback)
    : fallback;
}

/** The vanished trees git dropped, or the same ones still listed and why. */
async function prune(
  deps: WorktreeDeps,
  source: ProjectFuente & { path: string },
  vanished: ReclaimedUnit[],
  block: Awaited<ReturnType<typeof readWorkspaceBlock>>,
): Promise<{ reclaimed: ReclaimedUnit[]; retained: RetainedUnit[] }> {
  await ensureWorklineMaterialized(deps.fs, deps.paths);
  try {
    await deps.git.worktreePrune(source.path);
    const reclaimed: ReclaimedUnit[] = [];
    for (const unit of vanished) {
      const base = await baseForReclaim(
        deps,
        unit.alias,
        unit.session,
        resolveSourceBranches(source, block).work,
      );
      const kept = await deleteContainedUnitBranch(deps, {
        source,
        path: unit.path,
        branch: unit.branch ?? "",
        base,
      });
      const visible = await detach(deps, unit.path);
      reclaimed.push({
        ...unit,
        ...(kept ? { branch_kept: kept } : {}),
        ...(visible.error ? { visibility_error: visible.error } : {}),
      });
    }
    return { reclaimed, retained: [] };
  } catch (err) {
    return {
      reclaimed: [],
      retained: vanished.map((unit) => ({
        alias: unit.alias,
        session: unit.session,
        path: unit.path,
        branch: unit.branch,
        reason: "remove_refused" as const,
        detail: (err as Error).message,
        next: `corré 'git worktree prune' en ${source.path} y volvé a recoger`,
      })),
    };
  }
}

/** The identity and residue state of a tree this sweep may act on; `null` otherwise. */
function candidateOf(
  tree: WorktreeEntry,
  ctx: {
    root: string;
    key: string;
    only: string | null;
    sessions: SessionStates;
    owns: (path: string) => boolean;
  },
): { session: string; alias: string; orphan: OrphanUnit["reason"] | null } | null {
  const identity = tree.main ? null : parseUnitPath(ctx.root, tree.path);
  if (identity === null || !ctx.owns(tree.path)) return null;
  if (ctx.only !== null && !sessionFolderMatches(identity.session, ctx.only)) return null;
  const orphan = orphanReason(identity.session, ctx.sessions, tree.prunable);
  // Outside a named session only residue is touched: a live session's unit is
  // somebody's working tree, and a workspace-wide sweep that could take one would
  // be the failure this whole feature exists to prevent.
  if (orphan === null && ctx.only === null) return null;
  return { session: identity.session, alias: identity.alias, orphan };
}

/** One candidate, weighed and then collected or left standing. */
async function sweepOne(
  deps: WorktreeDeps,
  source: ProjectFuente & { path: string },
  tree: WorktreeEntry,
  work: string | null,
  candidate: { session: string; alias: string; orphan: OrphanUnit["reason"] | null },
): Promise<{ reclaimed: ReclaimedUnit; prune: boolean } | { retained: RetainedUnit }> {
  const where = {
    alias: candidate.alias,
    session: candidate.session,
    path: tree.path,
    branch: tree.branch,
  };
  if (candidate.orphan === "directory_missing") {
    // Nothing to weigh: the tree is gone. Pruning drops git's administrative
    // entry and leaves the branch — and with it every commit — exactly where it
    // was, so there is no work this can lose.
    return { reclaimed: { ...where, reason: candidate.orphan }, prune: true };
  }
  if (work === null)
    return {
      retained: {
        ...where,
        reason: "unreadable",
        detail: `no se pudo determinar la base sellada ni una rama de trabajo para ${source.alias}`,
        next: `revisá la custodia de ${candidate.session} o usá 'aw set-working-branch ${source.alias} <rama>' antes de recoger`,
      },
    };
  const verdict = await reclaimability(
    deps,
    source,
    tree,
    work,
    candidate.orphan,
    candidate.session,
  );
  if (!verdict.free) return { retained: { ...where, ...verdict.retention } };
  await ensureWorklineMaterialized(deps.fs, deps.paths);
  try {
    await removeUnitSafely(deps.fs, deps.git, source.path, tree.path);
  } catch (err) {
    if ((await deps.git.worktreeList(source.path)).some((w) => samePath(w.path, tree.path)))
      return {
        retained: {
          ...where,
          reason: "remove_refused",
          detail: (err as Error).message,
          next: `revisá ${tree.path} y volvé a correr 'aw worktree reclaim'; nada se borra por la fuerza`,
        },
      };
  }
  if ((await deps.fs.lstat(tree.path)) !== null) {
    try {
      const blockers = await finishResidue(deps.fs, deps.git, source.path, tree.path, tree.branch);
      if (blockers.length > 0)
        return {
          retained: {
            ...where,
            reason: "archivos_no_recuperables",
            detail: blockers.join(", "),
            next: `revisá ${tree.path} y volvé a recoger`,
          },
        };
    } catch (err) {
      return {
        retained: {
          ...where,
          reason: "remove_refused",
          detail: (err as Error).message,
          next: `revisá ${tree.path} y volvé a recoger`,
        },
      };
    }
  }
  await deps.git.worktreePrune(source.path);
  const branchKept = await deleteContainedUnitBranch(deps, {
    source,
    path: tree.path,
    branch: tree.branch ?? "",
    base: work,
  });
  const visible = await detach(deps, tree.path);
  return {
    reclaimed: {
      ...where,
      reason: candidate.orphan ?? "already_on_work_branch",
      ...(branchKept ? { branch_kept: branchKept } : {}),
      ...(visible.error ? { visibility_error: visible.error } : {}),
    },
    prune: false,
  };
}

/**
 * Whether a unit still custodies work — and it fails CLOSED.
 *
 * Three states hold a unit, and each is asked separately because each has a
 * different way out: a half-finished git operation, uncommitted changes, and
 * commits that are not on the source's working branch. A read that cannot be
 * completed is a fourth: it RETAINS. `git worktree remove` refusing is not the
 * proof that nothing with work was touched — the proof is the unit that is still
 * there — and a `status` that could not run must never read as "clean".
 */
async function reclaimability(
  deps: WorktreeDeps,
  source: ProjectFuente & { path: string },
  tree: WorktreeEntry,
  work: string,
  orphan: OrphanUnit["reason"] | null,
  session: string,
): Promise<
  | { free: true }
  | { free: false; retention: Omit<RetainedUnit, "alias" | "session" | "path" | "branch"> }
> {
  const held = (
    reason: RetentionReason,
    detail: string,
    next: string,
  ): { free: false; retention: Omit<RetainedUnit, "alias" | "session" | "path" | "branch"> } => ({
    free: false,
    retention: { reason, detail, next },
  });

  let operation: Awaited<ReturnType<GitPort["operationState"]>>;
  try {
    operation = await deps.git.operationState(tree.path);
  } catch (err) {
    return held(
      "unreadable",
      `no se pudo leer el estado de git en la unidad: ${(err as Error).message}`,
      `revisá ${tree.path} a mano: mientras su estado no se pueda leer, la recogida la conserva`,
    );
  }
  if (operation !== "clean") {
    return held(
      "operation_in_progress",
      `git dejó un ${operation} a medio resolver en la unidad`,
      `aw fix-git --path ${tree.path}`,
    );
  }
  let dirty: boolean;
  try {
    dirty = await deps.git.isDirty(tree.path);
  } catch (err) {
    return held(
      "unreadable",
      `no se pudo leer el árbol de la unidad: ${(err as Error).message}`,
      `revisá ${tree.path} a mano: mientras su árbol no se pueda leer, la recogida lo conserva`,
    );
  }
  if (dirty) {
    return held(
      "uncommitted_changes",
      "la unidad tiene cambios sin commitear",
      `commiteá o descartá los cambios en ${tree.path} y volvé a correr 'aw worktree reclaim'`,
    );
  }
  if (tree.head === null) {
    return held(
      "unreadable",
      "git no reportó el HEAD de la unidad",
      `revisá ${tree.path} a mano: sin HEAD no se puede decidir si sus commits ya están en '${work}'`,
    );
  }
  if ((await deps.git.refValue(source.path, `refs/heads/${work}`)) === null) {
    return held(
      "unreadable",
      `la base sellada '${work}' ya no existe en local`,
      `restaurá '${work}' antes de recoger la unidad ${tree.path}`,
    );
  }
  if (!(await deps.git.isAncestor(source.path, tree.head, work))) {
    return held(
      "commits_outside_work_branch",
      `la unidad tiene commits que no están en '${work}'`,
      recoveryFor(source, tree, orphan, work, session),
    );
  }
  return { free: true };
}

/** How the work of a unit that is not on the working branch gets back onto it. */
function recoveryFor(
  source: ProjectFuente & { path: string },
  tree: WorktreeEntry,
  orphan: OrphanUnit["reason"] | null,
  work: string,
  session: string,
): string {
  if (orphan === "session_closed") {
    return `aw worktree integrate --source ${source.alias} --code ${session}`;
  }
  if (orphan === "session_absent") {
    return `la sesión ${session} ya no existe: revisá la rama ${tree.branch ?? unitBranch(session)} en ${source.path} y llevá sus commits a '${work}' antes de volver a recoger`;
  }
  return `aw worktree integrate --source ${source.alias} --code ${session}`;
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

  const block = await readWorkspaceBlock(
    deps.fs,
    deps.paths.workspaceDir(),
    deps.paths.blockMarkers(),
  );
  const key = workspaceKey(deps.paths.workspaceDir());
  const root = await canonicalUnitsRootForRead(deps);
  const sessions = await sessionStates(deps);
  const owns = await hubUnitPaths(deps.fs, deps.paths, root);

  const units: ListedUnit[] = [];
  const orphans: OrphanUnit[] = [];
  const unreadable: WorktreeListOutput["unreadable"] = [];
  for (const source of block?.fuentes ?? []) {
    const scanned = await scanSource(deps, source, { root, key, only, sessions, owns });
    if ("error" in scanned) {
      // Reported, never skipped in silence: a source whose trees cannot be read
      // would otherwise show up as "no units", which is the one answer that is
      // certainly wrong — its flows are exactly the ones nobody would clean up.
      unreadable.push({
        alias: source.alias,
        error: scanned.error,
        ...(scanned.code ? { code: scanned.code } : {}),
      });
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
  ctx: {
    root: string;
    key: string;
    only: string | null;
    sessions: SessionStates;
    owns: (path: string) => boolean;
  },
): Promise<
  { units: ListedUnit[]; orphans: OrphanUnit[] } | { error: string; code?: "SOURCE_PATH_MISSING" }
> {
  const empty = { units: [], orphans: [] };
  // Not a repo is not unreadable: it has no worktrees to report, and calling it
  // an error would put every non-git source in front of the reader forever.
  let repo: string;
  try {
    repo = await requireSourcePath(deps.fs, source);
  } catch (err) {
    return { error: (err as Error).message, code: "SOURCE_PATH_MISSING" };
  }
  if (!(await deps.git.isGitRepo(repo))) return empty;
  let trees: WorktreeEntry[];
  try {
    trees = await deps.git.worktreeList(repo);
  } catch (err) {
    return { error: (err as Error).message };
  }
  const units: ListedUnit[] = [];
  const orphans: OrphanUnit[] = [];
  for (const tree of trees) {
    const identity = tree.main ? null : parseUnitPath(ctx.root, tree.path);
    if (identity === null || !ctx.owns(tree.path)) continue;
    if (ctx.only !== null && identity.session !== ctx.only) continue;
    const reason = orphanReason(identity.session, ctx.sessions, tree.prunable);
    if (reason === null) units.push(await liveUnit(deps, identity, repo, tree));
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
    intent: "read",
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
    release: `aw worktree reclaim --source ${identity.alias} --code ${identity.session}`,
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
async function attach(
  deps: WorktreeDeps,
  path: string,
): Promise<{ state: "attached" | "unavailable"; error?: string }> {
  const result = await runMultiroot(deps.fs, deps.env, deps.paths, "attach", { paths: [path] });
  return "error" in result
    ? { state: "unavailable", error: `${result.error}: ${result.hint ?? "sin detalle"}` }
    : { state: "attached" };
}

async function detach(
  deps: WorktreeDeps,
  path: string,
): Promise<{ state: "detached" | "unavailable"; error?: string }> {
  const result = await runMultiroot(deps.fs, deps.env, deps.paths, "detach", { paths: [path] });
  return "error" in result
    ? { state: "unavailable", error: `${result.error}: ${result.hint ?? "sin detalle"}` }
    : { state: "detached" };
}

function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}
