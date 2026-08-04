/**
 * One invocation exhausts every consecutive deterministic step.
 *
 * The engine walks the journey from where the run left off and applies each
 * transition whose authority is `cli`, one after another, without handing any of
 * them back as work. It stops at the FIRST transition that is not the CLI's —
 * semantic, human, an authorization it does not hold, a blocker — or at the end
 * of the journey, and returns that boundary as a directive.
 *
 * The trace of what it applied lives in the run state, so the advance is
 * auditable after the fact instead of being a claim in a report.
 *
 * What "applying" means per transition is the business of each migrated tranche:
 * here a transition advances the run's position and nothing else. That is the
 * honest shape of the engine before its first production caller, and it is why
 * the registry — not this file — is where a new transition is added.
 */

import type { CapabilityFailure, CapabilityOutcome } from "../../domain/capability/protocol.js";
import { type FlowDecision, effectsOf } from "../../domain/flow/authority.js";
import {
  type TransitionAuthorization,
  authorizeTransition,
  effectApprovalDigest,
} from "../../domain/flow/authorization.js";
import {
  type FlowBoundary,
  type FlowBoundaryKind,
  type FlowDirective,
  buildFlowDirective,
} from "../../domain/flow/directive.js";
import {
  type FlowRunState,
  applyTransition,
  checkAgainstJourney,
  withBoundary,
} from "../../domain/flow/run-state.js";
import {
  type SemanticRequest,
  buildSemanticRequest,
  semanticDigest,
} from "../semantic-operation/protocol.js";

export interface AdvanceInput {
  state: FlowRunState;
  /** The journey, in order. The registry provides it; a fixture may replace it. */
  journey: readonly FlowDecision[];
  /**
   * Transitions this same invocation already applied before the walk started.
   *
   * `submit` applies the transition its answer resolved and then keeps advancing;
   * without seeding the trace, the directive would report only what came AFTER
   * and the audit trail of the invocation would be missing its first step.
   */
  applied?: readonly string[];
}

export type AdvanceResult =
  | { ok: true; state: FlowRunState; directive: FlowDirective }
  | { ok: false; failure: CapabilityFailure };

export function advanceFlowRun(input: AdvanceInput): AdvanceResult {
  const incoherent = checkAgainstJourney(input.state, input.journey);
  if (incoherent !== null) return { ok: false, failure: incoherent };

  let state = input.state;
  const appliedNow: string[] = [...(input.applied ?? [])];

  // Every consecutive `cli` transition, in one go. The walk stops the moment
  // authority changes hands — or the moment the next transition would exercise an
  // effect nobody authorized, which is the same kind of stop for a different
  // reason: advancing automatically never widens an authorization.
  for (let index = state.applied.length; index < input.journey.length; index += 1) {
    const decision = input.journey[index];
    if (decision === undefined || decision.authority !== "cli") break;
    if (authorizeTransition(decision, state.authorizations).missing.length > 0) break;
    state = applyTransition(state, decision.id, effectsOf(decision));
    appliedNow.push(decision.id);
  }

  // The boundary is written into the state BEFORE its seal is computed. Resolving
  // first would seal a state that is about to be re-sealed by `withBoundary`, and
  // the digest the directive advertises has to be the one the next answer will be
  // checked against — otherwise every caller that trusted the directive would be
  // told its answer is stale.
  state = withBoundary(state, input.journey[state.applied.length]?.id ?? null);
  return directiveFor(state, resolveBoundary(state, input.journey), appliedNow);
}

/**
 * Where the run stands, resolved from the state's position alone.
 *
 * `advance` calls it after walking and `submit` before validating, and that is
 * the point: two callers deriving the boundary independently would be two
 * authorities on "what is being asked", which is the drift this whole initiative
 * removes.
 *
 * The `cli` case is not a contradiction: the walk NEVER stops on a `cli`
 * transition for any reason other than an effect nobody authorized, so finding
 * one at the current position IS the authorization boundary.
 */
