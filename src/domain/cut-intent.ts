/**
 * The intent a person had when they cut one spec into several plans.
 *
 * The workspace already knows which plans descend from which spec — the
 * provenance graph proves that edge from the plan's own `Derived from` line. What
 * it has never known is the part that only a person can say: which of those plans
 * were meant to go together, in what order inside the group, and which were held
 * back on purpose for a later pass.
 *
 * That intent lived exactly one place until now — the conversation that produced
 * it — so the only order the board could offer was the correlative, which is an
 * accident of when a document was minted and not a decision anybody made.
 *
 * It is a fact, not a constraint. Nothing here blocks: a plan the intent put
 * later is still executable, and the arnés says what it expected instead of
 * refusing. Declaring an order somebody may deviate from is the whole point —
 * an order that cannot be deviated from would be a schedule, and a schedule is
 * exactly what an execution arnés must not impose on the person running it.
 */

import { type WorklineNodeId, formatNodeId } from "./workline-node.js";

/** Thrown with a `code` the CLI layer turns into `{ ok: false, error }`. */
export class CutIntentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CutIntentError";
  }
}

export interface CutIntent {
  /** The spec whose cut this is — what makes the plans siblings at all. */
  spec: WorklineNodeId;
  /**
   * The plans meant for the pass in progress, in the order they were meant to
   * run. Position is the declaration: index 0 goes first.
   */
  order: WorklineNodeId[];
  /**
   * Plans held back for a later pass, deliberately unordered among themselves.
   *
   * Kept apart from `order` rather than appended to its tail, because "after
   * these" and "not in this pass" are different facts and only the second one
   * explains why a plan the board could otherwise recommend is not being
   * recommended.
   */
  deferred: WorklineNodeId[];
}

/**
 * What the workspace answers about one plan's place in a cut.
 *
 * `declared: false` is a first-class answer and NOT an empty `order`. A reader
 * that cannot tell "nobody said" from "said, and it is empty" will fill the
 * silence with the correlative and present the result as somebody's decision —
 * which is the exact failure this whole record exists to end.
 */
export type CutIntentReading =
  | { declared: true; intent: CutIntent; at: string; position: CutPosition }
  | { declared: false; reason: string };

/** Where one plan sits inside a declared cut. */
export type CutPosition =
  /** In the pass in progress, at this 0-based index of `order`. */
  | { placement: "in-pass"; index: number }
  /** Held back for a later pass; `after` is what it is waiting on. */
  | { placement: "deferred"; after: WorklineNodeId[] }
  /** The cut was declared, and it does not mention this plan. */
  | { placement: "unmentioned" };

/** Every plan the intent names — order first, then the deferred. */
function plansOf(intent: CutIntent): WorklineNodeId[] {
  return [...intent.order, ...intent.deferred];
}

/** Where this plan sits, without deciding whether the cut was declared at all. */
export function positionOf(intent: CutIntent, plan: WorklineNodeId): CutPosition {
  const key = formatNodeId(plan);
  const index = intent.order.findIndex((node) => formatNodeId(node) === key);
  if (index !== -1) return { placement: "in-pass", index };
  const deferred = intent.deferred.some((node) => formatNodeId(node) === key);
  // What a deferred plan waits on is the whole `order`, not its tail: the pass
  // is the unit that unblocks it, and naming only the last plan would say the
  // wrong thing the moment somebody reorders the group.
  if (deferred) return { placement: "deferred", after: [...intent.order] };
  return { placement: "unmentioned" };
}

/**
 * Validate a declaration before it can be appended.
 *
 * Manual, per DEC-001. Checked here rather than at the CLI edge because the
 * ledger is append-only: a malformed record cannot be corrected, only buried
 * under a later one, so the cheapest place to refuse is before the write.
 */
export function assertDeclarable(intent: CutIntent): void {
  if (intent.spec.kind !== "spec") {
    throw new CutIntentError(
      "CUT_INTENT_NOT_A_SPEC",
      `una intención de corte se declara sobre una spec, no sobre '${formatNodeId(intent.spec)}'`,
    );
  }
  const plans = plansOf(intent);
  if (plans.length === 0) {
    throw new CutIntentError(
      "CUT_INTENT_EMPTY",
      "una intención de corte sin ningún plan no declara nada: nombrá al menos uno",
    );
  }
  const foreign = plans.find((node) => node.kind !== "plan");
  if (foreign !== undefined) {
    throw new CutIntentError(
      "CUT_INTENT_NOT_A_PLAN",
      `una intención de corte agrupa planes, y '${formatNodeId(foreign)}' no lo es`,
    );
  }
  const seen = new Set<string>();
  for (const node of plans) {
    const key = formatNodeId(node);
    // One plan in both lists would make the same document simultaneously part of
    // this pass and held back from it, and every reader would resolve that
    // contradiction its own way.
    if (seen.has(key)) {
      throw new CutIntentError(
        "CUT_INTENT_DUPLICATE_PLAN",
        `'${key}' aparece dos veces en la misma intención: un plan está en el pase o queda para después, nunca las dos cosas`,
      );
    }
    seen.add(key);
  }
}
