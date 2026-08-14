/**
 * Which git effects a retired session may take with it — and which it may not.
 *
 * Attribution never reads a commit message, an author or a timestamp. It reads
 * two things: the session's sealed baseline, and the receipts of what it did. That
 * is the whole difference between "these changes are probably ours" and "these
 * changes are ours", and only the second one may be discarded.
 *
 * Two shapes of ownership, and the rule follows the shape rather than the other
 * way round:
 *
 * - **An exclusive unit.** The session works in its own worktree on its own
 *   branch. Everything uncommitted there is its own by construction, and every
 *   commit its receipts name is too.
 * - **A shared checkout.** Anything already dirty at baseline belongs to somebody
 *   else, so only paths that are unambiguously the session's can be dropped — and
 *   when even one of them is not, the operation refuses rather than picking.
 *
 * Everything the reverts need is REHEARSED before anybody is asked: the commit is
 * built in a temporary detached worktree, so "this would conflict" is an answer the
 * preview can carry instead of a surprise the apply discovers. And the whole git
 * side converges on ONE commit point, because two refs cannot be moved as one
 * operation — a scope that would need two is refused while it is still a proposal.
 */

import { join } from "node:path";
import type {
  RetirementDirtyChange,
  RetirementPublication,
  RetirementRevert,
} from "../../domain/retirement/proposal.js";
import type { CustodySource, SessionCustody } from "../../domain/session/custody.js";
import { attributableCommits } from "../../domain/session/custody.js";
import type { GitPort, LocalChange } from "../../ports/git.js";

export interface AttributionBlock {
  /** Which source could not be attributed cleanly. */
  alias: string;
  reason: string;
  /** The paths or commits that are not unambiguously the session's. */
  contested: string[];
  action: string;
}

export interface Attribution {
  dirty: RetirementDirtyChange[];
  reverts: RetirementRevert[];
  /** The single ref this session's git effects would move, when there is one. */
  publication: RetirementPublication | null;
  /** Non-empty = the whole operation blocks before mutating anything. */
  blocks: AttributionBlock[];
}

export interface AttributionOptions {
  /** Directory temporary rehearsal worktrees are created under. */
  scratchDir: string;
  /** Distinguishes this operation's private refs and trees from any other's. */
  opId: string;
}

/**
 * What one session's git footprint is, per source it recorded.
 *
 * A source whose repository cannot be read at all becomes a BLOCK and never an
 * empty answer: "no changes to discard" and "we could not look" are the same
 * output only if nobody cares which of the two it was.
 */
export async function attributeGitEffects(
  git: GitPort,
  custody: SessionCustody,
  options: AttributionOptions,
): Promise<Attribution> {
  const dirty: RetirementDirtyChange[] = [];
  const reverts: RetirementRevert[] = [];
  const blocks: AttributionBlock[] = [];
  const publications: RetirementPublication[] = [];

  for (const source of custody.sources) {
    const tree = source.unit_path ?? source.path;

    // The operation state comes FIRST: a repository in the middle of something has
    // an index and a HEAD mid-transition, so nothing read from it is a baseline —
    // including the changes below. Reading them first and then discarding them
    // would be computing an attribution from a state we already decided not to
    // trust.
    const state = await git.operationState(tree);
    if (state !== "clean") {
      blocks.push({
        alias: source.alias,
        reason: `'${source.alias}' tiene una operación git en curso (${state})`,
        contested: [],
        action: `terminá o abortá ese ${state} y reintentá: no se prepara un retiro sobre un índice a medio camino`,
      });
      continue;
    }

    let changes: LocalChange[];
    try {
      changes = await git.localChanges(tree);
    } catch (err) {
      blocks.push({
        alias: source.alias,
        reason: `no se pudo leer el estado de '${tree}': ${message(err)}`,
        contested: [],
        action: "verificá que la fuente siga siendo un repositorio legible y reintentá",
      });
      continue;
    }

    const change = dirtyChangeOf(source, tree, changes, blocks);
    if (change !== null) dirty.push(change);

    const commits = attributableCommits(custody, source.alias);
    if (commits.length === 0) continue;
    const prepared = await prepareReverts(git, source, tree, custody, commits, options, blocks);
    if (prepared === null) continue;
    reverts.push(...prepared.reverts);
    publications.push(prepared.publication);
  }

  // ONE commit point or none. Two refs cannot be swapped as a single operation,
  // and compensating the second with another commit would change history somebody
  // can already see — so the topology is refused here, before anything mutates.
  if (publications.length > 1) {
    blocks.push({
      alias: publications.map((p) => p.alias).join(", "),
      reason: `el alcance tocaría ${publications.length} unidades de publicación Git y no hay un único punto de commit que las cubra`,
      contested: publications.map((p) => `${p.alias}:${p.ref}`),
      action:
        "retirá por separado el trabajo de cada fuente: ampliar esa topología necesita otro contrato, no una limpieza parcial",
    });
  }

  return {
    dirty,
    reverts,
    publication: publications.length === 1 ? (publications[0] as RetirementPublication) : null,
    blocks,
  };
}

