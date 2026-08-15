/**
 * One invocation exhausts every consecutive deterministic step it OWNS.
 *
 * The engine walks the journey from where the run left off and applies each
 * transition that is both the CLI's authority (`cli`) and the CLI's property
 * (`cli-owned`), one after another, without handing any of them back as work. It
 * stops at the FIRST transition it cannot apply — a judgment, a preference, an
 * effect nobody authorized, a blocker — or at the end of the journey, and returns
 * that boundary as a directive.
 *
 * Authority is the axis that decides WHICH boundary: "is this derivable, or does
 * it need a judgment, a preference, an invocation?". Ownership used to be a second
 * axis answering "does this CLI decide it yet?", and a row that was derivable but
 * still doctrine's came back as a `legacy` boundary naming the document about to
 * decide it. That axis is closed: every row of every public journey is the CLI's,
 * so ownership no longer routes anything — it fails closed. Both give way to one
 * thing: an effect nobody authorized stops the advance whoever owns the rule.
 *
 * The trace of what it applied lives in the run state, with the authority each
 * step moved under, so the advance is auditable after the fact instead of being a
 * claim in a report.
 *
 * What "applying" means per transition is the business of each migrated tranche:
 * here a transition advances the run's position and nothing else. That is why the
 * registry — not this file — is where a new transition is added.
 */

import type { EffectClass } from "../../domain/capability/effects.js";
import type { CapabilityFailure, CapabilityOutcome } from "../../domain/capability/protocol.js";
import {
  DOCS_BOUNDARY,
  type DelegatedAction,
  type FlowDecision,
  actionOf,
  alternativesOf,
  effectsOf,
  internalActionOf,
  proposalContractOf,
  publishApprovalOf,
} from "../../domain/flow/authority.js";
import {
  type SealedSubject,
  type TransitionAuthorization,
  authorizeTransition,
  effectApprovalDigest,
} from "../../domain/flow/authorization.js";
import {
  type DirectiveProposal,
  type FlowBoundary,
  type FlowBoundaryKind,
  type FlowDirective,
  type FlowStep,
  PAUSE_LABEL,
  STOP_LABEL,
  buildFlowDirective,
  skippedStepOf,
  stepOf,
} from "../../domain/flow/directive.js";
import {
  type RunBinding,
  bindAction,
  docsBoundaryBreach,
  skipReason,
} from "../../domain/flow/rules.js";
import {
  type FlowRunState,
  MAX_BOUNDARY_ATTEMPTS,
  applyTransition,
  attemptsAt,
  checkAgainstJourney,
  positionDigest,
  skipTransition,
  withBoundary,
  withPendingAction,
} from "../../domain/flow/run-state.js";
import {
  type SemanticRequest,
  buildSemanticRequest,
  semanticDigest,
} from "../semantic-operation/protocol.js";
import { sessionSlug } from "../session-resolver.js";

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
 * never widens an authorization), the moment it reaches a step whose ownership the
 * registry does not declare — or the moment the step is delegated.
 *
 * The last two stops are the same principle twice. Applying an unowned row would
 * record as decided-by-the-CLI a step the registry never said it decides; applying
 * a DELEGATED row would record as done a search, a seeding or a validation that
 * nothing ran. Both would be the engine claiming something it cannot see, so both
 * become boundaries: one blocked naming what is missing, the other naming its
 * invocation and waiting for real output.
 *
 * A CONDITIONAL step is the one case that neither applies nor stops: the walk
 * passes over it, records the omission with its cause, and keeps going whatever
 * the step's authority would have been. That is checked first on purpose — a
 * human boundary whose condition did not fire must never be emitted, or the
 * migrated journey would ask a question the doctrine it replaces does not ask.
 */
