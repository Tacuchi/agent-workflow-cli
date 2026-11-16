import type { AgentWorkflowFlow } from "../../src/application/capability/compose.js";
import { journeyOfFlow } from "../../src/domain/flow/authority.js";
import type { RouteProposal } from "../../src/domain/flow/route.js";
import {
  FLOW_RUN_STATE_VERSION,
  type FlowObservation,
  type FlowRunAttempt,
  type FlowRunScope,
  type FlowRunState,
  attemptCounterKey,
  sealRunState,
} from "../../src/domain/flow/run-state.js";

/** A sealed, empty run of `flow`: the state a legacy session left behind, built for the readers under test. */
export function newRunState(flow: AgentWorkflowFlow, session: string): FlowRunState {
  return sealRunState({
    version: FLOW_RUN_STATE_VERSION,
    flow,
    session,
    scope: null,
    journey_base: journeyOfFlow(flow).map((decision) => decision.id),
    applied: [],
    skipped: [],
    boundary: null,
    pending_action: null,
    observations: [],
    events: [],
    authorizations: [],
    proposal: null,
    effects: { planned: [], approved: [], applied: [] },
    attempts: [],
    batches: [],
    batch_trace: [],
    batch_loop: { pending: true, iteration: 1 },
    handoff: null,
    selected_choice: null,
    decision_preparation: null,
    route_proposal: null,
    route_decisions: null,
    assurance: "verified",
  });
}

/** The same run with `patch` applied, resealed: what a run written to disk would read as. */
function resealed(state: FlowRunState, patch: Partial<FlowRunState>): FlowRunState {
  const { digest: _digest, ...rest } = state;
  return sealRunState({ ...rest, ...patch });
}

export function withScope(state: FlowRunState, scope: FlowRunScope): FlowRunState {
  return resealed(state, { scope });
}

/** Appends one observation, as a run that recorded it would hold it. */
export function withObservation(state: FlowRunState, observation: FlowObservation): FlowRunState {
  return resealed(state, { observations: [...state.observations, observation] });
}

/** Appends one attempt row. */
export function withAttempt(state: FlowRunState, attempt: FlowRunAttempt): FlowRunState {
  return resealed(state, { attempts: [...state.attempts, attempt] });
}

/** Records `attempts` forgiven on `transition`'s counter. */
export function grantAttempts(
  state: FlowRunState,
  transition: string,
  attempts: number,
): FlowRunState {
  const key = attemptCounterKey(state, transition);
  const granted = { ...(state.attempt_grants ?? {}) };
  granted[key] = (granted[key] ?? 0) + attempts;
  return resealed(state, { attempt_grants: granted });
}

/** Holds a route proposal awaiting the person, with no decisions taken on it yet. */
export function withRouteProposal(
  state: FlowRunState,
  proposal: RouteProposal | null,
): FlowRunState {
  return resealed(state, {
    route_proposal: proposal,
    route_decisions: null,
    assurance: "verified",
  });
}
