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
 *
 * What an approval COVERS is the second half, and it used to be far too wide: a
 * run held effect CLASSES, so approving `mutate_overwrite` once left every later
 * transition of the run authorized to overwrite anything. A grant is now scoped
 * to the exact thing that was shown — a sealed proposal, or a named transition's
 * exact effects — and covers nothing else.
 */

import { semanticDigest } from "../../application/semantic-operation/protocol.js";
import {
  type EffectClass,
  type EffectDeclaration,
  authorizeEffects,
} from "../capability/effects.js";
import type { ProposalScope } from "../proposal.js";
import { type FlowDecision, effectsOf } from "./authority.js";

/**
 * One approval, scoped to what it was given over.
 *
 * `digest` is the whole point: a grant is only ever consulted for the seal it
 * names, so it cannot travel to a different transition or to different bytes.
 * `destinations` is empty when the grant seals no bytes — a transition's own
 * effects — and carries the exact paths when it seals a proposal, so the scope is
 * readable without recomputing the proposal it came from.
 */
export interface EffectGrant {
  digest: string;
  destinations: string[];
  classes: EffectClass[];
}

export interface TransitionAuthorization {
  planned: EffectClass[];
  /** Covered by the taxonomy itself or by a grant over THIS exact boundary. */
  covered: EffectClass[];
  /** Still needs an approval nobody granted. Non-empty ⇒ the advance stops. */
  missing: EffectClass[];
  /** The seal an approval of this boundary has to be given over. */
  seal: string;
}

/**
 * The standing proposal a transition would publish, when it has one.
 *
 * Both fields matter to the verdict and neither is decoration: the digest is what
 * a grant has to name, and the scope is what decides whether the taxonomy demands
 * a preflight at all.
 */
export interface SealedSubject {
  digest: string;
  scope: ProposalScope;
  /**
   * What publishing it REALLY exercises, observed rather than declared.
   *
   * The row's own `effects` are the ceiling — the widest a proposal on that step
   * may reach — and this is what the sealed bytes actually do against the current
   * workspace. Asking somebody to authorize an overwrite for a proposal that only
   * creates files would be an approval with no subject, and the run would then
   * fail its own verdict for an effect that never happened.
   */
  effects: EffectClass[];
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
  grants: readonly EffectGrant[],
  subject: SealedSubject | null = null,
): TransitionAuthorization {
  const planned = subject === null ? [...effectsOf(decision)] : [...subject.effects];
  const declarations: EffectDeclaration[] = planned.map((effect) => ({
    class: effect,
    idempotent: true,
    authorization: "invocation",
    approval: "none",
  }));
  // A flow transition writes inside the session or the flow's own document — the
  // target the run already named. A proposal is what can widen that, and when one
  // is standing its own declared scope is what the taxonomy judges: a run that
  // read a sensitive source, or whose proposal reaches past what was shown, must
  // not be waved through by a default that says neither ever happens.
  const verdict = authorizeEffects(declarations, {
    sensitiveSources: subject?.scope.sensitive_sources === true,
    scopeExpanded: subject?.scope.scope_expanded === true,
  });
  const seal = subject?.digest ?? effectApprovalDigest(decision.id, planned);
  const held = heldFor(grants, seal);
  return {
    planned,
    covered: [
      ...verdict.selfAuthorized,
      ...verdict.needsPreflight.filter((effect) => held.has(effect)),
    ],
    missing: verdict.needsPreflight.filter((effect) => !held.has(effect)),
    seal,
  };
}

/** The classes granted over exactly this seal — never over a neighbouring one. */
function heldFor(grants: readonly EffectGrant[], seal: string): Set<EffectClass> {
  const held = new Set<EffectClass>();
  for (const grant of grants) {
    if (grant.digest !== seal) continue;
    for (const effect of grant.classes) held.add(effect);
  }
  return held;
}

/**
 * The seal over the exact effects being approved, when no bytes are in play.
 *
 * Same reason `proposalDigest` exists for a local change: what gets approved has
 * to be what gets exercised, not a wider set someone substituted afterwards.
 * Classes are sorted so the seal describes the SET, not the order it was listed in.
 */
export function effectApprovalDigest(transition: string, effects: readonly EffectClass[]): string {
  return semanticDigest({ transition, effects: [...effects].sort() });
}