function walk(
  from: FlowRunState,
  journey: readonly FlowDecision[],
): { state: FlowRunState; applied: FlowStep[] } {
  let state = from;
  const applied: FlowStep[] = [];
  for (let index = state.applied.length; index < journey.length; index += 1) {
    const decision = journey[index];
    if (decision === undefined) break;
    // A condition that did not fire, or a boundary this run has already tried as
    // often as it may. Both pass over the step and both say why — the trace has
    // to distinguish "never happened" from "was given up on".
    const skipped =
      skipReason(decision, journey, state.observations) ??
      nothingToPublish(state, decision) ??
      exhaustionSkip(state, decision);
    if (skipped !== null) {
      state = skipTransition(state, decision.id);
      applied.push(skippedStepOf(decision, skipped));
      continue;
    }
    if (decision.authority !== "cli") break;
    if (!owned(decision)) break;
    if (
      authorizeTransition(decision, state.authorizations, subjectOf(state, decision)).missing
        .length > 0
    ) {
      break;
    }
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
 * Ownership is still read FIRST, before authority — but now it decides nothing
 * except whether there is a boundary to emit at all. Emitting a bounded semantic
 * request, or a set of alternatives, for a step the registry does not say this CLI
 * owns would be the engine speaking for a document nobody read; with no fallback
 * left to hand it to, that transition is `blocked`. Among the steps it does own,
 * the `cli` case is the authorization boundary: there the walk never stops for any
 * other reason.
 */
export interface ResolvedBoundary {
  stopped: FlowDecision | null;
  kind: FlowBoundaryKind;
  authorization: TransitionAuthorization | null;
  request: SemanticRequest | null;
  /** The invocation to run, at an `execution` boundary. */
  action: DelegatedAction | null;
  /** The sealed local change this boundary decides or publishes, when there is one. */
  proposal: DirectiveProposal | null;
  choices: FlowDirective["choices"];
  pending: string[];
  /** Seal of the boundary an answer has to quote back. */
  seal: string;
  /** Why the run cannot continue, at a `blocked` boundary. */
  error: CapabilityFailure | null;
}

/** The run's own coordinates, the only ones an invocation may reference. */
function runBinding(state: FlowRunState): RunBinding {
  return {
    session: state.session,
    // The FOLDER, never the bare number. `--code 047` matches both `047-<slug>`
    // and a legacy `session047-<slug>`, so in a workspace holding both, the
    // invocation this engine seals cannot be satisfied: running it verbatim
    // fails to resolve, and correcting it makes it a different invocation the
    // submit refuses. The folder is the one identity that always resolves to
    // one session, and every `--code` position accepts it.
    code: state.session,
    // Read off the folder, not off a narration: the run's own session is named
    // `NNN-<slug>-<flow>`, so the slug the numbering claim needs is already a
    // fact the engine holds by the time this boundary is emitted.
    slug: sessionSlug(state.session, state.flow),
  };
}

/**
 * The action as this run would emit it: bound to its session, or refused.
 *
 * Every reader goes through here — the seal, the directive and the check `submit`
 * runs against the result — so the invocation that gets sealed is the invocation
 * that gets shown and the one the result is compared against. Binding in one of
 * the three and not the others is how a run ends up rejecting its own action.
 */
function emittedAction(
  state: FlowRunState,
  stopped: FlowDecision | null,
): { action: DelegatedAction | null; unbound: string | null; outside: string | null } {
  const declared = stopped === null ? null : actionOf(stopped);
  if (declared === null) return { action: null, unbound: null, outside: null };
  const bound = bindAction(declared, runBinding(state));
  if (!bound.ok) return { action: null, unbound: bound.unbound, outside: null };
  // Checked on the BOUND form: a placeholder could resolve into a path, so
  // validating the template would be validating something nobody runs.
  const outside = docsBoundaryBreach(bound.action, state.flow);
  return outside === null
    ? { action: bound.action, unbound: null, outside: null }
    : { action: null, unbound: null, outside };
}

/**
 * Why this boundary cannot be emitted at all — or `null` when it can.
 *
 * Four fail-closed causes, ordered by what the reader can do about them.
 * Ownership answers first and is the one this tranche added: with the fallback
 * retired there is no document to hand the step back to, so a transition the
 * registry does not say the CLI owns stops the run naming itself instead of
 * silently becoming prose somebody has to go read. An unbound placeholder and a
 * `docs/` breach are defects OF THE REGISTRY too: the fix is a code change, and
 * emitting either would print a command nobody can run or one that writes outside
 * the lane its flow is allowed. Exhaustion is a defect of nothing — it is the run
 * having asked the same thing as often as the chassis permits, and the answer is
 * to take the gap somewhere a person can settle it rather than to ask a fourth
 * time.
 */
function blockedCause(
  state: FlowRunState,
  stopped: FlowDecision,
  emitted: { unbound: string | null; outside: string | null },
): CapabilityFailure | null {
  if (!owned(stopped)) {
    return {
      code: "FLOW_TRANSITION_UNOWNED",
      message: `'${stopped.id}' no declara propiedad del CLI y ya no queda doctrina a la que devolverlo`,
      action:
        "declarála en el registro de autoridad: desde el cierre de la migración toda transición de un recorrido público es 'cli-owned', y la ausencia es un error, no un fallback",
    };
  }
  if (emitted.unbound !== null) {
    return {
      code: "FLOW_ACTION_UNBOUND",
      message: `la acción de '${stopped.id}' referencia ${emitted.unbound} y esta corrida no puede resolverlo`,
      action:
        "corregí la invocación del registro: una acción solo referencia las coordenadas de la corrida",
    };
  }
  if (emitted.outside !== null) {
    return {
      code: "FLOW_DOCS_BOUNDARY_CROSSED",
      message: `la acción de '${stopped.id}' escribe en ${emitted.outside} y el flow '${state.flow}' no tiene esa carpeta permitida`,
      action: `este recorrido solo escribe ${describeAllowance(state.flow)}: promover algo a otra carpeta de docs es un paso 'export-*' aparte, nunca un efecto del loop`,
    };
  }
  if (exhausted(state, stopped)) {
    // Two different situations wear the same code, and saying which one this is
    // matters: one continues on the next advance, the other cannot. Reporting the
    // stricter message for both would tell somebody their run is stuck when it is
    // about to move on.
    const degradable = exhaustionSkip(state, stopped) !== null;
    return {
      code: "FLOW_BOUNDARY_EXHAUSTED",
      message: `'${stopped.id}' agotó sus ${MAX_BOUNDARY_ATTEMPTS} intentos: contestarlo otra vez sería el bucle que la regla evita`,
      action: degradable
        ? `${DEGRADE_ACTION}; el próximo 'aw flow advance' lo pasa por alto dejando dicho por qué y sigue con el resto`
        : `${DEGRADE_ACTION}, y resolvé este paso fuera de la corrida antes de seguir: saltearlo daría por aprobado un efecto que nadie aprobó, o por hecho algo que nada corrió`,
    };
  }
  return null;
}

/** Where a gap goes when the loop stops re-firing it — the chassis' destination. */
const DEGRADE_ACTION =
  "degradá el gap en vez de reintentarlo: llevalo a '## Open questions' del documento del flow —o al BACKLOG de la sesión si el flow no tiene documento— declarando que ya se intentó";

/** Whether this run has already spent every attempt this boundary gets. */
function exhausted(state: FlowRunState, decision: FlowDecision): boolean {
  return attemptsAt(state, decision.id) >= MAX_BOUNDARY_ATTEMPTS;
}

/**
 * Whether the registry says this CLI owns the step.
 *
 * The vocabulary has one member, so every row shipped in {@link FLOW_DECISIONS}
 * answers `true` and the compiler is what keeps it that way. The check survives
 * for the journeys this engine does NOT build itself: a caller hands `advanceFlow`
 * a list of decisions, and reading a field is cheaper than trusting that whoever
 * assembled it kept the invariant. The three places that ask are the walk, the
 * blocked cause and the skip — one predicate, so they cannot disagree.
 */
function owned(decision: FlowDecision): boolean {
  return decision.ownership === "cli-owned";
}

/**
 * A publication with nothing to publish is passed over, never asked about.
 *
 * This is what makes `Refinar` cost nothing. Declining clears the proposal, and a
 * publish row that then stopped would ask the person to authorize an overwrite
 * for bytes they just declined — the exact second question this contract removes,
 * reappearing on the path where it makes least sense. Skipping it says out loud
 * that nothing was written, which a silent advance would not.
 */
function nothingToPublish(state: FlowRunState, decision: FlowDecision): string | null {
  if (internalActionOf(decision)?.operation !== "proposal.publish") return null;
  if (state.proposal !== null) return null;
  return "no quedó ninguna propuesta aprobada: no se escribió nada";
}

/**
 * Why an exhausted boundary is passed over — or `null` when it must not be.
 *
 * Degrading means what the chassis says it means: the gap stops being re-fired,
 * it goes somewhere a person can settle it, and **the run goes on with the
 * rest**. Blocking instead would be the dead end the rule exists to prevent — a
 * boundary nobody can answer any more, on a run nobody can finish.
 *
 * Not every boundary may be passed over, and the exception is not a special
 * case: a step that would EXERCISE something cannot be waved through. An
 * authorization skipped is an effect nobody approved; a delegated step skipped
 * is a search, a write or a check credited to nothing. Those stay blocked, and
 * the block says so. What degrades is what only produces a verdict — a judgment
 * or a preference — which is exactly the gap the doctrine degrades.
 */
function exhaustionSkip(state: FlowRunState, decision: FlowDecision): string | null {
  if (!exhausted(state, decision)) return null;
  if (!owned(decision)) return null;
  if (actionOf(decision) !== null) return null;
  if (
    authorizeTransition(decision, state.authorizations, subjectOf(state, decision)).missing.length >
    0
  ) {
    return null;
  }
  return `agotó sus ${MAX_BOUNDARY_ATTEMPTS} intentos: ${DEGRADE_ACTION}`;
}

/** The `docs/` folders a flow may write, said the way a person reads it. */
function describeAllowance(flow: FlowRunState["flow"]): string {
  const allowed = DOCS_BOUNDARY[flow];
  return allowed.length === 0 ? "ninguna carpeta de docs" : allowed.join(" y ");
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
      proposal: null,
      choices: [],
      pending,
      seal: boundarySeal(state, null),
      error: null,
    };
  }
  const emitted = emittedAction(state, stopped);
  // The standing proposal belongs to the boundary that DECIDES it and to the one
  // that PUBLISHES it, and to no other: a row unrelated to the proposal must not
  // inherit its scope into the authorization verdict, which is the whole point of
  // sealing the grant.
  const subject = subjectOf(state, stopped);
  // Computed for `cli` rows only, which is where every row that really writes or
  // runs lives today (13 of them, all `cli`). The day a row with authority `agent`
  // or `human` declares a non-self-authorizable effect, this condition is the
  // thing to revisit — and the ORDER is the open question there: approving a write
  // before the agent has produced what gets written is not obviously right, so
  // whichever phase introduces such a row decides it instead of inheriting it.
  const authorization =
    stopped.authority === "cli"
      ? authorizeTransition(stopped, state.authorizations, subject)
      : null;
  // A cause that blocks outranks all of it: the boundary that says "nothing can
  // continue and here is why" is never worth degrading into a question nobody can
  // answer.
  const blocked = blockedCause(state, stopped, emitted);
  const kind =
    blocked === null ? boundaryKind(stopped, (authorization?.missing.length ?? 0) > 0) : "blocked";
  return {
    stopped,
    kind,
    authorization,
    request: kind === "semantic" ? boundaryRequest(stopped, state) : null,
    action: kind === "execution" ? emitted.action : null,
    proposal: subject === null ? null : previewOfState(state),
    choices: choicesFor(kind, stopped, authorization),
    pending,
    seal: boundarySeal(state, stopped),
    error: blocked,
  };
}

