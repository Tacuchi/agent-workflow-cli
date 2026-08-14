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
 *   commit between its recorded baseline and its branch tip is too.
 * - **A shared checkout.** Anything already dirty at baseline belongs to somebody
 *   else, so only paths that are unambiguously the session's can be dropped — and
 *   when even one of them is not, the operation refuses rather than picking.
 */

import type { RetirementDirtyChange, RetirementRevert } from "../../domain/retirement/proposal.js";
import type { CustodySource, SessionCustody } from "../../domain/session/custody.js";
import { attributableCommits } from "../../domain/session/custody.js";
import type { GitPort } from "../../ports/git.js";

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
  /** Non-empty = the whole operation blocks before mutating anything. */
  blocks: AttributionBlock[];
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
): Promise<Attribution> {
  const dirty: RetirementDirtyChange[] = [];
  const reverts: RetirementRevert[] = [];
  const blocks: AttributionBlock[] = [];

  for (const source of custody.sources) {
    const tree = source.unit_path ?? source.path;
    let changed: string[];
    try {
      changed = await git.changedFiles(tree);
    } catch (err) {
      blocks.push({
        alias: source.alias,
        reason: `no se pudo leer el estado de '${tree}': ${err instanceof Error ? err.message : String(err)}`,
        contested: [],
        action: "verificá que la fuente siga siendo un repositorio legible y reintentá",
      });
      continue;
    }

    const change = dirtyChangeOf(source, tree, changed, blocks);
    if (change !== null) dirty.push(change);
    reverts.push(...(await revertsOf(git, source, custody)));
  }
  return { dirty, reverts, blocks };
}

/**
 * The uncommitted delta this session may drop, or a block.
 *
 * In an exclusive unit the delta IS the session's. In a shared checkout the paths
 * dirty at baseline are subtracted, and the rest is only droppable while it is
 * unambiguous: a path that was already dirty and is still dirty carries two
 * authors' work in the same file, and no per-file decision can separate them.
 */
function dirtyChangeOf(
  source: CustodySource,
  tree: string,
  changed: readonly string[],
  blocks: AttributionBlock[],
): RetirementDirtyChange | null {
  if (changed.length === 0) return null;
  const exclusive = source.unit_path !== null;
  if (exclusive) {
    return {
      alias: source.alias,
      tree,
      paths: [...changed].sort(),
      baseline: source.baseline_head,
      exclusive_unit: true,
    };
  }

  const contested = changed.filter((path) => source.dirty_paths.includes(path));
  if (contested.length > 0) {
    blocks.push({
      alias: source.alias,
      reason: `en el checkout compartido de '${source.alias}' hay cambios que ya estaban sin commitear antes de esta sesión`,
      contested: [...contested].sort(),
      action:
        "commiteá o guardá esos cambios ajenos y reintentá: el retiro no descarta un archivo que contiene trabajo de dos",
    });
    return null;
  }
  return {
    alias: source.alias,
    tree,
    paths: [...changed].sort(),
    baseline: source.baseline_head,
    exclusive_unit: false,
  };
}

/**
 * The commits to propose reverting, newest first.
 *
 * Reverse topological order is not a preference: undoing an older commit before a
 * newer one that builds on it conflicts, and the order is part of the seal so what
 * gets approved is the sequence that was rehearsed.
 */
async function revertsOf(
  git: GitPort,
  source: CustodySource,
  custody: SessionCustody,
): Promise<RetirementRevert[]> {
  const commits = attributableCommits(custody, source.alias);
  if (commits.length === 0) return [];
  // Only the kinds that REPORT a commit: a `unit_taken` receipt also carries an
  // `after` (the baseline head), and letting it into this map would let a
  // baseline masquerade as the receipt of a commit.
  const receipts = new Map(
    custody.effects
      .filter(
        (e) =>
          e.after !== null &&
          e.alias === source.alias &&
          (e.kind === "commit" || e.kind === "unit_integrated"),
      )
      .map((e) => [e.after as string, e]),
  );

  const out: RetirementRevert[] = [];
  for (const commit of commits) {
    const receipt = receipts.get(commit);
    const refs = await git.refsContaining(source.unit_path ?? source.path, commit);
    out.push({
      alias: source.alias,
      commit,
      parents: receipt?.parents ?? [],
      ref: receipt?.ref ?? `refs/heads/${source.unit_branch ?? source.branch}`,
      // Published means "some remote already has it": the revert stays a new local
      // commit either way, and the result declares the push as somebody else's step.
      published: refs.some((ref) => ref.startsWith("refs/remotes/")),
    });
  }
  // The receipts are appended in the order the commits happened, so reversing the
  // recorded order IS the reverse topology for a linear session history.
  return out.reverse();
}
