/**
 * `apply`: the coordinator that gives a retirement exactly two stable outcomes.
 *
 * Everything expensive, refusable or reversible happens BEFORE one hinge, and
 * everything after it is unconditional completion. That is the whole design, and
 * it is the shape the T3.1 probe demonstrated rather than one assumed here:
 *
 *   1. recompute      — the proposal is built again under the lock; a different
 *                       digest means the world moved and the approval no longer fits
 *   2. journal        — the only trace that exists before any effect, and it lives
 *                       OUTSIDE every folder this operation may delete
 *   3. stage          — restores written into quarantine; the workspace untouched
 *   4. reverts        — built in a temporary detached worktree, held by private refs
 *   5. COMMIT POINT   — the ref's compare-and-swap, or the HISTORY row when there is
 *                       no git side. Exactly one, and nothing else can be it
 *   6. complete       — sync the tree, move the staged bytes in, remove what was
 *                       retired, invalidate bindings, append the row
 *   7. cleanup        — quarantine, private refs, journal
 *
 * A failure at any step before 5 leaves the observable state identical, because
 * nothing observable was touched: the quarantine and the private refs are invisible
 * to every Workline surface, and dropping them is not a compensation — it is
 * discarding something nobody could see. A failure after 5 is not rolled back,
 * ever: the ref cannot move backwards without rewriting history. It is FINISHED, by
 * this process or by the next one that reads the journal.
 */

import { join } from "node:path";
import type { RetirementProposal, RetirementRestore } from "../../domain/retirement/proposal.js";
import { baselineDigest } from "../../domain/session/custody.js";
import { localDateIso } from "../dates.js";
import { withCwdLock } from "../lock-service.js";
import { invalidateBindingsTo } from "../session-binding-service.js";
import { appendEvent, eventOf, hasEvent } from "./history-events.js";
import {
  type RetirementJournal,
  dropJournal,
  listPendingJournals,
  openJournal,
  quarantinePath,
  writeJournal,
} from "./journal.js";
import { type PrepareDeps, type PrepareInput, prepareRetirement } from "./prepare.js";
import type { RetirementRejection } from "./resolve.js";

export interface ApplyInput extends PrepareInput {
  /** The digest the person approved. Nothing runs unless it still fits. */
  approval: string;
}

export interface ApplyResult {
  digest: string;
  mode: RetirementProposal["mode"];
  target: string;
  /** Paths that are gone. */
  removed: string[];
  /** Paths that went back to bytes they used to have. */
  restored: string[];
  /** Conversation associations dropped. */
  bindings_invalidated: number;
  /** The single ref that moved, when one did. */
  published: { ref: string; from: string | null; to: string } | null;
  /** Reverts that exist locally and whose push is somebody else's separate step. */
  pending_remote_publication: string[];
  /**
   * Isolation units this retirement gave back.
   *
   * Released only when git agrees they hold nothing uncommitted: past the commit
   * point there is no failing, so a unit that still has work is REPORTED for
   * reconciliation instead of being forced away. Deleting a tree to tidy up is the
   * one way this feature could destroy work nobody authorized.
   */
  units_released: string[];
  pending_reconciliation: string[];
  /** Whether this call performed the work or recognized it as already done. */
  already_applied: boolean;
}

export type ApplyOutcome =
  | { ok: true; result: ApplyResult }
  | { ok: false; rejection: RetirementRejection };

export interface ApplyDeps extends PrepareDeps {
  now?: () => Date;
}

export async function applyRetirement(deps: ApplyDeps, input: ApplyInput): Promise<ApplyOutcome> {
  const locked = await withCwdLock(deps.fs, deps.paths, () => runUnderLock(deps, input));
  if ("error" in locked) {
    return {
      ok: false,
      rejection: {
        code: "EVIDENCE_MISSING",
        message: locked.error,
        candidates: [],
        action: "esperá a que se libere el lock del workspace y volvé a aplicar",
      },
    };
  }
  return locked;
}

