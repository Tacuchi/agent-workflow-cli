/**
 * One invocation exhausts every consecutive deterministic step it OWNS.
 *
 * The engine walks the journey from where the run left off and applies each
 * transition that is both the CLI's authority (`cli`) and the CLI's property
 * (`cli-owned`), one after another, without handing any of them back as work. It
 * stops at the FIRST transition it cannot apply — a judgment, a preference, an
 * effect nobody authorized, a step doctrine still decides, a blocker — or at the
 * end of the journey, and returns that boundary as a directive.
 *
 * The two axes are not the same stop. Authority answers "is this derivable?";
 * ownership answers "does this CLI decide it yet?". A row that is derivable but
 * still doctrine's is handed back as a `legacy` boundary that DECLARES the
 * document about to decide it — applying it would record as the CLI's a step
 * whose rule nobody read. Both give way to one thing: an effect nobody
 * authorized stops the advance whoever owns the rule.
 *
 * The trace of what it applied lives in the run state, with the authority each
 * step moved under, so the advance is auditable after the fact instead of being a
 * claim in a report.
 *
 * What "applying" means per transition is the business of each migrated tranche:
 * here a transition advances the run's position and nothing else. That is why the
 * registry — not this file — is where a new transition is added.
 */

import type { CapabilityFailure, CapabilityOutcome } from "../../domain/capability/protocol.js";
import {
  type DelegatedAction,
  type FlowDecision,
  actionOf,
  effectsOf,
} from "../../domain/flow/authority.js";
import {
  type TransitionAuthorization,
  authorizeTransition,
  effectApprovalDigest,
} from "../../domain/flow/authorization.js";
import {
  type FlowBoundary,
  type FlowBoundaryKind,
  type FlowDirective,
  type FlowStep,
  buildFlowDirective,
  stepOf,
} from "../../domain/flow/directive.js";
import {
  type FlowRunState,
  applyTransition,
  checkAgainstJourney,
  withBoundary,
  withPendingAction,
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
  applied?: readonly FlowStep[];
}

export type AdvanceResult =
  | { ok: true; state: FlowRunState; directive: FlowDirective }
  | { ok: false; failure: CapabilityFailure };

export function advanceFlowRun(input: AdvanceInput): AdvanceResult {
  const incoherent = checkAgainstJourney(input.state, input.journey);
  if (incoherent !== null) return { ok: false, failure: incoherent };

  const walked = walk(input.state, input.journey);
  let state = walked.state;
  const appliedNow: FlowStep[] = [...(input.applied ?? []), ...walked.applied];

  // The boundary and the pending action are written into the state BEFORE its seal
  // is computed. Resolving first would seal a state that is about to be re-sealed,
  // and the digest the directive advertises has to be the one the next answer will
  // be checked against — otherwise every caller that trusted the directive would
  // be told its answer is stale.
  const stopped = input.journey[state.applied.length] ?? null;
  state = withBoundary(state, stopped?.id ?? null);
  // Only an EMITTED action is pending. Reading it back off the resolved boundary
  // — instead of off the row — is what keeps the two honest: a delegated step
  // whose effect is still unapproved stops at the authorization boundary, its
  // invocation is not in the directive, and the state must not claim the run is
  // waiting on something nobody was told to run.
  const emitted = resolveBoundary(state, input.journey).action;
  state = withPendingAction(
    state,
    emitted === null || stopped === null
      ? null
      : { transition: stopped.id, digest: actionDigest(emitted) },
  );
  return directiveFor(state, resolveBoundary(state, input.journey), appliedNow);
}

/**
 * Every consecutive transition the CLI owns AND can apply itself, in one go.
 *
 * The walk stops the moment authority changes hands, the moment the next
 * transition would exercise an effect nobody authorized (advancing automatically
 * never widens an authorization), the moment it reaches a step still owned by
 * doctrine — or the moment the step is delegated.
 *
 * The last two stops are the same principle twice. Applying a `legacy` row would
 * record as decided-by-the-CLI a step whose rule lives in a document nobody has
 * read yet; applying a DELEGATED row would record as done a search, a seeding or
 * a validation that nothing ran. Both would be the engine claiming something it
 * cannot see, so both become boundaries: one declares its fallback, the other
 * names its invocation and waits for real output.
 */