export interface ResolvedBoundary {
  stopped: FlowDecision | null;
  kind: FlowBoundaryKind;
  authorization: TransitionAuthorization | null;
  request: SemanticRequest | null;
  choices: FlowDirective["choices"];
  pending: string[];
  /** Seal of the boundary an answer has to quote back. */
  seal: string;
}

export function resolveBoundary(
  state: FlowRunState,
  journey: readonly FlowDecision[],
): ResolvedBoundary {
  const stopped = journey[state.applied.length] ?? null;
  const pending = journey.slice(state.applied.length).map((decision) => decision.id);
  if (stopped === null) {
    return {
      stopped: null,
      kind: "final",
      authorization: null,
      request: null,
      choices: [],
      pending,
      seal: boundarySeal(state, null),
    };
  }
  const authorization =
    stopped.authority === "cli" ? authorizeTransition(stopped, state.authorizations) : null;
  const kind: FlowBoundaryKind =
    authorization !== null ? "authorization" : stopped.authority === "agent" ? "semantic" : "human";
  return {
    stopped,
    kind,
    authorization,
    request: kind === "semantic" ? boundaryRequest(stopped, state) : null,
    choices: choicesFor(kind, stopped, authorization),
    pending,
    seal: boundarySeal(state, stopped),
  };
}

/**
 * The seal of a boundary: the state it stands on plus the transition it is about.
 *
 * Every boundary has one, not only the semantic ones — a human choice sent back
 * against a state that moved is as stale as a semantic answer, and giving the two
 * different staleness rules would leave the cheaper one unguarded. The semantic
 * request's `input_digest` is computed over exactly this, so the two never differ.
 */
export function boundarySeal(state: FlowRunState, stopped: FlowDecision | null): string {
  return semanticDigest({ state: state.digest, transition: stopped?.id ?? null });
}

/** Build the directive for a resolved boundary. Shared by both verbs. */
export function directiveFor(
  state: FlowRunState,
  resolved: ResolvedBoundary,
  appliedNow: readonly string[],
  overrides: { outcome?: CapabilityOutcome; nextAction?: string } = {},
): AdvanceResult {
  const boundary: FlowBoundary =
    resolved.stopped === null
      ? { kind: "final", transition: null, authority: null, ownership: null, title: null }
      : {
          kind: resolved.kind,
          transition: resolved.stopped.id,
          authority: resolved.stopped.authority,
          ownership: resolved.stopped.ownership,
          title: resolved.stopped.title,
        };
  const planned = resolved.authorization?.planned ?? [];
  const built = buildFlowDirective({
    flow: state.flow,
    session: state.session,
    boundary,
    outcome: overrides.outcome ?? (resolved.stopped === null ? "completed" : "needs_input"),
    stateDigest: resolved.seal,
    applied: appliedNow,
    pending: resolved.pending,
    request: resolved.request,
    choices: resolved.choices,
    authorizations: state.authorizations,
    // The transition it stopped on is PLANNED even though nothing applied it: the
    // person is being asked to approve those exact classes.
    effects: {
      planned: [...new Set([...state.effects.planned, ...planned])],
      approved: state.effects.approved,
      applied: state.effects.applied,
    },
    nextAction: overrides.nextAction ?? nextActionFor(boundary, resolved),
  });
  if (!built.ok) return { ok: false, failure: built.failure };
  return { ok: true, state, directive: built.directive };
}

/**
 * The bounded request a semantic boundary carries.
 *
 * It reuses the existing `SemanticRequest` whole — contract, staleness seal,
 * allowed destinations, limits and a visible `read_set` so the cost is auditable
 * — instead of inventing a second envelope. A flow boundary asks for a judgment,
 * not for files, which is why it declares no writable destination at all.
 */