async function runUnderLock(deps: ApplyDeps, input: ApplyInput): Promise<ApplyOutcome> {
  // 1 — the proposal is computed AGAIN, from the live workspace. Trusting the one
  // that produced the preview would authorize a state that may no longer exist.
  const prepared = await prepareRetirement(deps, input);
  if (!prepared.ok) return { ok: false, rejection: prepared.rejection };
  const proposal = prepared.proposal;

  if (proposal.digest !== input.approval) {
    return {
      ok: false,
      rejection: {
        code: "EVIDENCE_MISSING",
        message: "lo aprobado no es lo que se aplicaría: el alcance cambió desde la vista previa",
        candidates: [input.approval, proposal.digest],
        action: "volvé a correr `prepare`, leé la vista previa vigente y aprobá ese digest",
      },
    };
  }

  const stale = await staleReadSet(deps, proposal);
  if (stale !== null) return { ok: false, rejection: stale };

  // An operation whose row is already in HISTORY is one that passed its commit
  // point in a previous process. Retrying the same approval finishes it; it never
  // starts a second one.
  if (await hasEvent(deps.fs, deps.paths, proposal.digest)) {
    return finish(deps, journalFor(deps, proposal), true);
  }

  const journal = journalFor(deps, proposal);
  await writeJournal(deps.fs, deps.paths, journal);

  const staged = await stage(deps, journal);
  if (!staged.ok) {
    await rollback(deps, journal);
    return { ok: false, rejection: staged.rejection };
  }

  const built = await buildReverts(deps, journal);
  if (!built.ok) {
    await rollback(deps, journal);
    return { ok: false, rejection: built.rejection };
  }
  await writeJournal(deps.fs, deps.paths, {
    ...journal,
    phase: "ready",
    private_refs: built.refs,
    ...(built.tip === null ? {} : { prepared_tip: built.tip }),
  });

  // 5 — THE COMMIT POINT. What it publishes is the commit this process just built
  // and verified against the sealed TREE — the reverts' identity is free to differ
  // between two builds (a commit id carries its timestamp), their result is not.
  const publication = proposal.publication;
  if (publication !== null && built.tip !== null) {
    const swap = await deps.git.updateRefCas(
      publication.repo,
      publication.ref,
      built.tip,
      publication.expected_old,
    );
    if (!swap.ok) {
      await rollback(deps, { ...journal, private_refs: built.refs });
      return {
        ok: false,
        rejection: {
          code: "EVIDENCE_MISSING",
          message: `'${publication.ref}' se movió mientras se preparaba el retiro: ${swap.why}`,
          candidates: [publication.ref],
          action: "nada se aplicó; volvé a preparar sobre el estado vigente",
        },
      };
    }
  }
  const committed: RetirementJournal = {
    ...journal,
    phase: "committed",
    private_refs: built.refs,
    ...(built.tip === null ? {} : { prepared_tip: built.tip }),
  };
  await writeJournal(deps.fs, deps.paths, committed);

  return finish(deps, committed, false);
}

function journalFor(deps: ApplyDeps, proposal: RetirementProposal): RetirementJournal {
  return openJournal({
    proposal,
    quarantine: quarantinePath(deps.paths, proposal.digest),
    opened: localDateIso((deps.now ?? (() => new Date()))()),
  });
}

/**
 * Whether the world the proposal was computed from still holds.
 *
 * The digest already covers the closure and the bytes; this covers the things the
 * proposal READ to decide — a custody, a document, a HEAD. A retirement authorized
 * against one state and applied against another is the single failure mode the
 * whole seal exists to prevent, and re-reading is the only way to know.
 */
