import type { DecisionNote, ObligationKind } from "./decision-note.js";
import type { EffectiveContract } from "./effective-contract.js";
import { correspondingPlanItem, planHandoffItems } from "./obligation-correspondence.js";

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
 *
 * And "open" is not one thing. Only a COMPENSATION is work this lineage owes,
 * and only a compensation may hold its closure shut. A HANDOFF is work somebody
 * outside the run took on: it stays listed, it stays visible after the plan
 * closes, and it blocks nothing — because a run that cannot discharge it could
 * never close, which is exactly the deadlock this split exists to end.
 */

export interface PendingObligation {
  /** The work, in the words the note stated it. */
  text: string;
  /** The note that created it — an obligation never loses its cause. */
  by: string;
  /** Its position in that note's list: the only stable name it has. */
  index: number;
  /**
   * The point the NOTE recorded the day it was written — history, and audit only.
   *
   * Never offered as somewhere to come back to. By the time anybody settles the
   * obligation, the phase the note named may be validated and its commits
   * integrated, and sending them there is sending them into work already done —
   * which is exactly what left a real plan being told to resume inside a phase
   * nobody could reopen. Where a plan is actually resumed from is derived from
   * what the plan says NOW, and that is the point every surface names.
   */
  declared_point: string;
  /** What this obligation is for: only `compensation` holds the closure shut. */
  kind: ObligationKind;
  /**
   * `true` when the NOTE did not state the class and this reading supplied it.
   *
   * Kept because the two are not the same fact: a settlement offered over a
   * class nobody declared is a reading being proposed, and whoever answers it
   * deserves to know that is what they are ratifying.
   */
  legacy: boolean;
  /** The plan item that made a legacy obligation read as a handoff, if any. */
  corresponds_to?: string;
  /**
   * The REPAIR, when what is owed is not compensatory work but a broken lineage.
   *
   * A reconciliation is also how "nobody can read this chain" is reported: the
   * refusal itself becomes what is owed, because the plan may owe nothing and it
   * may owe everything, and the one certain thing is that closing it now would
   * be a guess. For those entries there is no phase to come back to — the phases
   * are not what is wrong — so the exit names this instead of a resume point.
   * Only the projection that fabricates them sets it.
   */
  repair?: string;
}

export interface PlanReconciliation {
  /**
   * Every COMPENSATION still in force, in the order the chain applied them.
   *
   * The name is unchanged on purpose: this is the list that was always the one
   * gating a closure, and every surface reading `pending` kept the meaning it
   * had. What changed is that a handoff no longer lands in it.
   */
  pending: PendingObligation[];
  /** Every handoff still in force: visible, never blocking. */
  handoffs: PendingObligation[];
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
  planText?: string,
): PlanReconciliation {
  const resumeOf = new Map(chain.map((note) => [note.id, note.resume_point]));
  // Read once for the whole reconciliation: every legacy obligation of one plan
  // is judged against one reading of that plan's own enumerated handoffs.
  const items = planText === undefined ? [] : planHandoffItems(planText);
  const pending: PendingObligation[] = [];
  const handoffs: PendingObligation[] = [];
  for (const obligation of contract.obligations) {
    const resume = resumeOf.get(obligation.by);
    // An obligation whose note is not in the chain handed over cannot say where
    // to resume, and inventing a point would send the run somewhere nobody
    // decided. It stays pending — which is the safe half — and names its note.
    const cited = obligation.declared ? null : correspondingPlanItem(obligation.text, items);
    const entry: PendingObligation = {
      text: obligation.text,
      by: obligation.by,
      index: obligation.index,
      declared_point: resume ?? `${obligation.by} (nota ausente de la cadena)`,
      // A declared class is the note's own word and is never second-guessed. An
      // undeclared one reads as a handoff only when the plan itself enumerates
      // that exact work; anything else keeps the safe reading.
      kind: obligation.declared ? obligation.kind : cited === null ? "compensation" : "handoff",
      legacy: !obligation.declared,
      ...(cited === null ? {} : { corresponds_to: cited }),
    };
    (entry.kind === "handoff" ? handoffs : pending).push(entry);
  }
  return { pending, handoffs, closable: pending.length === 0 };
}

