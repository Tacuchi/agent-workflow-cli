/**
 * What a transition is allowed to DO during an automatic advance.
 *
 * The classification and the authorization policy are the ones already
 * delivered: {@link authorizeEffects} decides, using the closed effect taxonomy
 * and `SELF_AUTHORIZABLE_CLASSES`. There is deliberately no second policy here —
 * a second one could contradict the first, and then "was this authorized?" would
 * have two answers.
 *
 * The rule the spec asks for falls out of that: reading and creating something
 * new inside the target the caller already named are what an invocation may grant
 * itself; overwriting, running code, leaving the machine and destroying are not,
 * so the advance stops at a human boundary naming the effect instead of
 * degrading silently or applying half of it.
 */

import { semanticDigest } from "../../application/semantic-operation/protocol.js";
import {
  type EffectClass,
  type EffectDeclaration,
  authorizeEffects,
} from "../capability/effects.js";
import { type FlowDecision, effectsOf } from "./authority.js";

export interface TransitionAuthorization {
  planned: EffectClass[];
  /** Covered by the taxonomy itself or by an authorization the run already holds. */
  covered: EffectClass[];
  /** Still needs an approval nobody granted. Non-empty ⇒ the advance stops. */
  missing: EffectClass[];
}

/**
 * Decide whether the run may apply this transition right now.
 *
 * The declarations handed to `authorizeEffects` say `invocation`/`none` on
 * purpose: that defers the whole verdict to the taxonomy's own gate
 * (`SELF_AUTHORIZABLE_CLASSES`), which is exactly "no second policy". `idempotent`
 * is required by the shape and is not read by the authorization path.
 */
export function authorizeTransition(
  decision: FlowDecision,
  granted: readonly EffectClass[],
): TransitionAuthorization {
  const planned = [...effectsOf(decision)];
  const declarations: EffectDeclaration[] = planned.map((effect) => ({
    class: effect,
    idempotent: true,
    authorization: "invocation",
    approval: "none",
  }));
  // A flow transition writes inside the session or the flow's own document — the
  // target the run already named — and reads no sensitive source of its own.
  const verdict = authorizeEffects(declarations, {
    sensitiveSources: false,
    scopeExpanded: false,
  });
  const held = new Set(granted);
  const covered = [
    ...verdict.selfAuthorized,
    ...verdict.needsPreflight.filter((effect) => held.has(effect)),
  ];
  return {
    planned,
    covered,
    missing: verdict.needsPreflight.filter((effect) => !held.has(effect)),
  };
}

/**
 * The seal over the exact effects being approved.
 *
 * Same reason `approvalDigest` exists for artifacts: what gets approved has to be
 * what gets exercised, not a wider set someone substituted afterwards. Classes
 * are sorted so the seal describes the SET, not the order it was listed in.
 */
export function effectApprovalDigest(transition: string, effects: readonly EffectClass[]): string {
  return semanticDigest({ transition, effects: [...effects].sort() });
}