async function staleReadSet(
  deps: ApplyDeps,
  proposal: RetirementProposal,
): Promise<RetirementRejection | null> {
  for (const restore of proposal.restores) {
    const absolute = join(deps.paths.workspaceDir(), restore.path);
    const current = (await deps.fs.exists(absolute))
      ? baselineDigest(await deps.fs.readText(absolute))
      : null;
    if (current === restore.current_digest) continue;
    return {
      code: "EVIDENCE_MISSING",
      message: `'${restore.path}' cambió después de preparar el retiro`,
      candidates: [restore.path],
      action:
        "volvé a preparar: restaurar sobre bytes que ya no son los que se mostraron perdería ese cambio",
    };
  }
  return null;
}

type Step = { ok: true } | { ok: false; rejection: RetirementRejection };

/**
 * 3 — the restores land in quarantine, on the same filesystem as their destination.
 *
 * Same filesystem so the final move is a rename: the completion after the commit
 * point has to be as short and as unlikely to fail as possible, because it is the
 * part that cannot be rolled back.
 */
async function stage(deps: ApplyDeps, journal: RetirementJournal): Promise<Step> {
  try {
    await deps.fs.mkdirp(journal.quarantine);
    for (const [index, restore] of journal.proposal.restores.entries()) {
      if (!restore.existed || restore.content === null) continue;
      await deps.fs.writeText(stagedPath(journal, index), restore.content);
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      rejection: {
        code: "EVIDENCE_MISSING",
        message: `no se pudo preparar la cuarentena del retiro: ${message(err)}`,
        candidates: [],
        action: "liberá espacio o revisá permisos y volvé a aplicar; no se aplicó ningún efecto",
      },
    };
  }
}

function stagedPath(journal: RetirementJournal, index: number): string {
  return join(journal.quarantine, `restore-${index}`);
}

/**
 * 4 — the revert commits, built for real but held only by a private ref.
 *
 * Private because a name under `refs/aw-op/` is invisible to every branch listing
 * and to every reader, so a process that dies here leaves objects nobody can see
 * rather than a branch somebody might mistake for work. The rehearsal already
 * proved they apply; this builds the ones that will actually be published.
 */
async function buildReverts(
  deps: ApplyDeps,
  journal: RetirementJournal,
): Promise<
  { ok: true; refs: string[]; tip: string | null } | { ok: false; rejection: RetirementRejection }
> {
  const publication = journal.proposal.publication;
  if (publication === null) return { ok: true, refs: [], tip: null };

  const worktree = join(journal.quarantine, "revert-tree");
  const privateRef = `refs/aw-op/${journal.digest.slice(0, 12)}/tip`;
  try {
    await deps.git.worktreeAddDetached(
      publication.repo,
      worktree,
      publication.expected_old ?? "HEAD",
    );
    for (const revert of journal.proposal.reverts) {
      const attempt = await deps.git.rehearseRevert(worktree, revert.commit, revert.mainline);
      if (!attempt.ok) {
        return {
          ok: false,
          rejection: {
            code: "EVIDENCE_MISSING",
            message: `el revert de ${revert.commit.slice(0, 12)} ya no aplica limpio`,
            candidates: attempt.conflicted,
            action: "nada se aplicó; volvé a preparar sobre el estado vigente",
          },
        };
      }
      await deps.git.commitIn(worktree, `revert ${revert.commit.slice(0, 12)} (aw retiro)`);
    }
    const tip = await deps.git.refValue(worktree, "HEAD");
    const tree = tip === null ? null : await deps.git.treeOf(worktree, tip);
    // The RESULT is what was approved. Comparing the commit id instead would fail
    // on nothing but the second it was built in.
    if (tip === null || tree !== publication.expected_tree) {
      return {
        ok: false,
        rejection: {
          code: "EVIDENCE_MISSING",
          message: "los reverts reconstruidos no producen el resultado aprobado",
          candidates: [publication.expected_tree, tree ?? "sin árbol"],
          action: "nada se aplicó; volvé a preparar y aprobá la vista previa vigente",
        },
      };
    }
    await deps.git.setRef(publication.repo, privateRef, tip);
    return { ok: true, refs: [privateRef], tip };
  } catch (err) {
    return {
      ok: false,
      rejection: {
        code: "EVIDENCE_MISSING",
        message: `no se pudieron construir los reverts: ${message(err)}`,
        candidates: [],
        action: "nada se aplicó; revisá el repositorio y volvé a aplicar",
      },
    };
  } finally {
    try {
      await deps.git.worktreeRemove(publication.repo, worktree);
    } catch {
      // Reported by `worktree list` as an orphan: a visible state, not a silent one.
    }
  }
}