/** The run that holds a plan, as much of it as an exit needs in order to name it. */
export interface HoldingRunRef {
  session: string;
  /** The command that continues THAT run. Quoted, never paraphrased. */
  command: string;
  /**
   * WHY it counts as holding the plan, in the reading's own words.
   *
   * Quoted rather than paraphrased, because the three readings are not the same
   * claim: one run really has this plan in its scope, another has a state nobody
   * can read, a third has not fixed its plan yet. Writing "tiene la corrida
   * abierta sobre este plan" over the last two would assert something the
   * reading deliberately refused to assert.
   */
  why: string;
}

/** The live facts an exit is named from — none of them derived twice. */
export interface ExitContext {
  /** The plan document, named the way every surface names it. */
  plan: string;
  /**
   * Where the plan stands NOW: its first phase short of validated, or its
   * closure. Derived from the document rather than from any note.
   */
  current_point: string;
  /** The session whose live run holds this plan, or `null` when none does. */
  run: HoldingRunRef | null;
}

/**
 * WHAT A PLAN OWES AND HOW SOMEBODY GETS OUT OF IT — said once, for everybody.
 *
 * Three surfaces used to describe this one situation in three sets of words: the
 * refusal that would not let the plan be sealed, the board's headline, and the
 * action under the pipeline row. They drifted, as three texts about one fact
 * always do — and the drift was not cosmetic. One of them sent the reader back
 * to the point a note recorded at birth, one offered no command at all, and none
 * of them mentioned the command that actually settles anything. So the exit is
 * derived HERE, and each surface takes the part it renders.
 *
 * `null` means nothing is owed. Otherwise there is always a `command`: a refusal
 * with no exit is a wall, and this whole phase exists because the board had one.
 */
export function obligationExit(
  reconciliation: PlanReconciliation,
  context: ExitContext,
): ObligationExit | null {
  const owed = whatIsOwed(reconciliation);
  if (owed === null) return null;
  if (owed.repair !== undefined) return unreadableExit(owed.text, owed.repair, context);
  return owed.kind === "compensation"
    ? compensationExit(owed.text, context)
    : handoffExit(owed.text, context);
}

/** The exit itself: the words, and the one command that reaches it. */
export interface ObligationExit {
  /** `compensation` holds the closure shut; `handoff` never does. */
  kind: ObligationKind;
  /** What is owed: the note that created it, the work, and how many more. */
  owed: string;
  /** {@link ExitContext.current_point}, carried so no surface re-derives it. */
  point: string;
  /** The command that reaches the settlement. Never null, never empty. */
  command: string;
  /** What that command does, as an instruction somebody can follow. */
  action: string;
  /** The one line a board prints about it. */
  headline: string;
}

/**
 * The first thing owed, and of which class — compensation before handoff.
 *
 * A plan owing both is held by the compensation, so that is what its exit has to
 * be about; the handoff is still listed underneath. And "not closable with
 * nothing named" is the composition refusing itself — reported as the shape it
 * is, because falling through to the handoffs there would describe a plan that
 * cannot be read as one that merely delegated some work.
 */
function whatIsOwed(
  reconciliation: PlanReconciliation,
): { kind: ObligationKind; text: string; repair?: string } | null {
  const [compensation] = reconciliation.pending;
  if (compensation !== undefined) {
    return {
      kind: "compensation",
      text: named(compensation, reconciliation.pending.length),
      ...(compensation.repair === undefined ? {} : { repair: compensation.repair }),
    };
  }
  if (!reconciliation.closable) {
    return { kind: "compensation", text: "el contrato efectivo no se puede componer" };
  }
  const [handoff] = reconciliation.handoffs;
  if (handoff === undefined) return null;
  return { kind: "handoff", text: named(handoff, reconciliation.handoffs.length) };
}

/**
 * How a surface says that a class is a READING, not the note's own word.
 *
 * One phrase for every surface that shows it, because two spellings of it is
 * two answers to "did a person ratify this?" — and that question is the whole
 * point of keeping the distinction.
 */