/**
 * The proposal this transition is about, or `null` when it is about none.
 *
 * Two rows qualify and they are the two halves of one decision: the human row
 * that shows the preview and grants, and the `cli` row that writes it. Anything
 * else standing while a proposal is seated gets `null`, so an unrelated step
 * cannot borrow the proposal's scope — or its grant.
 */
function subjectOf(state: FlowRunState, stopped: FlowDecision): SealedSubject | null {
  const proposal = state.proposal;
  if (proposal === null) return null;
  const decides = publishApprovalOf(stopped) !== null;
  const publishes = internalActionOf(stopped)?.operation === "proposal.publish";
  if (!decides && !publishes) return null;
  return { digest: proposal.digest, scope: proposal.scope, effects: proposal.effects };
}

/** What a transition really exercises: its sealed proposal's effects, or its own. */
export function effectsOfTransition(
  state: FlowRunState,
  decision: FlowDecision,
): readonly EffectClass[] {
  return subjectOf(state, decision)?.effects ?? effectsOf(decision);
}

/** The preview the boundary carries: destinations and effects, never the bytes. */
function previewOfState(state: FlowRunState): DirectiveProposal | null {
  const proposal = state.proposal;
  if (proposal === null) return null;
  return {
    digest: proposal.digest,
    preview: proposal.preview,
    effects: proposal.effects,
    requires_approval: proposal.requires_approval,
    scope: proposal.scope,
  };
}

