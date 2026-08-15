/**
 * One invocation also EXHAUSTS every internal action it may run, not only every
 * decision it may take.
 *
 * The walk in `advance` stops at any delegated step because deciding and executing
 * are different acts. That is still true — what changed is who executes: an action
 * the registry classifies `internal` is a Workline operation this process can
 * materialize, so handing it back as work would be the CLI asking somebody to run
 * `aw` for it. This driver closes that gap and nothing else: it runs the operation,
 * judges the real output with the SAME verdict an external result faces, applies
 * the transition and keeps going until a boundary that genuinely is not the CLI's.
 *
 * **Three writes, in this order, and the order is the contract.**
 *
 * 1. The intent — `pending_action.attempted` — is persisted BEFORE the operation
 *    runs. A process that dies during a close would otherwise come back with no
 *    way to tell "never started" from "already closed", and the two need different
 *    answers.
 * 2. The operation runs with NO lock held. Holding the run's lock across an
 *    effect that takes its own would be the deadlock this design avoids by making
 *    the two moments separate writes rather than one long one.
 * 3. The result is judged and applied under the lock again, compare-and-swap on
 *    the digest step 1 produced. A state that moved in between belongs to another
 *    invocation, and the answer is to re-advance — never to overwrite it.
 *
 * Re-entry follows from the same three: `attempted` with an idempotent operation
 * is re-run and confirmed — that is what "recoverable without reopening the
 * session" means, since closing an already closed session is the close itself
 * saying so. `attempted` with a non-idempotent one stops at its boundary with the
 * row's own recovery: applying it twice is the one failure nobody can undo.
 */

import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import type { FlowExecutionResult } from "../../domain/flow/answer.js";
import {
  type DelegatedAction,
  type FlowDecision,
  type InternalActionPlan,
  internalActionOf,
  journeyOfFlow,
} from "../../domain/flow/authority.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import { stepOf } from "../../domain/flow/directive.js";
import { executionVerdict } from "../../domain/flow/execution-result.js";
import {
  type FlowRunEvent,
  type FlowRunState,
  applyTransition,
  restatesLastEvent,
  withActionAttempted,
  withAttempt,
  withBoundary,
  withEvent,
  withPendingAction,
  withProposal,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { sessionNumericCode } from "../session-resolver.js";
import {
  advanceFlowRun,
  directiveFor,
  effectsOfTransition,
  failedExecutionAttempt,
  resolveBoundary,
} from "./advance.js";
import type { InternalActionExecutor, InternalActionOutcome } from "./internal-actions.js";
import { type FlowRunLocation, type FlowRunMutation, applyUnderLock } from "./run-state-service.js";

/**
 * How many internal actions one invocation may chain.
 *
 * A journey has a fixed length, so the walk cannot really loop — but the driver
 * re-resolves the boundary from persisted state on every turn, and a bound is what
 * keeps a defect in that resolution from becoming an invocation that never
 * returns. Twice the longest journey, so the cap can only ever be a bug's ceiling
 * and never a real run's.
 */
const MAX_INTERNAL_STEPS = 64;

export type DrivenRun = { ok: true; state: FlowRunState; value: FlowDirective };

/**
 * Run every internal action standing between here and the next real boundary.
 *
 * `executor` absent means this caller has no way to materialize anything — a
 * lightweight context, a test that only exercises the walk — and then an internal
 * action behaves exactly like an external one: the boundary is emitted with its
 * invocation, which is what the caller would have had to run anyway. That is a
 * degradation of the MECHANISM, never of the contract: nothing is credited, and
 * the directive says what is pending.
 */
export async function driveInternalActions(
  fs: FileSystemPort,
  location: FlowRunLocation,
  executor: InternalActionExecutor | undefined,
  from: DrivenRun,
): Promise<DrivenRun | { ok: false; failure: CapabilityFailure }> {
  if (executor === undefined) return from;
  let current = from;
  for (let step = 0; step < MAX_INTERNAL_STEPS; step += 1) {
    const pending = nextInternal(current.state);
    if (pending === null) return current;

    const marked = await markAttempted(fs, location, current);
    if (!marked.ok) return marked;
    current = marked;

    const outcome = await run(executor, pending, current.state);

    const settled = await settle(fs, location, current, pending, outcome);
    if (!settled.ok) return settled;
    current = settled.run;
    if (!settled.advanced) return current;
  }
  return current;
}

interface PendingInternal {
  decision: FlowDecision;
  action: DelegatedAction;
  plan: InternalActionPlan;
}

/**
 * The operation, with a thrown error turned into a refusal.
 *
 * A service that throws — an unreadable workspace, a lock nobody released — must
 * not take the whole invocation down with a stack trace: the run is standing on a
 * boundary, and what the person needs is that boundary back with a cause and the
 * row's recovery. Fail-closed here means "nothing is credited AND the run is still
 * answerable", not "the process dies before writing anything".
 */
async function run(
  executor: InternalActionExecutor,
  pending: PendingInternal,
  state: FlowRunState,
): Promise<InternalActionOutcome> {
  const coordinates = {
    session: state.session,
    code: sessionNumericCode(state.session) ?? state.session,
    scope: state.scope,
    proposal: state.proposal,
  };
  try {
    return await executor(pending.plan, coordinates);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      summary: `${pending.plan.operation}: la operación interna falló (${why})`,
      output: "",
      effects: [],
    };
  }
}