/**
 * 6 and 7 — everything after the commit point, and it never gives up.
 *
 * Each step is idempotent so a second entry finishes what a first one started: a
 * path already restored is written with the same bytes, a folder already gone is a
 * no-op removal, a row already there is recognized. There is deliberately no
 * failure path back: the ref moved, and the only honest direction is forward.
 */
async function finish(
  deps: ApplyDeps,
  journal: RetirementJournal,
  alreadyApplied: boolean,
): Promise<ApplyOutcome> {
  const proposal = journal.proposal;
  const publication = proposal.publication;

  if (publication !== null) {
    // The compare-and-swap moved the REF; the working tree still holds the old
    // content. Its syncability was the precondition checked before the swap.
    await deps.git.syncTree(publication.repo, publication.ref);
  }

  const restored: string[] = [];
  for (const [index, restore] of proposal.restores.entries()) {
    await applyRestore(deps, journal, restore, index);
    restored.push(restore.path);
  }

  const removed: string[] = [];
  for (const target of proposal.deletes) {
    await deps.fs.remove(join(deps.paths.workspaceDir(), target.path));
    removed.push(target.path);
  }

  const units = await reconcileUnits(deps, proposal);
  const invalidated = await dropBindings(deps, proposal);

  await appendEvent(deps.fs, deps.paths, eventOf(proposal, (deps.now ?? (() => new Date()))()));

  for (const ref of journal.private_refs) {
    if (publication === null) continue;
    await deps.git.deleteRef(publication.repo, ref);
  }
  await deps.fs.remove(journal.quarantine);
  await dropJournal(deps.fs, deps.paths, journal.digest);

  return {
    ok: true,
    result: {
      digest: proposal.digest,
      mode: proposal.mode,
      target: proposal.event.key,
      removed,
      restored,
      bindings_invalidated: invalidated,
      published:
        publication === null
          ? null
          : {
              ref: publication.ref,
              from: publication.expected_old,
              // What really landed, read back from the journal that recorded it.
              to: journal.prepared_tip ?? publication.expected_tree,
            },
      pending_remote_publication: proposal.reverts
        .filter((r) => r.published)
        .map((r) => `${r.alias}:${r.commit.slice(0, 12)}`),
      units_released: units.released,
      pending_reconciliation: units.unreconciled,
      already_applied: alreadyApplied,
    },
  };
}

/**
 * Give back every isolation unit of the retired sessions, or report the ones git
 * refuses to release.
 *
 * Past the commit point there is no failing, so a unit that still holds
 * uncommitted work is REPORTED rather than forced away: removing a tree to tidy up
 * is the one way this feature could destroy work nobody authorized. The branch is
 * never deleted — it is the only thing keeping the session's commits reachable.
 */
async function reconcileUnits(
  deps: ApplyDeps,
  proposal: RetirementProposal,
): Promise<{ released: string[]; unreconciled: string[] }> {
  const released: string[] = [];
  const unreconciled: string[] = [];
  for (const unit of proposal.units) {
    const name = `${unit.alias}:${unit.branch}`;
    if (unit.repo.length === 0) {
      unreconciled.push(name);
      continue;
    }
    try {
      await deps.git.worktreeRemove(unit.repo, unit.path);
      await deps.git.worktreePrune(unit.repo);
      released.push(name);
    } catch {
      unreconciled.push(name);
    }
  }
  return { released, unreconciled };
}