/**
 * The uncommitted delta this session may drop, or a block.
 *
 * In an exclusive unit the delta IS the session's — every shape of it: a rename is
 * two paths and both go, a deletion is restored, an untracked file is removed, a
 * mode flip and a symlink are changes like any other. In a shared checkout the
 * paths that were already dirty at baseline are somebody else's, and a path that
 * carries both authors' work cannot be separated by any per-file decision.
 */
function dirtyChangeOf(
  source: CustodySource,
  tree: string,
  changes: readonly LocalChange[],
  blocks: AttributionBlock[],
): RetirementDirtyChange | null {
  if (changes.length === 0) return null;
  // A rename is two paths in the working tree, and dropping one of them would
  // leave the other half applied.
  const paths = [
    ...new Set(changes.flatMap((c) => (c.from === null ? [c.path] : [c.path, c.from]))),
  ]
    .sort()
    .filter((p) => p.length > 0);

  if (source.unit_path !== null) {
    return {
      alias: source.alias,
      tree,
      paths,
      baseline: source.baseline_head,
      exclusive_unit: true,
    };
  }

  const contested = paths.filter((path) => source.dirty_paths.includes(path));
  if (contested.length > 0) {
    blocks.push({
      alias: source.alias,
      reason: `en el checkout compartido de '${source.alias}' hay cambios que ya estaban sin commitear antes de esta sesión`,
      contested,
      action:
        "commiteá o guardá esos cambios ajenos y reintentá: el retiro no descarta un archivo que contiene trabajo de dos",
    });
    return null;
  }
  return {
    alias: source.alias,
    tree,
    paths,
    baseline: source.baseline_head,
    exclusive_unit: false,
  };
}

interface PreparedReverts {
  reverts: RetirementRevert[];
  publication: RetirementPublication;
}

/**
 * The reverts for one source, rehearsed, plus the single ref they land on.
 *
 * Order is reverse topology and it is material: undoing an ancestor before the
 * descendant that builds on it conflicts. It comes from `isAncestor` and not from
 * the order the receipts happen to be in, because a session can commit on top of
 * work it did not do.
 */
async function prepareReverts(
  git: GitPort,
  source: CustodySource,
  /** The working tree that has the moving ref checked out. */
  tree: string,
  custody: SessionCustody,
  commits: readonly string[],
  options: AttributionOptions,
  blocks: AttributionBlock[],
): Promise<PreparedReverts | null> {
  const repo = source.path;
  const ref = refOf(source);
  const expectedOld = await git.refValue(repo, ref);
  if (expectedOld === null) {
    blocks.push({
      alias: source.alias,
      reason: `'${ref}' no existe en ${source.alias}: no hay punto de commit al que aplicar los reverts`,
      contested: [ref],
      action: "revisá la rama de la unidad de esta sesión antes de retirar sus commits",
    });
    return null;
  }

  const ordered = await reverseTopology(git, repo, commits);
  const external = await externalDescendants(git, repo, ordered, expectedOld);
  if (external.length > 0) {
    blocks.push({
      alias: source.alias,
      reason: `hay commits que dependen de los de esta sesión y quedan fuera del alcance en ${source.alias}`,
      contested: external,
      action:
        "esos commits no son de esta sesión: revertí o retirá primero ese trabajo, o dejá el alcance como está",
    });
    return null;
  }

  const rehearsal = await rehearse(
    git,
    repo,
    tree,
    ref,
    expectedOld,
    ordered,
    custody,
    source,
    options,
  );
  if ("reason" in rehearsal) {
    blocks.push({ alias: source.alias, ...rehearsal });
    return null;
  }
  return rehearsal;
}

