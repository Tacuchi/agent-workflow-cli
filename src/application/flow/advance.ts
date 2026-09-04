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

import { type EffectClass, touchesTheWorld } from "../../domain/capability/effects.js";
import type { CapabilityFailure, CapabilityOutcome } from "../../domain/capability/protocol.js";
import {
  DOCS_BOUNDARY,
  type DelegatedAction,
  FIX_PREVIEW_TRANSITION,
  type FlowDecision,
  SETTLEMENT_READINGS,
  actionOf,
  alternativesOf,
  effectsOf,
  internalActionOf,
  isRouteEvaluation,
  proposalContractOf,
  publishApprovalOf,
  routeControlOf,
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
import { ROUTE_ACCEPT_LABEL, ROUTE_ADJUST_LABEL, dispositionOf } from "../../domain/flow/route.js";
import {
  type RunBinding,
  bindAction,
  docsBoundaryBreach,
  skipReason,
} from "../../domain/flow/rules.js";
import {
  type AttemptAccounting,
  type FlowRunAttempt,
  type FlowRunEvent,
  type FlowRunState,
  MAX_BOUNDARY_ATTEMPTS,
  applyAttemptReconciliation,
  applyTransition,
  attemptAccountingAt,
  attemptsAt,
  checkAgainstJourney,
  currentBatchIteration,
  degradeTransition,
  positionDigest,
  reconcileAttemptsAt,
  settlementAmbiguous,
  settlementOwed,
  skipTransition,
  withBoundary,
  withPendingAction,
  withPlanExecBatchStageForTransition,
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

  // The run repairs its OWN bookkeeping first, and only when the mismatch has
  // exactly one reading. No boundary is opened, no attempt is charged, no
  // degradation is asked for and nothing is added to the directive: what the
  // caller sees is the boundary they were going to see anyway, answerable. The
  // repair survives as a line in the run's sealed trace, which is what makes
  // "it is not notified" different from "it cannot be audited".
  const reconciled = reconcileRun(input.state, input.journey);

  // A handoff is terminal for this run even though the linear journey still has
  // rows after the gate. Letting `advance` walk those rows would build the
  // escalation package and then continue toward commits, which is exactly the
  // contradictory route the typed choice closes.
  if (reconciled.handoff !== null && reconciled.handoff !== undefined) {
    const stopped = input.journey[reconciled.applied.length] ?? null;
    let state = withBoundary(reconciled, stopped?.id ?? null);
    state = withPendingAction(state, null);
    return directiveFor(state, resolveBoundary(state, input.journey), input.applied ?? []);
  }

  const walked = walk(reconciled, input.journey);
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
 * Reconcile the boundary the run is standing at, or hand the state back untouched.
 *
 * It asks the domain and applies nothing of its own: which mismatches have one
 * reading is {@link reconcileAttemptsAt}'s call, and repairing-plus-recording is
 * a single function so a repair can never happen unrecorded.
 */
function reconcileRun(state: FlowRunState, journey: readonly FlowDecision[]): FlowRunState {
  const stopped = journey[state.applied.length] ?? null;
  if (stopped === null) return state;
  return applyAttemptReconciliation(state, reconcileAttemptsAt(state, stopped.id));
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
    const passed = passOver(state, decision, journey);
    if (passed !== null) {
      state = passed.state;
      applied.push(passed.step);
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
    state = withPlanExecBatchStageForTransition(
      applyTransition(state, decision.id, effectsOf(decision)),
      decision.id,
    );
    applied.push(stepOf(decision));
  }
  return { state, applied };
}

/**
 * How the walk passes over a step it will not apply — or `null` when it must not.
 *
 * A condition that did not fire, and a boundary this run has already tried as
 * often as it may, both leave the step behind and both say why. They are NOT the
 * same fact, and the state records them apart: "the gate never appeared" and
 * "nobody answered it and the retry burned" read identically in a cursor, which
 * is exactly the lie an exhausted boundary used to tell — credited among the
 * applied, filed among the skipped, with no degradation declared anywhere.
 */
function passOver(
  state: FlowRunState,
  decision: FlowDecision,
  journey: readonly FlowDecision[],
): { state: FlowRunState; step: FlowStep } | null {
  const conditional =
    routeSkipReason(state, decision) ??
    skipReason(decision, journey, state.observations, currentBatchIteration(state, decision.id)) ??
    nothingToPublish(state, decision) ??
    nothingToSettle(state, decision);
  const degraded = conditional === null ? exhaustionSkip(state, decision) : null;
  const reason = conditional ?? degraded;
  if (reason === null) return null;
  return {
    state:
      degraded === null
        ? skipTransition(state, decision.id)
        : degradeTransition(state, decision.id, degraded),
    step: skippedStepOf(decision, reason),
  };
}

/** A route can alter only a transition that opted in through the registry. */
function routeSkipReason(state: FlowRunState, decision: FlowDecision): string | null {
  if (routeControlOf(decision) === null) return null;
  const accepted = dispositionOf(state.route_decisions, decision.id);
  if (accepted?.disposition === "omit") {
    return "omitida por la ruta aprobada: la evidencia no se ejecutó ni se presenta como aprobada";
  }
  return null;
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
  // Read once and passed down: `conflictClause` and the unanswerable check both
  // want it, and each call replays the run's attempt history.
  const accounting = attemptAccountingAt(state, stopped.id);
  if (exhausted(state, stopped)) {
    // Two different situations wear the same code, and saying which one this is
    // matters: one continues on the next advance, the other cannot. Reporting the
    // stricter message for both would tell somebody their run is stuck when it is
    // about to move on.
    return {
      code: "FLOW_BOUNDARY_EXHAUSTED",
      message: `'${stopped.id}' agotó sus ${MAX_BOUNDARY_ATTEMPTS} intentos: contestarlo otra vez sería el bucle que la regla evita${conflictClause(accounting)}`,
      action: exhaustedAction(state, stopped),
    };
  }
  // Not exhausted, and still not answerable: the rows this run persisted cannot
  // yield the next ordinal, so the ledger would refuse whatever number a submit
  // computed. Presenting the boundary as answerable here is what used to burn an
  // attempt on a question nobody could answer — and then leave `recover` saying
  // the frontier "todavía se contesta", which was the dead end.
  const stuck = accounting.unanswerable;
  if (stuck !== null) {
    return {
      code: "FLOW_BOUNDARY_UNANSWERABLE",
      // The subject is the RUN's ledger, not this transition's rows: the replay is
      // keyed by boundary seal and walks every row, so the break can sit anywhere
      // and still refuse the ordinal here. Blaming this transition for it would
      // send somebody to read the wrong part of the file.
      message: `la contabilidad de la corrida no permite contestar '${stopped.id}': no puede producir el ordinal siguiente (${stuck.code}: ${stuck.message})${conflictClause(accounting)}`,
      action: `no se pide un ordinal que el propio ledger va a rechazar: '${recoverInvocation(state)}' abre un grant nuevo sobre esta frontera conservando su historia, lo ya aplicado y sus controles de integridad`,
    };
  }
  return null;
}

/**
 * What to do about an exhausted boundary — decided by WHAT is broken.
 *
 * Degrading the gap is the chassis' destination for a gap that cannot close, and
 * it was read first no matter the cause: with the accounting in conflict it
 * repairs nothing, and being the first thing offered is what sent a mechanical
 * mismatch to a refinement nobody needed. A conflict that reaches here is one the
 * automatic reconciliation refused because its reading is NOT unique, so the exit
 * is the verb that recovers — and degradation is not offered at all, because the
 * gap is not the problem.
 */
function exhaustedAction(state: FlowRunState, stopped: FlowDecision): string {
  // Reaching here means the automatic reconciliation did NOT repair the mismatch,
  // so what is left is a count nobody can reconstruct. Not every unrepaired
  // mismatch belongs to the accounting: a boundary that already moved the world
  // is refused BY the recovery too, and there degrading the gap is the honest
  // exit. That is why the scope decides, and not the mere presence of a conflict
  // — a forgiven counter excess keeps reporting its difference forever, and
  // reading that as "broken accounting" would deny degradation to a boundary
  // whose cap was reached legitimately.
  const ambiguous = reconcileAttemptsAt(state, stopped.id).ambiguous;
  if (ambiguous?.scope === "accounting") {
    return `lo roto es la contabilidad de la corrida, no el gap: ${ambiguous.reason}. '${recoverInvocation(state)}' le devuelve los intentos a esta frontera conservando todo lo aplicado; degradar el gap no arregla una cuenta`;
  }
  if (exhaustionSkip(state, stopped) !== null) {
    return `${DEGRADE_ACTION}; el próximo 'aw flow advance' lo pasa por alto dejando dicho por qué y sigue con el resto`;
  }
  return `${DEGRADE_ACTION}, y resolvé este paso fuera de la corrida antes de seguir: saltearlo daría por aprobado un efecto que nadie aprobó, o por hecho algo que nada corrió. Si lo que hay que rehacer es el intento, '${recoverInvocation(state)}' le devuelve los intentos a esta frontera conservando todo lo aplicado`;
}

/**
 * The disagreeing representations, said inline — or nothing.
 *
 * The structured block on the directive is the machine's copy; this is the half a
 * person reads in the message that stopped them. Empty when the accounting is
 * coherent, which is the normal case and deserves no parenthesis.
 */
function conflictClause(accounting: AttemptAccounting): string {
  const conflicts = accounting.conflicts;
  if (conflicts.length === 0) return "";
  const named = conflicts
    .map(
      (conflict) =>
        `${conflict.between[0].name}=${conflict.between[0].value} contra ${conflict.between[1].name}=${conflict.between[1].value} (${conflict.cause})`,
    )
    .join("; ");
  return `. Su contabilidad está en conflicto: ${named}`;
}

/**
 * The way out of a boundary that cannot be degraded, spelled as a runnable line.
 *
 * The session goes in as the FOLDER, the same identity every other invocation of
 * a directive carries: a bare number matches a legacy folder too, so the one
 * command offered to somebody whose run is stuck must not be one that fails to
 * resolve when they paste it.
 */
function recoverInvocation(state: FlowRunState): string {
  return `aw flow recover --session ${state.session}`;
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

/** The three rows of the settlement, in the order the closure walks them. */
const SETTLEMENT_TRANSITIONS = new Set<string>([
  "plan-exec.settlement-authoring",
  "plan-exec.settlement-question",
  "plan-exec.settlement-publication",
]);

/**
 * A closure with nothing owing walks straight past the settlement.
 *
 * This is what makes the three rows cost NOTHING on the normal path: the batch
 * loop's end already snapshotted what the plan owes, so the walk answers "is
 * there anything to settle" from the run's own state without asking anybody. A
 * plan with no live compensation closes exactly as it closed before these rows
 * existed — same boundaries, same questions, none of them new.
 *
 * The question skips on a second count, and it is the one that keeps the person
 * out of the CLI's bookkeeping: an obligation whose class the note declared, or
 * whose text the plan already enumerates as a handoff, has exactly ONE reading.
 * Asking about it would be asking somebody to ratify arithmetic.
 */
function nothingToSettle(state: FlowRunState, decision: FlowDecision): string | null {
  if (!SETTLEMENT_TRANSITIONS.has(decision.id)) return null;
  if (!settlementOwed(state)) {
    // Dicho sobre el SNAPSHOT y no sobre el plan, porque son dos cosas: un plan
    // cuyo linaje no se puede leer tampoco deja nada en el snapshot —no hay nota
    // que sustituir— y no por eso es cerrable. Afirmar «el plan no conserva
    // compensación vigente» era falso justo ahí, y `plan-done` lo rechaza
    // después nombrando la reparación.
    return "el recorrido no tiene ninguna obligación que saldar: sin una nota vigente que sustituir no hay saldo que publicar";
  }
  if (decision.id === "plan-exec.settlement-question" && settlementAmbiguous(state).length === 0) {
    return "ninguna obligación vigente admite más de una lectura: no hay nada que preguntar";
  }
  return null;
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
 *
 * A delegated step has ONE way past that exception, and it is narrow twice over.
 * The run's own trace has to say the action RAN and FAILED — "nobody has executed
 * it yet" is a boundary still waiting for real work — AND the step has to be one
 * whose skipping credits nothing: a read. A row that WRITES stays exhausted even
 * with a failure behind it, because the run would go on to declare itself
 * finished while the document it exists to produce was never written, which is
 * the same credit-to-nothing this exception was carved out of. Its way out is not
 * degradation but `aw flow recover`, and the block says so.
 */
function exhaustionSkip(state: FlowRunState, decision: FlowDecision): string | null {
  if (!exhausted(state, decision)) return null;
  if (!owned(decision)) return null;
  // Degradation is what a GAP that cannot close deserves. When the exhaustion
  // comes from a bookkeeping mismatch the automatic reconciliation could not
  // read, passing the step over would skip real work because two counters
  // disagree — the same mistake as sending it to a refinement, one notch worse.
  // So it is not offered at all: the boundary blocks and names the recovery.
  if (reconcileAttemptsAt(state, decision.id).ambiguous?.scope === "accounting") return null;
  const failure = executionFailure(state, decision.id);
  if (actionOf(decision) !== null && failure === null) return null;
  if (failure !== null && touchesTheWorld(effectsOfTransition(state, decision))) return null;
  if (
    authorizeTransition(decision, state.authorizations, subjectOf(state, decision)).missing.length >
    0
  ) {
    return null;
  }
  const spent = `agotó sus ${MAX_BOUNDARY_ATTEMPTS} intentos`;
  return failure === null
    ? `${spent}: ${DEGRADE_ACTION}`
    : `su acción se ejecutó y falló (${failure.code}: ${failure.message}) y ${spent}: ${DEGRADE_ACTION}`;
}

/**
 * The failure a delegated action of this transition really produced, if any.
 *
 * The LAST event for the transition, not any of them: an action that failed and
 * then succeeded left both events behind, and reading the older one would call a
 * finished step failed. Reads the material trace rather than the attempt history
 * because the two answer different questions — "how many times was this asked"
 * versus "did anything actually run".
 */
function executionFailure(
  state: FlowRunState,
  transition: string,
): Extract<FlowRunEvent, { kind: "failed" }> | null {
  const last = state.events.filter((event) => event.transition === transition).at(-1);
  return last !== undefined && last.kind === "failed" ? last : null;
}

/**
 * The attempt a delegated action spends when it RUNS and comes back failed.
 *
 * The hole this closes was measured: five consecutive `aw flow advance` against a
 * blocked internal execution returned the identical error and left the ledger
 * with ZERO rows for that boundary. No attempt was ever recorded, so the cap
 * never applied, so the boundary never degraded — and with no recovery either,
 * the run was stuck for good.
 *
 * It is charged by whoever ran the operation, at the moment its verdict refuses,
 * and NOT on the way into an advance. Charging on the way in cost the person who
 * fixed the cause their real third try — the run degraded the boundary on the
 * advance that would have re-run the now-working action — and it charged the very
 * pause the CLI recommends, since coming back with `aw flow advance` is what the
 * directive tells you to do. A try is a try: the action ran and did not work.
 */
export function failedExecutionAttempt(
  state: FlowRunState,
  decision: FlowDecision,
  failure: { code: string; message: string },
): FlowRunAttempt {
  const seal = boundarySeal(state, decision);
  const batchIteration = currentBatchIteration(state, decision.id);
  const prior = state.attempts.filter((past) => past.invocation_id === seal);
  const attempt = prior.length + 1;
  return {
    invocation_id: seal,
    attempt,
    // The failure itself plus the ordinal: two retries of the same broken action
    // are two attempts, and a digest that repeated would make the second one look
    // like a resend of the first.
    request_digest: semanticDigest({
      execution_failure: { transition: decision.id, code: failure.code, message: failure.message },
      attempt,
    }),
    parent_request_digest:
      prior.find((past) => past.attempt === attempt - 1)?.request_digest ?? null,
    transition: decision.id,
    ...(batchIteration === null ? {} : { batch_iteration: batchIteration }),
  };
}

/** The `docs/` folders a flow may write, said the way a person reads it. */
function describeAllowance(flow: FlowRunState["flow"]): string {
  const allowed = DOCS_BOUNDARY[flow];
  return allowed.length === 0 ? "ninguna carpeta de docs" : allowed.join(" y ");
}

/**
 * What a handed-off run tells whoever is in it — and it is TWO steps, not one.
 *
 * A handoff is terminal for the walk, so `chassis.finalize` — the suffix row that
 * closes the session — is never emitted after it, and the destination command
 * alone would leave a live session on the board with no pointer to where the work
 * went. The close is named first because that is the order doctrine promises: the
 * pointer goes into the session's BACKLOG, the close persists the CHECKPOINT, and
 * only then does the work continue at the destination.
 */
function handoffAction(session: string, command: string): string {
  return `anotá el puntero de escalación en el BACKLOG de la sesión y cerrala con 'aw session-close --code ${session}' —que persiste el CHECKPOINT—; después seguí con ${command}`;
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
  if (state.handoff !== null && state.handoff !== undefined) {
    return {
      stopped,
      kind: "blocked",
      authorization: null,
      request: null,
      action: null,
      proposal: null,
      choices: [],
      pending,
      seal: boundarySeal(state, stopped),
      error: {
        code: "FLOW_HANDOFF",
        message: `la corrida entregó '${state.handoff.destination}' desde '${state.selected_choice?.label ?? "la desviación"}' y no puede continuar hacia '${stopped.id}'`,
        action: handoffAction(state.session, state.handoff.command),
      },
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
  const routeReview = isRouteEvaluation(stopped) && state.route_proposal !== null;
  const kind =
    blocked === null
      ? routeReview
        ? "human"
        : boundaryKind(stopped, (authorization?.missing.length ?? 0) > 0)
      : "blocked";
  return {
    stopped,
    kind,
    authorization,
    request: kind === "semantic" ? boundaryRequest(stopped, state) : null,
    action: kind === "execution" ? emitted.action : null,
    proposal: subject === null ? null : previewOfState(state),
    choices: routeReview ? routeChoices() : choicesFor(kind, stopped, authorization, state),
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
          authority:
            isRouteEvaluation(resolved.stopped) && state.route_proposal !== null
              ? "human"
              : resolved.stopped.authority,
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
    decisionPreview:
      state.decision_preparation?.kind === "prepared" ? state.decision_preparation.preview : null,
    // Only where it is the subject: the quick gate that approves the declared
    // fix. That is what lets `Compactar` come back to that boundary and show the
    // very thing the person is being asked to approve.
    fixPreview:
      resolved.stopped?.id === "quick.fix-preview-approval" ? (state.fix_preview ?? null) : null,
    route: {
      proposal: state.route_proposal,
      decisions: state.route_decisions ?? [],
      assurance: state.assurance,
    },
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
    // Derived here rather than by each caller: the directive is the one surface
    // every host and every agent already reads, so this is where the spend stops
    // being prose.
    attemptAccounting:
      resolved.stopped === null ? null : attemptAccountingAt(state, resolved.stopped.id),
    nextAction: overrides.nextAction ?? nextActionFor(state, boundary, resolved),
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
  const decisionDraft =
    decision.id === "plan-exec.deviation-recognition"
      ? " Si la desviación puede resolverse registrando una decisión, incluí en 'decisions.decision' su question y draft completos ahora: el CLI preparará y mostrará el preview sellado antes de que una persona elija registrarlo. Cada obligación del draft va como { text, kind }: 'compensation' es trabajo que este linaje debe y bloquea su cierre, 'handoff' es trabajo que queda a cargo de otra gente y no lo bloquea."
      : "";
  // La misma pista que el borrador de decisión, y por el mismo motivo: la forma
  // exacta se dice ANTES para que el primer intento la traiga. Acá pesa el doble,
  // porque un preview inválido es un rechazo evaluado y gasta uno de los tres.
  const settlementDraft =
    decision.id === "plan-exec.settlement-authoring"
      ? ` Devolvé en 'decisions.settlement' una lista con una entrada por cada compensación vigente: { note, index, outcome, evidence? }. 'note' e 'index' son los que el tablero ya nombra. 'outcome' es 'settled' —con 'evidence': la salida real de lo que lo prueba—, 'handoff' —el trabajo es de otra gente— o 'pending' —todavía no se hizo, y entonces el cierre se detiene acá hasta que se haga—. Para una obligación cuya clase nadie declaró y que el plan no enumera, lo que declares es la lectura que PROPONÉS: una persona la ratifica en la frontera siguiente.`
      : "";
  const fixPreview =
    decision.id === FIX_PREVIEW_TRANSITION
      ? " Devolvé en 'decisions.preview' un objeto con 'files' (las rutas que vas a tocar, lista que puede ir VACÍA si el entregable es un análisis), 'intent' (qué arregla y por qué) y 'diff' (la forma esperada del diff). Proporcional a la tarea: una línea para algo trivial; enfoque, archivos y riesgos para algo complejo."
      : "";
  return buildSemanticRequest({
    operation: `flow.${decision.id}`,
    inputs: boundaryInputs(state, decision),
    contract: `${decision.title}. Devolvé un único objeto JSON con el 'input_digest' de esta frontera.${isRouteEvaluation(decision) ? " En 'decisions.route' incluí summary { finding, diagnosis, solution } con una explicación breve para una persona que no conoce Workline; basis (intention, checkout, conventions, adopted_decisions); y controls: solo ids configurados como route_control, con disposition apply|omit|substitute, reason y, para substitute, substitution { validation, risk }. No incluyas gates duros: el CLI los rechaza." : ""} ${taxonomy}${authoring}${decisionDraft}${settlementDraft}${fixPreview} El CLI valida la respuesta antes de aplicar ninguna transición: una respuesta ausente, inválida, ambigua, fuera de alcance o vencida no cambia el estado ni produce efectos.`,
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
      outcome: { kind: "control", control: "pause" },
    },
    {
      label: STOP_LABEL,
      consequence:
        stopping ?? "el recorrido queda detenido acá, con su estado y su frontera persistidos",
      recommended: false,
      outcome: { kind: "control", control: "stop" },
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
 *
 * One consequence is not verbatim, and it cannot be: a row is written once and a
 * standalone plan has no contract chain to add a note to, so the registry's own
 * text would promise a durable note that nothing writes. The lineage is already
 * sealed in the run's decision preparation, so the choice is made HERE, where the
 * state is — never in the row, which cannot see it.
 */
function humanChoices(decision: FlowDecision, state: FlowRunState): FlowDirective["choices"] {
  const own = alternativesOf(decision);
  const resolve: FlowDirective["choices"] =
    own === null
      ? [
          {
            label: "Resolver la frontera",
            consequence: `decidís '${decision.title}' y el recorrido sigue desde ahí`,
            recommended: true,
            outcome: { kind: "continue" },
          },
        ]
      : own.map((choice) => ({
          ...choice,
          ...(standaloneRegistration(decision, state, choice.outcome)
            ? { consequence: STANDALONE_REGISTRATION_CONSEQUENCE }
            : {}),
          ...settlementRecommendation(decision, state, choice),
        }));
  return [...resolve, ...flowControlChoices()];
}

/** The label each settlement reading is offered under — from the row's own table. */
const SETTLEMENT_LABELS: ReadonlyMap<string, string> = new Map(
  SETTLEMENT_READINGS.map((reading) => [reading.outcome, reading.label]),
);

/**
 * What the settlement question recommends, and why that is not the CLI deciding.
 *
 * The recommendation is the AGENT's proposed reading, carried from the authoring
 * row: it read the obligation, the plan and the evidence, so starting the person
 * from a cold menu would waste the one thing that boundary produced. When the
 * proposals disagree with each other the recommendation falls back to the safe
 * reading, because one answer is applied to all of them and the safe one is the
 * only reading that cannot discharge work nobody did.
 *
 * The consequence names the obligations at stake and the evidence gathered for
 * them, so what is being ratified is on screen and not one row back.
 */
function settlementRecommendation(
  decision: FlowDecision,
  state: FlowRunState,
  choice: { label: string; consequence: string },
): { recommended: boolean; consequence?: string } | Record<string, never> {
  if (decision.id !== "plan-exec.settlement-question") return {};
  const ambiguous = settlementAmbiguous(state);
  if (ambiguous.length === 0) return {};
  const declared = state.settlement?.declared ?? [];
  const proposals = new Set(
    ambiguous.map(
      (obligation) =>
        declared.find((entry) => entry.note === obligation.note && entry.index === obligation.index)
          ?.outcome ?? "pending",
    ),
  );
  const [only] = [...proposals];
  const proposed = proposals.size === 1 && only !== undefined ? only : "pending";
  // The evidence OF THESE obligations, never of every declaration in the run: a
  // question about one obligation that displayed another's proof would be the
  // opposite of the auditability this boundary exists for.
  const evidence = ambiguous
    .map(
      (obligation) =>
        declared.find((entry) => entry.note === obligation.note && entry.index === obligation.index)
          ?.evidence,
    )
    .filter((value): value is string => value !== undefined)
    .join("; ");
  const subject = ambiguous
    .map((obligation) => `${obligation.note}: ${obligation.text}`)
    .join("; ");
  return {
    recommended: SETTLEMENT_LABELS.get(proposed) === choice.label,
    // Appended, never replacing: what each reading DOES is the row's own text,
    // and dropping it would leave the person choosing between three subjects
    // with no consequences attached.
    consequence: `${choice.consequence} · se aplica a ${subject}${evidence.length === 0 ? "" : ` · evidencia declarada: ${evidence}`}`,
  };
}

/** The only route decision: accept the complete sealed preview or request changes. */
function routeChoices(): FlowDirective["choices"] {
  return [
    {
      label: ROUTE_ACCEPT_LABEL,
      consequence:
        "se guarda este enfoque y el trabajo continúa con los controles explicados en la propuesta",
      recommended: true,
      outcome: { kind: "continue" },
    },
    {
      label: ROUTE_ADJUST_LABEL,
      consequence:
        "no se aplica ningún cambio; podés indicar qué corregir antes de recibir una nueva propuesta",
      recommended: false,
      outcome: { kind: "continue" },
    },
    ...flowControlChoices(),
  ];
}

/** What registering a decision really leaves behind when the plan is standalone. */
const STANDALONE_REGISTRATION_CONSEQUENCE =
  "no hay nota de contrato: la decisión queda en la traza de la corrida y la anotás en el DECISION.md de la sesión; la ejecución sigue desde su punto de reanudación";

/**
 * Whether this alternative is the deviation gate's registration over a plan with
 * no spec — the only case where the row's durable-note promise is false.
 *
 * A null preparation cannot take this exit at all (the submit refuses it with
 * `FLOW_DECISION_PREVIEW_ABSENT`), so the standalone variant covers every case
 * where registering can succeed without a note.
 */
function standaloneRegistration(
  decision: FlowDecision,
  state: FlowRunState,
  outcome: FlowDirective["choices"][number]["outcome"],
): boolean {
  return (
    decision.id === "plan-exec.deviation-gate" &&
    outcome.kind === "register-decision" &&
    state.decision_preparation?.kind === "standalone"
  );
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
      outcome: { kind: "continue" },
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
  state: FlowRunState,
): FlowDirective["choices"] {
  if (kind === "authorization" && unauthorized !== null) {
    return authorizationChoices(stopped, unauthorized);
  }
  return kind === "human" ? humanChoices(stopped, state) : [];
}

/**
 * What the END of a run says — including what it gave up on along the way.
 *
 * "Nothing pending" was the whole sentence, and a run that degraded a boundary
 * said it too: the gap the loop stopped re-firing left no trace in the one line
 * a reader actually reads, so a run that quietly skipped a step and a run that
 * answered every one of them closed with the identical words. The degradations
 * are in the state either way; this is what makes them impossible to miss.
 */
function finalAction(state: FlowRunState): string {
  const degraded = state.degraded ?? [];
  if (degraded.length === 0) {
    return state.assurance === "verified"
      ? "recorrido terminado · verified"
      : `recorrido terminado · ${state.assurance}: la evidencia omitida o sustituida no se presenta como verde`;
  }
  const names = degraded.map((one) => `'${one.transition}'`).join(", ");
  return `el recorrido terminó dejando degradadas ${names}: nadie las resolvió y el estado declara la causa de cada una — ${DEGRADE_ACTION}`;
}

function nextActionFor(
  state: FlowRunState,
  boundary: FlowBoundary,
  resolved: ResolvedBoundary,
): string {
  if (state.handoff !== null && state.handoff !== undefined) {
    return handoffAction(state.session, state.handoff.command);
  }
  const stopped = resolved.stopped;
  if (stopped === null) return finalAction(state);
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