/**
 * Which boundary a stopped transition is, in the one order that holds.
 *
 * An effect nobody authorized outranks everything: approving an effect is not
 * deciding a step, and letting any other axis answer first would hand a writing
 * transition onwards with its effects unapproved — the authorization gate bypassed
 * by a field that has nothing to do with it. Then the mode: what remains is a
 * judgment, an invocation to run, or a preference.
 *
 * Ownership used to sit in the middle of that order, turning a step the CLI did
 * not decide into its own kind of boundary. It no longer answers here at all —
 * {@link blockedCause} refuses such a transition before this function runs, which
 * is the difference between "read this document and come back" and "this cannot
 * advance, and here is why".
 */
function boundaryKind(stopped: FlowDecision, unauthorized: boolean): FlowBoundaryKind {
  if (unauthorized) return "authorization";
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
  const action = emittedAction(state, stopped).action;
  return {
    // The POSITION, not the whole file: a refused attempt is recorded in the
    // state, and sealing it in would make the caller's own refusal come back as
    // staleness on their next try. See `positionDigest`.
    state: positionDigest(state),
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
    proposal: resolved.proposal,
    authorizations: resolved.authorization?.covered ?? [],
    // The cause of a block travels with the boundary that declares it: a
    // `blocked` directive without its error is refused at construction.
    error: resolved.error,
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
 * — instead of inventing a second envelope. A flow boundary normally asks for a
 * judgment, not for files, and then it declares no writable destination at all.
 *
 * An AUTHORING row is the exception, and its destinations are not a courtesy:
 * they are the write boundary, enforced by the protocol's own path check, so a
 * proposal that reaches outside the folders the row declared never gets sealed —
 * let alone approved.
 */
export function boundaryRequest(decision: FlowDecision, state: FlowRunState): SemanticRequest {
  const vocabulary = decision.signals ?? [];
  const proposes = proposalContractOf(decision);
  const taxonomy =
    vocabulary.length === 0
      ? "Esta frontera no admite señales: contestá en 'decisions' lo que el contrato pide."
      : `Declarás en 'signals' solo las que observás, de este vocabulario cerrado: ${vocabulary.join(", ")}. Una señal fuera de él no avanza el recorrido. El umbral sobre las señales lo aplica el CLI, no vos.`;
  // What the authoring row asks for, said once: the exact bytes. Everything the
  // handshake needs afterwards — el sello, la vista previa, el grant, la escritura
  // atómica y el índice — lo deriva el CLI, y decirlo acá es lo que evita que el
  // host se ponga a construir digests o referencias por su cuenta.
  const authoring =
    proposes === null
      ? ""
      : ` Devolvé en 'artifacts' los bytes exactos que hay que escribir, cada uno con su 'path' dentro de ${proposes.destinations.join(", ")}. El CLI sella la propuesta, la muestra como vista previa y la escribe entera o no la escribe: vos no armás digests, envelopes ni referencias.`;
  return buildSemanticRequest({
    operation: `flow.${decision.id}`,
    inputs: boundaryInputs(state, decision),
    contract: `${decision.title}. Devolvé un único objeto JSON con el 'input_digest' de esta frontera. ${taxonomy}${authoring} El CLI valida la respuesta antes de aplicar ninguna transición: una respuesta ausente, inválida, ambigua, fuera de alcance o vencida no cambia el estado ni produce efectos.`,
    inventory: { flow: state.flow, applied: state.applied, signals: vocabulary },
    allowedDestinations: proposes === null ? [] : [...proposes.destinations],
    limits:
      proposes === null
        ? { max_artifacts: 0, max_artifact_bytes: 0 }
        : {
            max_artifacts: proposes.limits.maxArtifacts,
            max_artifact_bytes: proposes.limits.maxArtifactBytes,
          },
    readSet: [decision.document],
    readSetBytes: 0,
  });
}

/**
 * The flow control, appended to every boundary that offers alternatives.
 *
 * BOTH halves, and the second one is what this phase added: the chassis' control
 * is `Compactar | Cerrar`, and the engine only ever emitted `Cerrar` — so half
 * the doctrine's own rule had no realization. Pausing under context pressure and
 * stopping for good are different acts with different consequences, and a run
 * that can only stop forces whoever is in it to choose between losing the thread
 * and losing the work.
 *
 * Appended HERE and never by a row: a tranche must not be able to write a
 * boundary nobody can walk away from or pause. Neither is recommended — the
 * recommendation belongs to the content of the question, and nudging someone
 * toward stopping or compacting would be the engine having an opinion about
 * whether to keep going.
 */
export function flowControlChoices(stopping?: string): FlowDirective["choices"] {
  return [
    {
      label: PAUSE_LABEL,
      consequence:
        "se persiste el CHECKPOINT y la corrida retoma en esta misma frontera después de compactar el contexto",
      recommended: false,
    },
    {
      label: STOP_LABEL,
      consequence:
        stopping ?? "el recorrido queda detenido acá, con su estado y su frontera persistidos",
      recommended: false,
    },
  ];
}

/**
 * A human boundary: the alternatives the row declares, or the generic pair.
 *
 * A migrated tranche names its own options — the ones its doctrine used to
 * enumerate — and the engine emits them verbatim, which is what makes the
 * directed journey equivalent to the one it replaces instead of merely similar.
 * Whatever the row says, the flow control is appended.
 */
function humanChoices(decision: FlowDecision): FlowDirective["choices"] {
  const own = alternativesOf(decision);
  const resolve: FlowDirective["choices"] =
    own === null
      ? [
          {
            label: "Resolver la frontera",
            consequence: `decidís '${decision.title}' y el recorrido sigue desde ahí`,
            recommended: true,
          },
        ]
      : own.map((choice) => ({ ...choice }));
  return [...resolve, ...flowControlChoices()];
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
    ...flowControlChoices(
      `no se ejerce ${missing} y el recorrido queda detenido acá, sin nada aplicado`,
    ),
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