/** The ref a session's commits live on: its unit's branch, else the source's. */
function refOf(source: CustodySource): string {
  return `refs/heads/${source.unit_branch ?? source.branch}`;
}

async function reverseTopology(
  git: GitPort,
  repo: string,
  commits: readonly string[],
): Promise<string[]> {
  const ordered = [...commits];
  // A small insertion sort over `isAncestor`: the sets here are a session's own
  // commits, so this is a handful of comparisons and not a graph walk.
  const isBefore = new Map<string, Set<string>>();
  for (const a of ordered) {
    const set = new Set<string>();
    for (const b of ordered) {
      if (a !== b && (await git.isAncestor(repo, a, b))) set.add(b);
    }
    isBefore.set(a, set);
  }
  // Descendants first: `a` comes before `b` when `b` is an ancestor of `a`.
  return ordered.sort((a, b) => {
    if (isBefore.get(b)?.has(a) === true) return -1;
    if (isBefore.get(a)?.has(b) === true) return 1;
    return a < b ? -1 : 1;
  });
}

/**
 * Commits that descend from what we are reverting and are NOT ours.
 *
 * Reverting under them is legitimate git — the revert is a new commit on top — but
 * it silently undoes the ground somebody else's work stands on. So it blocks, and
 * it names them.
 */
async function externalDescendants(
  git: GitPort,
  repo: string,
  commits: readonly string[],
  tip: string,
): Promise<string[]> {
  const ours = new Set(commits);
  const found: string[] = [];
  for (const commit of commits) {
    if (commit === tip || ours.has(tip)) continue;
    // The tip descends from one of ours and is not one of ours: whatever sits
    // between them belongs to somebody else.
    if (await git.isAncestor(repo, commit, tip)) found.push(tip);
  }
  return [...new Set(found)];
}

type RehearsalFailure = { reason: string; contested: string[]; action: string };

/**
 * Build the revert commits for real, in a throwaway detached worktree.
 *
 * Detached and temporary because a rehearsal must not be able to move a ref or
 * leave a branch behind, and REAL because a simulation that only guessed whether
 * the revert applies would be exactly the unverified claim the seal exists to
 * prevent. What comes back is the tip the commit point will publish and the tree
 * it must produce.
 */
async function rehearse(
  git: GitPort,
  repo: string,
  /** Where the moving ref is checked out: the tree the result has to land in. */
  tree: string,
  ref: string,
  expectedOld: string,
  ordered: readonly string[],
  custody: SessionCustody,
  source: CustodySource,
  options: AttributionOptions,
): Promise<PreparedReverts | RehearsalFailure> {
  const worktree = join(options.scratchDir, `rehearsal-${options.opId}-${source.alias}`);
  try {
    await git.worktreeAddDetached(repo, worktree, expectedOld);
  } catch (err) {
    return {
      reason: `no se pudo preparar un árbol temporal para ensayar los reverts: ${message(err)}`,
      contested: [],
      action: "liberá espacio o revisá el repositorio y reintentá; nada se aplicó",
    };
  }

  try {
    const reverts: RetirementRevert[] = [];
    for (const commit of ordered) {
      const one = await rehearseOne(git, repo, ref, worktree, commit, custody, source);
      if ("reason" in one) return one;
      reverts.push(one.revert);
    }

    const preparedTip = await git.refValue(worktree, "HEAD");
    if (preparedTip === null || reverts.length === 0) {
      return {
        reason: `el ensayo de los reverts de ${source.alias} no produjo un commit`,
        contested: [],
        action: "revisá los receipts de la sesión: sin un tip preparado no hay punto de commit",
      };
    }

    // THE precondition the probe found: the compare-and-swap moves the ref and not
    // the working tree, so if syncing that tree can refuse, it has to refuse now.
    // After the swap there is no way back that is not a rewrite.
    //
    // Asked against the tree that HAS the moving ref checked out — which for a
    // session with its own unit is the unit, not the source's main checkout. Asking
    // the wrong tree is the same as not asking: the main checkout sits on another
    // branch and would answer yes to a question about somebody else's tree.
    const syncable = await git.canSyncTree(tree, preparedTip);
    if (!syncable.ok) {
      return {
        reason: `el árbol de trabajo de ${source.alias} no se puede llevar al resultado sin pisar cambios locales`,
        contested: [],
        action:
          "commiteá o guardá esos cambios y reintentá: la sincronización se comprueba antes del punto de commit, nunca después",
      };
    }
    // The half the dry run cannot see: a path the result would CREATE where an
    // untracked file already sits. `read-tree -n` has no working tree to look at,
    // and the version that does (`-u`) would be performing the switch — which
    // after the commit point is exactly the partial success this precondition
    // exists to prevent.
    const collisions = await untrackedCollisions(git, tree, preparedTip);
    if (collisions.length > 0) {
      return {
        reason: `en ${source.alias} hay archivos sin trackear donde el resultado crearía los suyos`,
        contested: collisions,
        action:
          "movelos, borralos o commitealos y reintentá: el retiro no sobrescribe un archivo que nadie versionó",
      };
    }

    const expectedTree = await git.treeOf(worktree, preparedTip);
    if (expectedTree === null) {
      return {
        reason: `no se pudo leer el árbol resultante del ensayo en ${source.alias}`,
        contested: [],
        action: "revisá el repositorio y volvé a preparar; nada se aplicó",
      };
    }
    return {
      reverts,
      publication: {
        alias: source.alias,
        repo,
        ref,
        expected_old: expectedOld,
        expected_tree: expectedTree,
        revert_count: reverts.length,
      },
    };
  } finally {
    // The rehearsal leaves nothing behind, whichever way it went. Its commits stay
    // reachable through the private ref the coordinator sets, never through a tree.
    try {
      await git.worktreeRemove(repo, worktree);
    } catch {
      // Best-effort: a tree that cannot be removed is reported by `worktree list`
      // as an orphan, which is a visible state and not a silent one.
    }
  }
}

