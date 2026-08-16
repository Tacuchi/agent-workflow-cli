import type { DecisionNote, NoteFailure } from "./decision-note.js";
import type { EffectiveContract } from "./effective-contract.js";

/**
 * WHAT A DECISION LEFT OWING, and why the past keeps its history anyway.
 *
 * A note that invalidates work already closed is the case every "just re-open
 * it" instinct gets wrong. Un-ticking a task or moving a phase back to
 * `pendiente` would rewrite what happened: those boxes record that the work was
 * done and validated on the day it was, and that remains true — what changed is
 * that the contract it satisfied is no longer the contract in force. So nothing
 * historical moves. The decision creates NEW work instead, carried by the
 * effective contract rather than by the plan document, and the plan stops being
 * closable until that work is settled.
 *
 * Which makes "open" need an exact meaning, and it has one already: an
 * obligation is open while it is in the effective contract. It is settled the
 * only way anything is settled in an append-only chain — by publishing a note
 * that supersedes the one carrying it and does not carry it forward. There is
 * deliberately no second ledger of "done obligations": a discharge recorded
 * outside the chain could disagree with the chain, and then two readings of the
 * same reconciliation would coexist with nothing to break the tie.
 */

export interface PendingObligation {
  /** The compensatory work, in the words the note stated it. */
  text: string;
  /** The note that created it — an obligation never loses its cause. */
  by: string;
  /** Where execution comes back to settle it, from the note's own resume point. */
  resume_point: string;
}

export interface PlanReconciliation {
  /** Every obligation still in force, in the order the chain applied them. */
  pending: PendingObligation[];
  /**
   * Where the run resumes: the FIRST obligation reached, or `null` when none is.
   *
   * First and not newest. The chain is applied in order, so the earliest
   * unsettled obligation is the furthest back the work has to go; resuming at a
   * later one would step over work the earlier decision is still owed.
   */
  resume_point: string | null;
  /** `false` while anything is pending — the plan may not be declared closed. */
  closable: boolean;
}

/**
 * Project what the composed contract still owes.
 *
 * Reads the contract's obligations rather than the chain's, because the contract
 * is the one place that already decided which notes are in force. Walking the
 * chain again here would be a second answer to that question.
 */
export function reconciliationOf(
  contract: EffectiveContract,
  chain: readonly DecisionNote[],
): PlanReconciliation {
  const resumeOf = new Map(chain.map((note) => [note.id, note.resume_point]));
  const pending: PendingObligation[] = [];
  for (const obligation of contract.obligations) {
    const resume = resumeOf.get(obligation.by);
    // An obligation whose note is not in the chain handed over cannot say where
    // to resume, and inventing a point would send the run somewhere nobody
    // decided. It stays pending — which is the safe half — and names its note.
    pending.push({
      text: obligation.text,
      by: obligation.by,
      resume_point: resume ?? `${obligation.by} (nota ausente de la cadena)`,
    });
  }
  return {
    pending,
    resume_point: pending[0]?.resume_point ?? null,
    closable: pending.length === 0,
  };
}

/**
 * Whether this plan may be declared closed, and what to do when it may not.
 *
 * The refusal is the point of the whole phase: a validated result stops counting
 * as sufficient proof of a contract it no longer satisfies. Letting the plan
 * close anyway would file the compensatory work as finished by the very run that
 * created it.
 */
export function checkClosable(reconciliation: PlanReconciliation): NoteFailure[] {
  if (reconciliation.closable) return [];
  const owed = reconciliation.pending
    .map((obligation) => `${obligation.by}: ${obligation.text}`)
    .join("; ");
  return [
    {
      code: "RECONCILIATION_PENDING",
      message: `el plan tiene compensación abierta y no se puede declarar cerrado — ${owed}`,
      action: `resolvé el trabajo compensatorio desde ${reconciliation.resume_point} y publicá una nota que sustituya a la que lo creó sin volver a arrastrarlo: así se salda una obligación en una cadena append-only`,
    },
  ];
}