/**
 * The internal action this run is standing on, or `null` for anything else.
 *
 * Derived from the persisted state and the registry only — never from what the
 * previous turn believed — so a run resumed by another process reaches exactly the
 * same conclusion as the one that left it there.
 */
function nextInternal(state: FlowRunState): PendingInternal | null {
  const journey = journeyOfFlow(state.flow);
  const resolved = resolveBoundary(state, journey);
  if (resolved.kind !== "execution" || resolved.stopped === null || resolved.action === null) {
    return null;
  }
  const plan = internalActionOf(resolved.stopped);
  if (plan === null) return null;
  // A non-idempotent operation already begun is the one case that must NOT run
  // again. It cannot happen today — every internal row is idempotent — and it is
  // checked anyway, because the day a row is not, the failure would be silent and
  // unrepeatable.
  if (state.pending_action?.attempted === true && !resolved.action.idempotent) return null;
  return { decision: resolved.stopped, action: resolved.action, plan };
}

/** Persist "we are about to run this", CAS on the state the caller reasoned over. */
async function markAttempted(
  fs: FileSystemPort,
  location: FlowRunLocation,
  current: DrivenRun,
): Promise<DrivenRun | { ok: false; failure: CapabilityFailure }> {
  if (current.state.pending_action?.attempted === true) return current;
  const marked = await applyUnderLock<null>(
    fs,
    location,
    (live) => {
      if (live === null) return { ok: false, failure: RUN_VANISHED };
      return { ok: true, state: withActionAttempted(live), value: null };
    },
    { expectDigest: current.state.digest },
  );
  if (!marked.ok) return marked;
  return { ok: true, state: marked.state, value: current.value };
}

/**
 * Judge the outcome and either apply the transition or keep the boundary.
 *
 * `advanced: false` is what stops the driver: a refusal has already produced the
 * directive the caller needs — the same boundary, with the real cause and the
 * row's recovery — and running the next turn would re-run an operation whose
 * output was just refused.
 */
async function settle(
  fs: FileSystemPort,
  location: FlowRunLocation,
  current: DrivenRun,
  pending: PendingInternal,
  outcome: InternalActionOutcome,
): Promise<
  { ok: true; run: DrivenRun; advanced: boolean } | { ok: false; failure: CapabilityFailure }
> {
  const applied = await applyUnderLock<{ directive: FlowDirective; advanced: boolean }>(
    fs,
    location,
    (live) => {
      if (live === null) return { ok: false, failure: RUN_VANISHED };
      return accept(live, pending, outcome);
    },
    { expectDigest: current.state.digest },
  );
  if (!applied.ok) return applied;
  return {
    ok: true,
    run: { ok: true, state: applied.state, value: applied.value.directive },
    advanced: applied.value.advanced,
  };
}