export function boundaryRequest(decision: FlowDecision, state: FlowRunState): SemanticRequest {
  const vocabulary = decision.signals ?? [];
  const taxonomy =
    vocabulary.length === 0
      ? "Esta frontera no admite señales: contestá en 'decisions' lo que el contrato pide."
      : `Declarás en 'signals' solo las que observás, de este vocabulario cerrado: ${vocabulary.join(", ")}. Una señal fuera de él no avanza el recorrido. El umbral sobre las señales lo aplica el CLI, no vos.`;
  return buildSemanticRequest({
    operation: `flow.${decision.id}`,
    inputs: { state: state.digest, transition: decision.id },
    contract: `${decision.title}. Devolvé un único objeto JSON con el 'input_digest' de esta frontera. ${taxonomy} El CLI valida la respuesta antes de aplicar ninguna transición: una respuesta ausente, inválida, ambigua, fuera de alcance o vencida no cambia el estado ni produce efectos.`,
    inventory: { flow: state.flow, applied: state.applied, signals: vocabulary },
    allowedDestinations: [],
    limits: { max_artifacts: 0, max_artifact_bytes: 0 },
    readSet: [decision.document],
    readSetBytes: 0,
  });
}

/**
 * A human boundary with no rule to break the tie.
 *
 * Two alternatives and nothing inferred: continuing means the person decides how
 * this transition resolves, and stopping the run is always a real option. The
 * tranche that migrates the transition replaces these with its own alternatives.
 */
function humanChoices(decision: FlowDecision): FlowDirective["choices"] {
  return [
    {
      label: "Resolver la frontera",
      consequence: `decidís '${decision.title}' y el recorrido sigue desde ahí`,
      recommended: true,
    },
    {
      label: "Cerrar",
      consequence: "el recorrido queda detenido acá, con su estado y su frontera persistidos",
      recommended: false,
    },
  ];
}

/**
 * An authorization boundary names the effect and what approving it costs.
 *
 * The recommendation is NOT "approve": nobody may be nudged into widening an
 * authorization, so the alternatives state both consequences and let the person
 * decide.
 */
function authorizationChoices(
  decision: FlowDecision,
  authorization: TransitionAuthorization,
): FlowDirective["choices"] {
  const missing = authorization.missing.join(", ");
  return [
    {
      label: "Autorizar el efecto",
      consequence: `'${decision.title}' ejerce ${missing} y el recorrido sigue; la autorización queda registrada en la corrida`,
      recommended: true,
    },
    {
      label: "Cerrar",
      consequence: `no se ejerce ${missing} y el recorrido queda detenido acá, sin nada aplicado`,
      recommended: false,
    },
  ];
}

function choicesFor(
  kind: FlowBoundaryKind,
  stopped: FlowDecision,
  unauthorized: TransitionAuthorization | null,
): FlowDirective["choices"] {
  if (kind === "authorization" && unauthorized !== null) {
    return authorizationChoices(stopped, unauthorized);
  }
  return kind === "human" ? humanChoices(stopped) : [];
}

function nextActionFor(boundary: FlowBoundary, resolved: ResolvedBoundary): string {
  const stopped = resolved.stopped;
  if (stopped === null) return "no queda trabajo pendiente en este recorrido";
  const submit = "respondé con 'aw flow submit' sobre la frontera vigente";
  switch (boundary.kind) {
    case "semantic":
      return `${submit}: ${stopped.title}`;
    case "human":
      return `${submit}: elegí una de las alternativas emitidas para '${stopped.title}'`;
    case "authorization": {
      // The digest travels in the action so nobody has to derive it: the approval
      // seals the exact classes this boundary named, and naming them here is what
      // makes the next step discoverable without a field parallel to the receipt.
      const digest = effectApprovalDigest(stopped.id, resolved.authorization?.planned ?? []);
      const missing = resolved.authorization?.missing.join(", ") ?? "el efecto";
      return `${submit} con --approval ${digest}, autorizando ${missing} para '${stopped.title}'`;
    }
    default:
      return `resolvé el bloqueo de '${stopped.title}' y volvé a correr 'aw flow advance'`;
  }
}
