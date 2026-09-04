import type { DecisionNote, NoteFailure, NoteObligation, ObligationKind } from "./decision-note.js";

/**
 * HOW AN OBLIGATION IS SETTLED WITHOUT LEAVING THE CHAIN.
 *
 * In an append-only chain nothing is discharged by ticking it off: a note is
 * settled by publishing ANOTHER note that supersedes the one carrying it and
 * does not carry it forward. And supersession is by whole note — `effectiveNotes`
 * removes the superseded record with its assertions, its evidence and its
 * scope — so a note that merely wants to drop one obligation has to carry
 * everything else across, or dropping the obligation also un-amends the criteria
 * the original amended.
 *
 * That carrying is mechanical, which is exactly why it is derived here instead
 * of being authored. Two callers need it — the closure of a run and the
 * transversal command that unblocks a plan with no run open — and if each built
 * its own successor they could disagree about what a settlement preserves, with
 * the chain recording whichever one happened to run.
 *
 * There is deliberately no second ledger of settled obligations: the settlement
 * note IS the record, and it is superseded in its turn like any other.
 */

/** What the run says about one obligation of one note. */
export interface ObligationSettlement {
  /** The note carrying it. */
  note: string;
  /** Its position in that note's list — the only stable name an obligation has. */
  index: number;
  /**
   * `settled` drops it and needs its evidence; `handoff` keeps it, reclassified
   * as somebody else's work; `pending` keeps it exactly as it is.
   */
  outcome: "settled" | "handoff" | "pending";
  /** What proves the work was done. Required for `settled`, refused otherwise. */
  evidence?: string;
}

export type SettlementDerivation =
  | { ok: true; draft: Omit<DecisionNote, "id" | "digest">; settled: string[] }
  /** Nothing to publish: every obligation of this note stays exactly as it is. */
  | { ok: true; draft: null; settled: [] }
  | { ok: false; failures: NoteFailure[] };

export interface SettlementContext {
  /** Session that settles — the run's, or the carrier's when there is no run. */
  session: string;
  /** Phase that settles, same rule. */
  phase: string;
  /** Calendar date of the settlement, `YYYY-MM-DD`. */
  date: string;
  /**
   * The class the reconciliation already read for each obligation, by position.
   *
   * Load-bearing, and the reason is the write path: a note being MINTED must
   * state every class, so a successor that carried an unclassed obligation
   * forward verbatim could never be appended — the settlement of the very
   * incident this exists for would refuse itself. The reading is not invented
   * here either: it is the one the reconciliation computed from the note and the
   * plan, so the chain records exactly what the board reported.
   */
  resolved: ReadonlyMap<number, ObligationKind>;
}

/**
 * The successor of one carrier note, or `null` when it would change nothing.
 *
 * Everything but the settled obligations crosses over: the decision, its reason,
 * the assertions it amends, its scope, its consumers and its evidence. What the
 * settlement adds is the evidence each discharge produced — evidence that still
 * counts is exactly what `evidence_preserved` is for — and what it removes is
 * the obligations somebody actually did.
 *
 * `null` and not an empty note: publishing a successor identical in force to its
 * predecessor would grow the chain by one record per attempt and say nothing.
 */