function accept(
  state: FlowRunState,
  pending: PendingInternal,
  outcome: InternalActionOutcome,
): FlowRunMutation<{ directive: FlowDirective; advanced: boolean }> {
  const journey = journeyOfFlow(state.flow);
  // What the row declares is the CEILING; what a sealed proposal really does is
  // the effect. Judging the publication against the ceiling would refuse a
  // proposal that only creates files on a row that also permits overwriting.
  const declared = effectsOfTransition(state, pending.decision);
  const verdict = executionVerdict(resultOf(pending, outcome), pending.action, declared);
  const outputDigest = semanticDigest({ output: outcome.output });

  if (verdict !== null) {
    const failure: Extract<FlowRunEvent, { kind: "failed" }> = {
      kind: "failed",
      transition: pending.decision.id,
      operation: pending.plan.operation,
      code: verdict.detail.code,
      // What the operation really found, not the contract's restatement of it:
      // the trace is where "which precondition was missing" has to survive.
      message: outcome.summary,
      recovery: verdict.detail.action,
      // What it applied ANYWAY. A failed operation that got partway is the case
      // where handing the boundary back as answerable would put a second answer
      // on top of a half-applied effect, and this is the only record of it.
      effects: [...outcome.effects],
    };
    // Re-running `aw flow advance` over a boundary nobody has fixed yet reaches
    // exactly this point again, and appending the identical event every time would
    // turn the trace into a retry counter. The same failure, still standing, is one
    // fact — the attempt history is where "how many times" belongs, and that is
    // charged right below, every time, precisely because the event is not.
    const traced = restatesLastEvent(state, failure) ? state : withEvent(state, failure);
    // The try the cap counts: the action RAN and came back refused. Charged here
    // rather than on the way into the next advance, so somebody who fixes the
    // cause gets the run that would have worked instead of a degradation.
    const failed = withAttempt(
      traced,
      failedExecutionAttempt(traced, pending.decision, {
        code: verdict.detail.code,
        message: outcome.summary,
      }),
    );
    const resolved = resolveBoundary(failed, journey);
    const built = directiveFor(failed, resolved, [], {
      ...(verdict.detail.outcome === undefined ? {} : { outcome: verdict.detail.outcome }),
      nextAction: `${outcome.summary} — ${verdict.detail.action}`,
    });
    if (!built.ok) return { ok: false, failure: built.failure };
    return {
      ok: true,
      state: failed,
      value: {
        directive: {
          ...built.directive,
          // The verdict's own code, exactly as an external result would get: an
          // internal execution that reported a private vocabulary would make the
          // same refusal readable one way from one producer and another way from
          // the other. The material cause travels as the message.
          error: resolved.error ?? {
            code: verdict.detail.code,
            message: `${verdict.message}: ${outcome.summary}`,
            action: verdict.detail.action,
          },
        },
        advanced: false,
      },
    };
  }

  let next = withEvent(state, {
    kind: "executed",
    transition: pending.decision.id,
    operation: pending.plan.operation,
    summary: outcome.summary,
    output_digest: outputDigest,
    effects: [...outcome.effects],
    evidence: [...pending.action.evidence],
  });
  next = applyTransition(next, pending.decision.id, declared);
  // A published proposal is spent. Leaving it seated would keep a preview of
  // bytes that are already on disk standing in front of the next boundary, and the
  // grant given over its seal would outlive the thing it was given for.
  if (pending.plan.operation === "proposal.publish") next = withProposal(next, null);
  // The pending action is cleared explicitly rather than left for the next
  // `withPendingAction` to overwrite: between applying and re-advancing the state
  // is persisted, and a state that still named an action nobody is waiting on
  // would tell whoever resumes to run it again.
  next = withPendingAction(next, null);
  next = withBoundary(next, journey[next.applied.length]?.id ?? null);

  const advanced = advanceFlowRun({ state: next, journey, applied: [stepOf(pending.decision)] });
  if (!advanced.ok) return { ok: false, failure: advanced.failure };
  return {
    ok: true,
    state: advanced.state,
    value: { directive: advanced.directive, advanced: true },
  };
}

/**
 * The outcome, expressed in the result protocol an external executor would send.
 *
 * Built rather than shortcut on purpose: the verdict must not be able to tell an
 * internal result from an external one, so the internal path assembles the same
 * fields — the invocation the row declared, the demanded evidence with the REAL
 * output as its detail, and the effects the operation actually applied.
 */
function resultOf(pending: PendingInternal, outcome: InternalActionOutcome): FlowExecutionResult {
  return {
    // The INVOCATION completed — the service returned, and everything it had is in
    // `output`. What may be missing is the evidence the transition demanded, and
    // saying that with `outcome: failed` would report a broken tool where the real
    // fact is an artifact that is not there. The validations below are what refuse.
    outcome: "completed",
    invocation: pending.action.invocation,
    output: { value: null, reference: null, completeness: "complete" },
    validations: pending.action.evidence.map((id) => ({
      id,
      passed: outcome.ok,
      detail: outcome.ok ? outcome.output : outcome.summary,
    })),
    effects: {
      planned: [...outcome.effects],
      approved: [...outcome.effects],
      applied: [...outcome.effects],
    },
  };
}

const RUN_VANISHED: CapabilityFailure = {
  code: "FLOW_RUN_ABSENT",
  message: "el estado de corrida desapareció mientras se ejecutaba su acción interna",
  action: "re-adoptá la sesión con 'aw flow advance --flow <flow> --adopt' antes de seguir",
};