function walk(
  from: FlowRunState,
  journey: readonly FlowDecision[],
): { state: FlowRunState; applied: FlowStep[] } {
  let state = from;
  const applied: FlowStep[] = [];
  for (let index = state.applied.length; index < journey.length; index += 1) {
    const decision = journey[index];
    if (decision === undefined || decision.authority !== "cli") break;
    if (decision.ownership !== "cli-owned") break;
    if (authorizeTransition(decision, state.authorizations).missing.length > 0) break;
    if (actionOf(decision) !== null) break;
    state = applyTransition(state, decision.id, effectsOf(decision));
    applied.push(stepOf(decision));
  }
  return { state, applied };
}

/**
 * The seal over the exact action emitted.
 *
 * Program, arguments, target, input and demanded evidence — change any of them and
 * a result that quotes the old seal is answering about something else. Same reason
 * `effectApprovalDigest` seals the classes being approved rather than the fact that
 * an approval happened.
 */
export function actionDigest(action: DelegatedAction): string {
  return semanticDigest({
    program: action.invocation.program,
    args: [...action.invocation.args],
    target: action.invocation.target,
    input: action.invocation.input,
    evidence: [...action.evidence],
  });
}

/**
 * Where the run stands, resolved from the state's position alone.
 *
 * `advance` calls it after walking and `submit` before validating, and that is
 * the point: two callers deriving the boundary independently would be two
 * authorities on "what is being asked", which is the drift this whole initiative
 * removes.
 *
 * Ownership is read FIRST, before authority: a step the CLI does not own yet is a
 * `legacy` boundary whatever its authority would be, because emitting a bounded
 * semantic request — or a set of alternatives — for a rule this CLI does not
 * decide would be the engine speaking for the doctrine. Only among the steps it
 * does own is the `cli` case the authorization boundary: there the walk never
 * stops for any other reason.
 */
export interface ResolvedBoundary {
  stopped: FlowDecision | null;
  kind: FlowBoundaryKind;
  authorization: TransitionAuthorization | null;
  request: SemanticRequest | null;
  /** The invocation to run, at an `execution` boundary. */
  action: DelegatedAction | null;
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
      action: null,
      choices: [],
      pending,
      seal: boundarySeal(state, null),
    };
  }
  const action = actionOf(stopped);
  // Computed for `cli` rows only, which is where every row that really writes or
  // runs lives today (13 of them, all `cli`). The day a row with authority `agent`
  // or `human` declares a non-self-authorizable effect, this condition is the
  // thing to revisit — and the ORDER is the open question there: approving a write
  // before the agent has produced what gets written is not obviously right, so
  // whichever phase introduces such a row decides it instead of inheriting it.
  const authorization =
    stopped.authority === "cli" ? authorizeTransition(stopped, state.authorizations) : null;
  // An effect nobody authorized outranks the migration axis. Approving an effect
  // is not deciding a step: ten `legacy` rows exercise `mutate_overwrite` or
  // `execute`, and letting ownership answer first would hand them to doctrine with
  // their effects unapproved — the authorization gate bypassed by a field that has
  // nothing to do with it.
  const kind = boundaryKind(stopped, (authorization?.missing.length ?? 0) > 0);
  return {
    stopped,
    kind,
    authorization,
    request: kind === "semantic" ? boundaryRequest(stopped, state) : null,
    action: kind === "execution" ? action : null,
    choices: choicesFor(kind, stopped, authorization),
    pending,
    seal: boundarySeal(state, stopped),
  };
}