export function deriveSettlementNote(
  carrier: DecisionNote,
  settlements: readonly ObligationSettlement[],
  at: SettlementContext,
): SettlementDerivation {
  const mine = settlements.filter((settlement) => settlement.note === carrier.id);
  const failures = checkSettlements(carrier, mine);
  if (failures.length > 0) return { ok: false, failures };

  const byIndex = new Map(mine.map((settlement) => [settlement.index, settlement]));
  const kept: NoteObligation[] = [];
  const classified: NoteObligation[] = [];
  const settled: string[] = [];
  const evidence: string[] = [];
  for (const [index, obligation] of carrier.obligations.entries()) {
    const settlement = byIndex.get(index);
    if (settlement !== undefined && settlement.outcome === "settled") {
      settled.push(obligation.text);
      if (settlement.evidence !== undefined) evidence.push(settlement.evidence);
      continue;
    }
    const held =
      settlement?.outcome === "handoff" ? reclassified(obligation, "handoff") : obligation;
    kept.push(held);
    // Anything still unclassed leaves carrying the reading the board already
    // reported FOR THAT POSITION — that is what "clasifica lo que queda" means,
    // and without it the successor could not be appended at all. The position is
    // the carrier's, never the survivors': dropping one shifts the rest.
    classified.push(held.declared ? held : reclassified(held, at.resolved.get(index) ?? held.kind));
  }

  if (settled.length === 0 && sameObligations(carrier.obligations, classified)) {
    return { ok: true, draft: null, settled: [] };
  }
  return {
    ok: true,
    settled,
    draft: {
      schema: carrier.schema,
      lineage: {
        spec: carrier.lineage.spec,
        plan: carrier.lineage.plan,
        // The settling run when there is one; the carrier's own when `aw settle`
        // acts on a plan whose run is long closed. Either way it is a real
        // session and a real phase, never a placeholder.
        execution: { session: at.session, phase: at.phase },
      },
      decision: carrier.decision,
      reason: carrier.reason,
      supersedes_assertions: [...carrier.supersedes_assertions],
      supersedes_note: carrier.id,
      scope: carrier.scope,
      consumers: [...carrier.consumers],
      evidence_preserved: [...carrier.evidence_preserved, ...evidence],
      evidence_invalidated: [...carrier.evidence_invalidated],
      obligations: classified,
      resume_point: carrier.resume_point,
      date: at.date,
    },
  };
}

function reclassified(obligation: NoteObligation, kind: ObligationKind): NoteObligation {
  return { text: obligation.text, kind, declared: true };
}

function sameObligations(
  before: readonly NoteObligation[],
  after: readonly NoteObligation[],
): boolean {
  return (
    before.length === after.length &&
    before.every((obligation, index) => {
      const other = after[index];
      return (
        other !== undefined &&
        other.text === obligation.text &&
        other.kind === obligation.kind &&
        other.declared === obligation.declared
      );
    })
  );
}

/**
 * Every way a settlement can fail to name real work, each with its own code.
 *
 * A settlement that points at an obligation the note does not carry, or that
 * claims work is done without saying what proves it, is not a slightly worse
 * settlement: it is a discharge nobody can audit, and the chain would record it
 * as authoritative.
 */
function checkSettlements(
  carrier: DecisionNote,
  settlements: readonly ObligationSettlement[],
): NoteFailure[] {
  const failures: NoteFailure[] = [];
  const seen = new Set<number>();
  for (const settlement of settlements) {
    const obligation = carrier.obligations[settlement.index];
    if (obligation === undefined) {
      failures.push({
        code: "SETTLEMENT_OBLIGATION_ABSENT",
        message: `${carrier.id} no tiene una obligación en la posición ${settlement.index}`,
        action: `esa nota carga ${carrier.obligations.length} obligación(es): saldá una que exista`,
      });
      continue;
    }
    if (seen.has(settlement.index)) {
      failures.push({
        code: "SETTLEMENT_OBLIGATION_REPEATED",
        message: `${carrier.id} recibe dos saldos para la misma obligación: ${obligation.text}`,
        action: "una obligación se salda una vez; decidí cuál de las dos lecturas vale",
      });
      continue;
    }
    seen.add(settlement.index);
    if (settlement.outcome === "settled" && (settlement.evidence ?? "").trim().length === 0) {
      failures.push({
        code: "SETTLEMENT_EVIDENCE_MISSING",
        message: `se declara cumplida '${obligation.text}' sin decir qué lo prueba`,
        action:
          "declará la evidencia del saldo: un comando corrido, una prueba o una inspección; sin eso no es un saldo, es una afirmación",
      });
    }
    if (settlement.outcome !== "settled" && settlement.evidence !== undefined) {
      failures.push({
        code: "SETTLEMENT_EVIDENCE_UNEXPECTED",
        message: `'${obligation.text}' no se declara cumplida y aun así trae evidencia`,
        action: "la evidencia acredita un saldo: sacala, o declará la obligación cumplida",
      });
    }
  }
  return failures;
}