/** Only the associations pointing at the retired sessions; never anybody else's. */
async function dropBindings(deps: ApplyDeps, proposal: RetirementProposal): Promise<number> {
  let invalidated = 0;
  for (const entry of proposal.closure) {
    if (entry.node.kind !== "session") continue;
    const dropped = await invalidateBindingsTo(deps.fs, deps.paths, entry.node.key);
    if (dropped.ok) invalidated += dropped.removed;
  }
  return invalidated;
}

/** A restore is bytes back, or a path back out of existence. */
async function applyRestore(
  deps: ApplyDeps,
  journal: RetirementJournal,
  restore: RetirementRestore,
  index: number,
): Promise<void> {
  const destination = join(deps.paths.workspaceDir(), restore.path);
  if (!restore.existed) {
    await deps.fs.remove(destination);
    return;
  }
  const staged = stagedPath(journal, index);
  // The staged copy is preferred — it is the one the journal put there — and the
  // content in the proposal is the fallback for a re-entry whose quarantine is
  // already gone. Both are the same bytes; only one of them may still exist.
  const content = (await deps.fs.exists(staged))
    ? await deps.fs.readText(staged)
    : (restore.content ?? "");
  await deps.fs.writeText(destination, content);
}

/**
 * Undo what was never visible.
 *
 * Called only from BEFORE the commit point, and it is not a compensation: the
 * quarantine and the private refs were never observable, so dropping them returns
 * the workspace to a state it never left.
 */
async function rollback(deps: ApplyDeps, journal: RetirementJournal): Promise<void> {
  const publication = journal.proposal.publication;
  for (const ref of journal.private_refs) {
    if (publication === null) continue;
    await deps.git.deleteRef(publication.repo, ref);
  }
  await deps.fs.remove(journal.quarantine);
  await dropJournal(deps.fs, deps.paths, journal.digest);
}

export interface RecoveredOperation {
  digest: string;
  /** What the recovery did about it. */
  outcome: "completed" | "rolled-back";
  target: string;
}

/**
 * Finish or discard every operation left in flight — the re-entry.
 *
 * The side of the commit point is read from the WORLD and never from the journal's
 * own phase: the ref is at the prepared tip, or the row is already in HISTORY, or
 * neither. A phase written by a process that then died is a claim about the past;
 * the ref is the present.
 */
export async function recoverPendingRetirements(deps: ApplyDeps): Promise<{
  recovered: RecoveredOperation[];
  unreadable: Array<{ path: string; reason: string }>;
}> {
  const pending = await listPendingJournals(deps.fs, deps.paths);
  const recovered: RecoveredOperation[] = [];
  for (const journal of pending.journals) {
    const past = await commitPointPassed(deps, journal);
    if (past) {
      await finish(deps, journal, true);
      recovered.push({
        digest: journal.digest,
        outcome: "completed",
        target: journal.proposal.event.key,
      });
      continue;
    }
    await rollback(deps, journal);
    recovered.push({
      digest: journal.digest,
      outcome: "rolled-back",
      target: journal.proposal.event.key,
    });
  }
  return { recovered, unreadable: pending.unreadable };
}

/**
 * Which side of the commit point the WORLD is on.
 *
 * Three readings, and none of them is the journal's own phase. The row is the
 * strongest — it only exists past the point. Then the commit this run recorded
 * building. And failing both, the ref's own TREE: the identity of the revert commit
 * may differ from the one a previous process built, but the result it produced
 * cannot, so the tree is what says whether the result is already published.
 */
async function commitPointPassed(deps: ApplyDeps, journal: RetirementJournal): Promise<boolean> {
  if (await hasEvent(deps.fs, deps.paths, journal.digest)) return true;
  const publication = journal.proposal.publication;
  if (publication === null) return false;
  const current = await deps.git.refValue(publication.repo, publication.ref);
  if (current === null) return false;
  if (journal.prepared_tip !== undefined && current === journal.prepared_tip) return true;
  return (await deps.git.treeOf(publication.repo, current)) === publication.expected_tree;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
