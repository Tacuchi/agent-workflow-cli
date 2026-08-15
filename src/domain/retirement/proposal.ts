/**
 * The exact retirement somebody is about to authorize — under ONE seal.
 *
 * `LocalProposal` seals a publication: the bytes that will be written, the bases
 * they were computed from, the effect classes. A retirement is the mirror of it
 * and needs the same guarantee for a different set of facts: what DISAPPEARS,
 * what goes back to bytes it used to have, which uncommitted change is dropped,
 * which commit gets a revert, which unit is reconciled and which row is appended.
 * So it is a record of its own, sealed the same way and over all of it.
 *
 * Two properties are what the seal buys, and both are properties of the data
 * rather than rules somebody has to remember:
 *
 * - **An identical retry never re-asks.** Same closure, same bytes, same SHAs →
 *   same digest → the approval still fits.
 * - **Anything material that moved always re-asks.** One more session in the
 *   closure, a plan whose bytes changed since the preview, a commit that gained a
 *   descendant: all of them change the digest, and the old approval stops fitting.
 *
 * The `read_set` is the compare-and-swap. A retirement is computed FROM a state of
 * the workspace — the board, each session's custody, git — and applying it later
 * is only legitimate while that state still holds. Recording what was read, with
 * its digest, is what lets `apply` refuse instead of acting on a world that moved.
 *
 * The preview is DERIVED from this object and never authored beside it, for the
 * same reason a publication's is: two descriptions of the same deletion can
 * disagree, and the one a person reads would be the one that is wrong.
 */

import { semanticDigest } from "../../application/semantic-operation/protocol.js";
import type { WorklineNodeId } from "../workline-node.js";

export const RETIREMENT_MODES = ["discard", "reset"] as const;

export type RetirementMode = (typeof RETIREMENT_MODES)[number];

/** One node inside the closure, and why it is in there. */
export interface ClosureEntry {
  node: WorklineNodeId;
  /** Workspace-relative path of the document, or of the session folder. */
  path: string;
  /**
   * `target` for the node that was named, `descendant` for one reached through a
   * provable edge, `internal-session` for a session the target owns.
   */
  reason: "target" | "descendant" | "internal-session";
}

/** A path the retirement removes. Directories are removed whole. */
export interface RetirementDelete {
  path: string;
  kind: "file" | "directory";
  /** Digest of what is there now, so `apply` can see it move underneath. */
  digest: string | null;
}

/** A path that goes back to bytes it held before the retired session ran. */
export interface RetirementRestore {
  path: string;
  /** `false` = the path did not exist before, so restoring means deleting it. */
  existed: boolean;
  /** The bytes to put back; `null` only when `existed` is false. */
  content: string | null;
  /** Digest of those bytes, so what is restored is verifiable after the fact. */
  digest: string | null;
  /** Digest of what the path holds right now — the compare-and-swap base. */
  current_digest: string | null;
}

/** An uncommitted change the retirement drops, always inside one source. */
export interface RetirementDirtyChange {
  alias: string;
  /** Absolute path of the working tree the change lives in. */
  tree: string;
  /** Paths whose current content is dropped, relative to that tree. */
  paths: string[];
  /**
   * The commit the tree goes back to.
   *
   * Present even when the change is only in the working tree, because "discard
   * the change" means "return these paths to this commit's content", and naming
   * the commit is what keeps that from meaning "return them to whatever HEAD is
   * when apply runs".
   */
  baseline: string | null;
  /** `true` when the whole tree is the session's, so the delta is entirely its. */
  exclusive_unit: boolean;
}

/** A commit the retirement proposes to revert — never to rewrite. */
export interface RetirementRevert {
  alias: string;
  /** The commit being undone. It stays reachable, always. */
  commit: string;
  /** Its parents, so reverting a merge names the side it keeps. */
  parents: string[];
  /** Ref the revert commit will land on. */
  ref: string;
  /** Whether the commit is reachable from a remote-tracking ref already. */
  published: boolean;
  /**
   * The parent kept when the commit is a merge (git's `-m`), `null` otherwise.
   *
   * Read from the RECORDED parents rather than chosen at apply time: which side of
   * a merge survives is a fact about the commit, not a preference of whoever
   * happens to run the revert later.
   */
  mainline: number | null;
}

/**
 * The single commit point the git side of a retirement hinges on.
 *
 * One per proposal, never more: two refs cannot be moved as one operation, and a
 * second commit point would mean a window where half the retirement is published.
 * A scope that would need two is refused while it is still a proposal.
 *
 * The two sealed fields are what make the swap verifiable rather than hopeful.
 * `expected_old` is the compare-and-swap base — the ref must still be there or the
 * world moved. `expected_tree` is the RESULT: the tree the reverts produce.
 *
 * The result is sealed as a TREE and never as a commit id, and that is not a
 * detail. A commit's id includes its timestamp, so the same reverts built one
 * second later are a different commit — sealing the id would make every
 * authorization expire within the second it was granted, and an `apply` that
 * rebuilt them would refuse its own work. A tree is content-addressed: the same
 * reverts always produce the same tree, whenever they are built. So the identity of
 * the commit is free to differ and the RESULT is what is pinned.
 */
