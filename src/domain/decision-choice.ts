import type { DecisionNote } from "./decision-note.js";
import type { EffectiveContract } from "./effective-contract.js";

/**
 * Whether this divergence needs a person at all — and if not, why not.
 *
 * Two failure modes sit on either side of this question and both are expensive.
 * Asking about something the evidence already settled trains whoever answers to
 * stop reading; deciding a preference from evidence puts a functional choice
 * nobody made into the contract, under the authority of a measurement that never
 * had an opinion about it.
 *
 * So the split is explicit. Evidence resolves FACTS: when it leaves exactly one
 * behaviour standing there is nothing to prefer, and the run proceeds. When
 * several valid behaviours survive, what is left is a preference, and a
 * preference belongs to the person — unless the same lineage already recorded
 * one durable decision that answers this exact question and whose premises are
 * still current, in which case re-asking would be asking somebody to repeat
 * themselves.
 *
 * "Premises still current" is not a second policy invented here. A note that
 * survived into {@link EffectiveContract.applied} was composed against the
 * baseline that reads now, over assertions the spec still states, and was not
 * superseded — the three premises a decision has — because
 * `composeEffectiveContract` blocks otherwise. Re-deriving them here would be a
 * second answer to a question that already has one.
 */

/** One behaviour evidence left standing, named by a key the caller can act on. */
export interface DecisionBehavior {
  key: string;
  summary: string;
}

export interface DecisionQuestion {
  /** The assertions the divergence puts in play, as `S033/AC-05`. */
  assertions: string[];
  /** Everything still valid after the evidence was read. */
  behaviors: DecisionBehavior[];
}

export type DecisionResolution =
  /** Evidence left one behaviour: a fact, and nobody is asked. */
  | { kind: "settled"; behavior: DecisionBehavior }
  /** One prior durable decision answers it and still holds. */
  | { kind: "reused"; note: string; decision: string }
  /** Several valid behaviours remain and no prior decision covers them. */
  | { kind: "ask"; behaviors: DecisionBehavior[]; why: string }
  /** Evidence ruled out everything, or the question names no assertion. */
  | { kind: "unresolvable"; why: string; action: string };

/**
 * Decide who answers: the evidence, a note already published, or the person.
 *
 * `unresolvable` is a real outcome and not a defensive branch. A question whose
 * evidence left zero behaviours has not become a preference — it has outgrown
 * the gate, and handing it to a person as if it were a choice would offer a menu
 * with nothing on it. It leaves through the escalation package instead.
 */
export function resolveDecision(
  question: DecisionQuestion,
  contract: EffectiveContract,
  chain: readonly DecisionNote[],
): DecisionResolution {
  if (question.assertions.length === 0) {
    return {
      kind: "unresolvable",
      why: "la pregunta no nombra ninguna afirmación del contrato",
      action:
        "direccioná las afirmaciones en juego como S033/AC-05: una decisión que no dice sobre qué decide no se puede componer",
    };
  }
  if (question.behaviors.length === 0) {
    return {
      kind: "unresolvable",
      why: "la evidencia descartó todas las conductas válidas",
      action:
        "escalá con el paquete: no queda ninguna alternativa que ofrecer, así que esto ya no es una preferencia",
    };
  }
  // Evidence first, and only over facts: one behaviour standing means there is
  // nothing to prefer. Reaching for a prior note here would let a recorded
  // preference override a fact the evidence just established.
  const [only] = question.behaviors;
  if (question.behaviors.length === 1 && only !== undefined) {
    return { kind: "settled", behavior: only };
  }

  const inForce = new Set(contract.applied);
  const asked = new Set(question.assertions);
  const touching = chain.filter(
    (note) => inForce.has(note.id) && note.supersedes_assertions.some((id) => asked.has(id)),
  );
  const [candidate] = touching;
  if (
    touching.length === 1 &&
    candidate !== undefined &&
    coversQuestion(candidate, question.assertions)
  ) {
    return { kind: "reused", note: candidate.id, decision: candidate.decision };
  }
  return { kind: "ask", behaviors: question.behaviors, why: whyAsk(touching) };
}

/**
 * The three different reasons a preference still belongs to the person.
 *
 * They are kept apart because they send whoever reads them somewhere else:
 * nothing to reuse means decide; one partial note means decide the remainder and
 * say so; several notes means the question spans decisions that were taken
 * separately, and the answer has to reconcile them rather than pick one.
 */
function whyAsk(touching: readonly DecisionNote[]): string {
  if (touching.length === 0) {
    return "quedan varias conductas válidas y ninguna decisión durable previa las cubre";
  }
  if (touching.length === 1) {
    return `${touching[0]?.id} decide sobre parte de estas afirmaciones y deja el resto sin decidir`;
  }
  return `${touching.map((note) => note.id).join(" y ")} deciden sobre partes distintas de estas afirmaciones y ninguna responde la pregunta entera`;
}

/**
 * Whether one note answers the WHOLE question.
 *
 * Partial coverage is not reuse: a note that superseded two of the three
 * assertions in play leaves the third undecided, and treating it as an answer
 * would decide that third one by silence — exactly the preference-from-evidence
 * this function exists to prevent, only harder to see.
 */
function coversQuestion(note: DecisionNote, assertions: readonly string[]): boolean {
  const superseded = new Set(note.supersedes_assertions);
  return assertions.every((id) => superseded.has(id));
}