/**
 * Which boundary a stopped transition is, in the one order that holds.
 *
 * An effect nobody authorized outranks everything: approving an effect is not
 * deciding a step, and letting any other axis answer first would hand a writing
 * transition onwards with its effects unapproved — the authorization gate bypassed
 * by a field that has nothing to do with it. Ownership comes next, because
 * emitting a bounded request, a set of alternatives or an invocation for a rule
 * this CLI does not decide would be the engine speaking for the doctrine. Only
 * then does the mode matter: what remains is a judgment, an invocation to run, or
 * a preference.
 */
function boundaryKind(stopped: FlowDecision, unauthorized: boolean): FlowBoundaryKind {
  if (unauthorized) return "authorization";
  if (stopped.ownership !== "cli-owned") return "legacy";
  if (stopped.authority === "agent") return "semantic";
  return actionOf(stopped) === null ? "human" : "execution";
}

/**
 * The seal of a boundary: the state it stands on, the transition it is about, and
 * the action it names.
 *
 * Every boundary has one, not only the semantic ones — a human choice sent back
 * against a state that moved is as stale as a semantic answer, and giving the two
 * different staleness rules would leave the cheaper one unguarded. The semantic
 * request's `input_digest` is computed over exactly this, so the two never differ.
 *
 * The action is inside the seal because a result is an assertion about a specific
 * invocation: if the program, an argument, the target, the input or the demanded
 * evidence changed, whatever came back answered a different question.
 */
export function boundarySeal(state: FlowRunState, stopped: FlowDecision | null): string {
  return semanticDigest(boundaryInputs(state, stopped));
}

/**
 * What the seal is computed over — and what the semantic request declares as its
 * own inputs, so the two digests are the same number by construction.
 *
 * Building them apart is how a system ends up with two staleness questions and a
 * caller guessing which one it just answered.
 */
function boundaryInputs(
  state: FlowRunState,
  stopped: FlowDecision | null,
): { state: string; transition: string | null; action: string | null } {
  const action = stopped === null ? null : actionOf(stopped);
  return {
    state: state.digest,
    transition: stopped?.id ?? null,
    action: action === null ? null : actionDigest(action),
  };
}

/** Build the directive for a resolved boundary. Shared by both verbs. */
export function directiveFor(
  state: FlowRunState,
  resolved: ResolvedBoundary,
  appliedNow: readonly FlowStep[],
  overrides: { outcome?: CapabilityOutcome; nextAction?: string } = {},
): AdvanceResult {
  const boundary: FlowBoundary =
    resolved.stopped === null
      ? {
          kind: "final",
          transition: null,
          authority: null,
          ownership: null,
          title: null,
          document: null,
        }
      : {
          kind: resolved.kind,
          transition: resolved.stopped.id,
          authority: resolved.stopped.authority,
          ownership: resolved.stopped.ownership,
          title: resolved.stopped.title,
          document: resolved.stopped.document,
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
    action: resolved.action,
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
    inputs: boundaryInputs(state, decision),
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
    case "legacy":
      // The document comes FIRST in the sentence: this step is not the CLI's, and
      // the fallback has to be read before it runs, not justified afterwards.
      return `aplicá la regla vigente de ${stopped.document} para '${stopped.title}' y después ${submit}, declarando ese fallback en 'fallback'`;
    case "execution": {
      // The exact invocation, projected — not a description of it. Whoever
      // executes should never have to reconstruct the command from prose, and the
      // evidence is named in the same breath so "it ran" and "here is the output"
      // arrive together or not at all.
      const action = resolved.action;
      const call =
        action === null
          ? stopped.id
          : [action.invocation.program, ...action.invocation.args].join(" ");
      const evidence = action?.evidence.join(", ") ?? "la evidencia exigida";
      return `ejecutá '${call}' en ${action?.invocation.target ?? "el target declarado"} y ${submit} con su resultado real: outcome, la invocación que corriste y las validaciones ${evidence}. Una confirmación sin salida no aplica la transición`;
    }
    default:
      return `resolvé el bloqueo de '${stopped.title}' y volvé a correr 'aw flow advance'`;
  }
}