export interface RetirementPublication {
  alias: string;
  /** Absolute path of the repository whose ref moves. */
  repo: string;
  /** Full ref name (`refs/heads/main`). */
  ref: string;
  /** The value the ref must still have; `null` = it must not exist yet. */
  expected_old: string | null;
  /** The tree the reverts produce — reproducible, and therefore the seal. */
  expected_tree: string;
  /** How many revert commits land on top of `expected_old`. */
  revert_count: number;
}

/** An isolation unit the retirement reconciles (releases or leaves). */
export interface RetirementUnit {
  alias: string;
  session: string;
  path: string;
  branch: string;
  /**
   * The source repository the unit was cut from.
   *
   * Sealed here rather than resolved when the unit is given back: by then the
   * session whose custody held that mapping is being removed, so re-deriving it
   * would come back empty exactly when it is needed.
   */
  repo: string;
}

/**
 * What one session in the closure declared it was holding.
 *
 * It is sealed rather than derived by the reader because the two states it
 * separates are indistinguishable from the rest of the proposal: a session whose
 * custody declares nothing and one whose declared artifacts are all outputs both
 * produce an empty `restores`, and an empty list renders as an ABSENT section —
 * silence, exactly where "nothing came back" has to be said out loud.
 *
 * Counting instead of listing is deliberate: the paths themselves are already in
 * `restores` and `deletes`, and duplicating them would give the same fact two
 * spellings that can disagree. What is missing from those lists is the DENOMINATOR
 * — how much the session ever declared — and that is what makes "0 restored" read
 * as "there was nothing" rather than as "something was skipped".
 */
export interface RetirementCustodyScope {
  /** Folder of the session the declaration belongs to. */
  session: string;
  /** Artifacts its sealed custody declares — everything it received or produced. */
  declared: number;
  /** Of those, the paths THIS retirement puts back. Always `0` for a discard. */
  restored: number;
}

/** The one durable Workline trace a successful retirement leaves. */
export interface RetirementEvent {
  /** `discard` or `reset` — the command, as it will read in HISTORY. */
  command: RetirementMode;
  /** Row key: the retired node's identity. */
  key: string;
  /** What disappeared or was restored, in one line. */
  summary: string;
}

/** One thing the proposal was computed FROM, with its digest at that moment. */
export interface ReadSetEntry {
  /** `custody:119-x`, `doc:docs/plans/024-plan-x.md`, `git:acme/HEAD`. */
  id: string;
  digest: string;
}

export interface RetirementProposal {
  version: number;
  mode: RetirementMode;
  target: WorklineNodeId;
  /** In removal order: descendants before what they hang from. */
  closure: ClosureEntry[];
  deletes: RetirementDelete[];
  restores: RetirementRestore[];
  /** What each session in the closure declared, so an empty custody is visible. */
  custody: RetirementCustodyScope[];
  /** Conversation associations that stop resolving. */
  bindings: string[];
  units: RetirementUnit[];
  dirty: RetirementDirtyChange[];
  reverts: RetirementRevert[];
  /** The one ref this retirement moves, or `null` when it moves none. */
  publication: RetirementPublication | null;
  event: RetirementEvent;
  read_set: ReadSetEntry[];
  digest: string;
}

export const RETIREMENT_PROPOSAL_VERSION = 1;

export type SealRetirementInput = Omit<RetirementProposal, "version" | "digest">;

export function sealRetirementProposal(input: SealRetirementInput): RetirementProposal {
  const body = { version: RETIREMENT_PROPOSAL_VERSION, ...input };
  return { ...body, digest: retirementDigest(body) };
}

/**
 * The seal, over the SET rather than the order a builder happened to append in —
 * except for `closure` and `reverts`, whose ORDER is material: a closure removed
 * in another order can leave a dangling reference, and reverts applied in another
 * order can conflict. Content travels as its own digest so the seal stays a fixed
 * size whatever the restored bytes weigh.
 */
export function retirementDigest(body: Omit<RetirementProposal, "digest">): string {
  return semanticDigest({
    version: body.version,
    mode: body.mode,
    target: body.target,
    closure: body.closure,
    deletes: [...body.deletes].sort((a, b) => order(a.path, b.path)),
    restores: [...body.restores]
      .map((r) => ({
        path: r.path,
        existed: r.existed,
        digest: r.digest,
        current_digest: r.current_digest,
      }))
      .sort((a, b) => order(a.path, b.path)),
    custody: [...body.custody].sort((a, b) => order(a.session, b.session)),
    bindings: [...body.bindings].sort(order),
    units: [...body.units].sort((a, b) =>
      order(`${a.alias}/${a.session}`, `${b.alias}/${b.session}`),
    ),
    dirty: [...body.dirty]
      .map((d) => ({ ...d, paths: [...d.paths].sort(order) }))
      .sort((a, b) => order(a.alias, b.alias)),
    reverts: body.reverts,
    publication: body.publication,
    event: body.event,
    read_set: [...body.read_set].sort((a, b) => order(a.id, b.id)),
  });
}

function order(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whether this proposal would touch git history at all.
 *
 * It is what decides whether the authorization has to be LABELLED with its
 * reverts: approving a retirement that only deletes local files is not the same
 * decision as approving one that adds commits to a branch, and the difference has
 * to be visible in the question rather than in the preview somebody may not read.
 */
export function proposesReverts(proposal: RetirementProposal): boolean {
  return proposal.reverts.length > 0;
}