/**
 * One commit's revert, rehearsed and committed in the temporary tree.
 *
 * Two ways it can refuse and they mean different things: a conflict is work that
 * cannot be undone cleanly, and an EMPTY result means the commit's effect is not
 * in this branch at all — a receipt pointing at an abandoned side branch. Both
 * stop the operation, and saying which one it was is what makes the refusal
 * actionable.
 */
async function rehearseOne(
  git: GitPort,
  repo: string,
  ref: string,
  worktree: string,
  commit: string,
  custody: SessionCustody,
  source: CustodySource,
): Promise<{ revert: RetirementRevert } | RehearsalFailure> {
  const receipt = receiptFor(custody, source.alias, commit);
  const parents = receipt?.parents ?? [];
  // A merge needs its mainline, and the recorded parents are what name it: the
  // first parent is the side the branch was on, so that is the one kept.
  const mainline = parents.length > 1 ? 1 : null;
  const attempt = await git.rehearseRevert(worktree, commit, mainline);
  if (!attempt.ok) {
    return {
      reason: `el revert de ${commit.slice(0, 12)} no aplica limpio en ${source.alias}`,
      contested: attempt.conflicted.length > 0 ? attempt.conflicted : [commit],
      action:
        "resolvé ese conflicto por fuera o dejá el alcance como está: el retiro no commitea un revert en conflicto",
    };
  }
  try {
    await git.commitIn(worktree, `revert ${commit.slice(0, 12)} (aw retiro)`);
  } catch {
    return {
      reason: `el revert de ${commit.slice(0, 12)} no aplica limpio en ${source.alias}: su efecto no está en ${ref}`,
      contested: [commit],
      action:
        "el receipt apunta a una rama que ya no contiene ese commit: no commitea un revert en conflicto ni uno vacío; revisá la unidad de esa sesión",
    };
  }
  const refs = await git.refsContaining(repo, commit);
  return {
    revert: {
      alias: source.alias,
      commit,
      parents,
      ref,
      // Published means "some remote already has it": the revert stays a new local
      // commit either way, and the result declares the push as somebody else's step.
      published: refs.some((name) => name.startsWith("refs/remotes/")),
      mainline,
    },
  };
}

/** Untracked paths the result's tree would overwrite. Empty is the normal case. */
async function untrackedCollisions(
  git: GitPort,
  tree: string,
  preparedTip: string,
): Promise<string[]> {
  const untracked = (await git.localChanges(tree)).filter((c) => c.untracked).map((c) => c.path);
  if (untracked.length === 0) return [];
  const inResult = new Set(await git.treePaths(tree, preparedTip));
  return untracked.filter((path) => inResult.has(path)).sort();
}

function receiptFor(custody: SessionCustody, alias: string, commit: string) {
  return custody.effects.find(
    (e) =>
      e.alias === alias &&
      e.after === commit &&
      (e.kind === "commit" || e.kind === "unit_integrated"),
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