export function readingMark(kind: ObligationKind): string {
  return `clase no declarada, leída ${kind === "handoff" ? "traspaso" : "compensación"}`;
}

/** `DEC-001 — revalidar F1 (+2 más)`: the cause, the work, and the rest of them. */
function named(obligation: PendingObligation, total: number): string {
  const more = total - 1;
  const rest = more > 0 ? ` (+${more} más)` : "";
  // A fabricated pending has no cause to keep: its `by` is a label the
  // projection invented for a note nobody wrote, and printing it as the author
  // of the work would be the second wrong text about the same fact.
  const cause = obligation.repair === undefined ? `${obligation.by} — ` : "";
  // And an undeclared class travels as what it is. The non-blocking reading is
  // the one most worth flagging: a legacy handoff makes the plan closable, and a
  // board asserting it as the note's own word hides that nobody ratified it.
  const read = obligation.legacy ? ` (${readingMark(obligation.kind)})` : "";
  return `${cause}${obligation.text}${read}${rest}`;
}

function compensationExit(owed: string, context: ExitContext): ObligationExit {
  const settle = `aw settle prepare ${context.plan}`;
  const run = context.run;
  return {
    kind: "compensation",
    owed,
    point: context.current_point,
    command: run === null ? settle : run.command,
    // With a run open the settlement rows are inside it, and the hedge is not
    // padding: the cursor only ever grows, so a run already past them cannot go
    // back — and for that one the exit is the command, once its journey ends.
    action:
      run === null
        ? `no hay corrida abierta sobre '${context.plan}': leé y declará el saldo con '${settle}', y aplicalo con el digest que devuelve`
        : `la sesión ${run.session} ${run.why}, y la frontera de saldo de una corrida es donde se declara la evidencia: si todavía no la pasó, seguila con '${run.command}'; si ya la pasó, la salida es '${settle}' cuando el recorrido termine`,
    headline: `COMPENSACIÓN VIGENTE por ${owed}: retomá en ${context.current_point}, ni ejecutable ni cerrable tal cual`,
  };
}

/**
 * The exit of a lineage nobody can read — the repair, and nothing about phases.
 *
 * `point` carries the plan's current point anyway, because a caller may still
 * want to say where the plan stands; what changes is that no TEXT offers it,
 * since a broken chain is not fixed by going back to a phase. The old board
 * printed `retomá en <repair>` — the right instruction under the wrong label —
 * and F4's rule that a declared point never reaches a surface would have dropped
 * it altogether: the one actionable sentence in the whole situation.
 */
function unreadableExit(owed: string, repair: string, context: ExitContext): ObligationExit {
  const settle = `aw settle prepare ${context.plan}`;
  const run = context.run;
  return {
    kind: "compensation",
    owed,
    point: context.current_point,
    command: run === null ? settle : run.command,
    action: `${repair}. Después de eso el linaje vuelve a leerse${
      run === null
        ? `, y la salida es '${settle}'`
        : `, y la sesión ${run.session} —que ${run.why}— sigue con '${run.command}'`
    }`,
    headline: `LINAJE ILEGIBLE por ${owed} — ${repair}: ni ejecutable ni cerrable tal cual`,
  };
}

function handoffExit(owed: string, context: ExitContext): ObligationExit {
  const settle = `aw settle prepare ${context.plan}`;
  const run = context.run;
  return {
    kind: "handoff",
    owed,
    point: context.current_point,
    command: run === null ? settle : run.command,
    action:
      run === null
        ? `el traspaso no bloquea nada: reconocelo con '${settle}', y saldalo ahí mismo cuando el trabajo de afuera esté hecho`
        : `el traspaso no bloquea nada: la sesión ${run.session} ${run.why}, así que lo ve en la frontera de saldo de esa corrida; fuera de una corrida se reconoce con '${settle}'`,
    headline: `TRASPASO VIGENTE por ${owed}: es trabajo de afuera y no bloquea el cierre; el plan está en ${context.current_point}`,
  };
}
