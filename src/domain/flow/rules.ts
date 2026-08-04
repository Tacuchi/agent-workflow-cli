/**
 * The rules that read the registry's declarative fields — thresholds,
 * conditions and the binding of an invocation to a run.
 *
 * They live apart from the table for the same reason the table is a table: the
 * registry says WHAT each transition declares, and this module says what those
 * declarations MEAN. Every function here is pure and takes what it needs as
 * arguments, so a fixture journey exercises exactly the code production walks.
 *
 * Two of them are fail-closed in the direction that costs the least: a condition
 * that cannot be resolved does NOT skip its transition — a registry mistake must
 * make the run ask, never make it drop a step in silence — and an invocation with
 * an unbound placeholder is refused rather than emitted, because a command nobody
 * can run is worse than a boundary that says why it could not be built.
 */

import {
  type DelegatedAction,
  type FlowDecision,
  RUN_PLACEHOLDERS,
  type SignalThreshold,
  conditionOf,
} from "./authority.js";

/** What the agent declared at one boundary, as the run persisted it. */
export interface DeclaredObservation {
  transition: string;
  signals: readonly string[];
}

/**
 * Whether a threshold fired, counted over what was actually observed.
 *
 * Only DISTINCT signals the observed row declares are counted: a repeated signal
 * is one observation sent twice, and a signal belonging to another boundary is
 * not this rule's evidence. Both would otherwise let a gate fire on noise.
 */
export function thresholdFired(
  rule: SignalThreshold,
  journey: readonly FlowDecision[],
  observations: readonly DeclaredObservation[],
): boolean {
  const observed = journey.find((decision) => decision.id === rule.observed);
  if (observed === undefined) return false;
  // The subset the rule names, intersected with what the row actually declares:
  // a rule may only count signals its observed boundary can produce, so a typo in
  // `of` narrows to nothing instead of counting something else.
  const declaredVocabulary = observed.signals ?? [];
  const counted = rule.of ?? declaredVocabulary;
  const vocabulary = new Set(declaredVocabulary.filter((signal) => counted.includes(signal)));
  const declared = observations
    .filter((observation) => observation.transition === rule.observed)
    .flatMap((observation) => observation.signals)
    .filter((signal) => vocabulary.has(signal));
  return new Set(declared).size >= rule.min;
}

/**
 * Why this transition is passed over — or `null` when it happens.
 *
 * The reason travels instead of a bare boolean because the trace has to be able
 * to say what was skipped and why: `applied.length` is the journey's cursor, so a
 * step nobody applied still has to be accounted for, and "it did not happen"
 * without a cause is indistinguishable from a step that was lost.
 */
export function skipReason(
  decision: FlowDecision,
  journey: readonly FlowDecision[],
  observations: readonly DeclaredObservation[],
): string | null {
  const condition = conditionOf(decision);
  if (condition === null) return null;
  // No evidence means the rule did not fire, and a rule that did not fire skips.
  // That is the doctrine's own default — "borderline continues without asking" —
  // and it is the direction that assumes nothing: the alternative would emit a
  // question on zero observations and then read the answer as if it had cause.
  if (thresholdFired(condition.threshold, journey, observations)) return null;
  return condition.otherwise;
}

/** The run's own coordinates, the only things an invocation may reference. */
export interface RunBinding {
  session: string;
  code: string;
}

export type ActionBinding = { ok: true; action: DelegatedAction } | { ok: false; unbound: string };

/**
 * The action as it will be emitted: every placeholder replaced by this run's
 * coordinates.
 *
 * Binding happens before the seal is computed, so what gets sealed, what gets
 * shown and what the result is compared against are the same three strings. A
 * placeholder left over means the registry referenced something this run cannot
 * supply, and that is returned as a failure rather than emitted — `{session}`
 * printed in a command line is the kind of defect that only surfaces when
 * somebody tries to run it.
 */
export function bindAction(action: DelegatedAction, binding: RunBinding): ActionBinding {
  // Driven by the closed set, not by two hardcoded replacements: the vocabulary
  // and what it binds to are one decision, and splitting them is how a declared
  // placeholder ends up with nothing replacing it.
  const value: Record<(typeof RUN_PLACEHOLDERS)[number], string> = {
    "{session}": binding.session,
    "{code}": binding.code,
  };
  const bind = (text: string): string =>
    RUN_PLACEHOLDERS.reduce(
      (bound, placeholder) => bound.split(placeholder).join(value[placeholder]),
      text,
    );
  const bound: DelegatedAction = {
    ...action,
    invocation: {
      ...action.invocation,
      args: action.invocation.args.map(bind),
      target: bind(action.invocation.target),
      input: action.invocation.input === null ? null : bind(action.invocation.input),
    },
  };
  const unbound = unboundPlaceholder(bound);
  return unbound === null ? { ok: true, action: bound } : { ok: false, unbound };
}

/**
 * The first placeholder still standing after binding, if any.
 *
 * It looks for the SHAPE, not only the two known names: `{sesion}` is a typo that
 * binds to nothing, and reporting it as "unbound" beats emitting a command with a
 * brace in it. The stdin payload is exempt — a JSON body legitimately carries
 * braces, and refusing those would make the field unusable.
 */
const PLACEHOLDER_SHAPE = /\{[a-z_-]+\}/;

function unboundPlaceholder(action: DelegatedAction): string | null {
  const parts = [action.invocation.program, ...action.invocation.args, action.invocation.target];
  for (const part of parts) {
    const found = PLACEHOLDER_SHAPE.exec(part);
    if (found !== null) return found[0];
  }
  return null;
}
