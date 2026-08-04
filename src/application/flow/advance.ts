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

import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import type { FlowDecision } from "../../domain/flow/authority.js";
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
import { type SemanticRequest, buildSemanticRequest } from "../semantic-operation/protocol.js";

export interface AdvanceInput {
  state: FlowRunState;
  /** The journey, in order. The registry provides it; a fixture may replace it. */
  journey: readonly FlowDecision[];
}

export type AdvanceResult =
  | { ok: true; state: FlowRunState; directive: FlowDirective }
  | { ok: false; failure: CapabilityFailure };

export function advanceFlowRun(input: AdvanceInput): AdvanceResult {
  const incoherent = checkAgainstJourney(input.state, input.journey);
  if (incoherent !== null) return { ok: false, failure: incoherent };

  let state = input.state;
  const appliedNow: string[] = [];

  // Every consecutive `cli` transition, in one go. The moment authority changes
  // hands the walk stops — that is the whole contract.
  for (let index = state.applied.length; index < input.journey.length; index += 1) {
    const decision = input.journey[index];
    if (decision === undefined || decision.authority !== "cli") break;
    state = applyTransition(state, decision.id);
    appliedNow.push(decision.id);
  }

  const stopped = input.journey[state.applied.length] ?? null;
  const pending = input.journey.slice(state.applied.length).map((decision) => decision.id);
  state = withBoundary(state, stopped?.id ?? null);

  const boundary: FlowBoundary =
    stopped === null
      ? { kind: "final", transition: null, authority: null, ownership: null, title: null }
      : {
          kind: boundaryKindOf(stopped),
          transition: stopped.id,
          authority: stopped.authority,
          ownership: stopped.ownership,
          title: stopped.title,
        };

  const built = buildFlowDirective({
    flow: state.flow,
    session: state.session,
    boundary,
    outcome: stopped === null ? "completed" : "needs_input",
    stateDigest: state.digest,
    applied: appliedNow,
    pending,
    request:
      stopped !== null && boundary.kind === "semantic" ? boundaryRequest(stopped, state) : null,
    choices: stopped !== null && boundary.kind === "human" ? humanChoices(stopped) : [],
    authorizations: state.authorizations,
    effects: state.effects,
    nextAction: nextActionFor(boundary, stopped),
  });
  if (!built.ok) return { ok: false, failure: built.failure };
  return { ok: true, state, directive: built.directive };
}

/**
 * The authority that owns the stopped transition IS the kind of boundary.
 *
 * The walk only ever stops on a NON-`cli` transition, so the two cases here are
 * the two that can arrive: `agent` asks for a judgment, `human` for a
 * preference. `authorization` and `blocked` are not derivable from authority at
 * all — an unauthorized effect and a live blocker are properties of the attempt,
 * not of who decides — and the phases that own them supply their own boundary.
 */
function boundaryKindOf(decision: FlowDecision): FlowBoundaryKind {
  return decision.authority === "agent" ? "semantic" : "human";
}

/**
 * The bounded request a semantic boundary carries.
 *
 * It reuses the existing `SemanticRequest` whole — contract, staleness seal,
 * allowed destinations, limits and a visible `read_set` so the cost is auditable
 * — instead of inventing a second envelope. A flow boundary asks for a judgment,
 * not for files, which is why it declares no writable destination at all.
 */
function boundaryRequest(decision: FlowDecision, state: FlowRunState): SemanticRequest {
  return buildSemanticRequest({
    operation: `flow.${decision.id}`,
    inputs: { state: state.digest, transition: decision.id },
    contract: `${decision.title}. Devolvé un único objeto JSON con 'state': 'proposed' y, en 'decisions', solo lo que este contrato pide. El CLI valida la respuesta antes de aplicar ninguna transición: una respuesta ausente, inválida, fuera de alcance o vencida no cambia el estado.`,
    inventory: { flow: state.flow, applied: state.applied },
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

function nextActionFor(boundary: FlowBoundary, stopped: FlowDecision | null): string {
  if (stopped === null) return "no queda trabajo pendiente en este recorrido";
  const submit = "respondé con 'aw flow submit' sobre la frontera vigente";
  switch (boundary.kind) {
    case "semantic":
      return `${submit}: ${stopped.title}`;
    case "human":
      return `${submit}: elegí una de las alternativas emitidas para '${stopped.title}'`;
    case "authorization":
      return `${submit} con --approval, autorizando el efecto que '${stopped.title}' necesita`;
    default:
      return `resolvé el bloqueo de '${stopped.title}' y volvé a correr 'aw flow advance'`;
  }
}
