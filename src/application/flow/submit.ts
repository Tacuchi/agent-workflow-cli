/**
 * An answer comes back, and either it survives validation or nothing moves.
 *
 * The order of the checks is the contract, not an implementation detail:
 *
 * 1. **Resend first.** The attempt history is hydrated from the persisted state
 *    and consulted before anything else. A resend of an answer that was already
 *    applied quotes the seal of a boundary the run has since left, so judging
 *    staleness first would report "stale" for what is really "already applied" —
 *    and would tempt the sender into answering twice.
 * 2. **Then the boundary in force.** Which shape is admissible comes from the
 *    boundary, never from a flag: the same `submit` answers a semantic boundary,
 *    a human one and an authorization one.
 * 3. **Then apply.** Only a surviving answer becomes a transition, and only then
 *    does the run keep advancing until the next boundary. One surviving answer
 *    deliberately applies nothing: an approval over a step doctrine still owns
 *    grants the effect and leaves the run where it stands.
 *
 * Every rejection travels with `ok: true` inside the RECALCULATED directive,
 * carrying its code, message and action — with `ok: false` the host never calls
 * `renderHuman`, and a boundary nobody can see is a boundary that did not happen.
 */

import type { EffectClass } from "../../domain/capability/effects.js";
import { AttemptLedger } from "../../domain/capability/protocol.js";
import type { CapabilityFailure, CapabilityOutcome } from "../../domain/capability/protocol.js";
import { type FlowAnswer, claimedSeal, parseFlowAnswer } from "../../domain/flow/answer.js";
import {
  type DelegatedAction,
  type FlowDecision,
  actionOf,
  decisionsOfScope,
  effectsOf,
} from "../../domain/flow/authority.js";
import { effectApprovalDigest } from "../../domain/flow/authorization.js";
import { type FlowDirective, stepOf } from "../../domain/flow/directive.js";
import {
  type FlowRunAttempt,
  type FlowRunState,
  applyTransition,
  checkAgainstJourney,
  withApproval,
  withAttempt,
  withBoundary,
  withObservation,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { type SessionResolutionError, resolveSessionTarget } from "../session-resolver.js";
import {
  type ResolvedBoundary,
  actionDigest,
  advanceFlowRun,
  directiveFor,
  resolveBoundary,
} from "./advance.js";
import { type FlowRunMutation, applyUnderLock, locateRun } from "./run-state-service.js";

/** The label that declines a boundary instead of resolving it. */
export const DECLINE_LABEL = "Cerrar";

export interface SubmitFlowInput {
  code?: string;
  contextId?: string;
  /** The JSON payload, read from stdin. */
  raw: string;
  /** `--approval <digest>`, apart from the payload on purpose. */
  approval: string | null;
}

export type SubmitFlowResult =
  | { ok: true; directive: FlowDirective }
  | { ok: false; failure: CapabilityFailure }
  | { ok: false; session: SessionResolutionError };

export async function submitFlow(
  fs: FileSystemPort,
  paths: PathsService,
  input: SubmitFlowInput,
): Promise<SubmitFlowResult> {
  const resolution = await resolveSessionTarget(fs, paths, {
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.contextId !== undefined ? { contextId: input.contextId } : {}),
    allowClosed: false,
    bind: true,
  });
  if (resolution.outcome !== "resolved") return { ok: false, session: resolution };

  const location = locateRun(paths, resolution.session.folder);
  const applied = await applyUnderLock<FlowDirective>(fs, location, (current) => {
    if (current === null) {
      return {
        ok: false,
        failure: {
          code: "FLOW_RUN_ABSENT",
          message: "no hay corrida que responder en esta sesión",
          action: "adoptala primero con 'aw flow advance --flow <flow> --adopt'",
        },
      };
    }
    return decide(current, input);
  });

  if (!applied.ok) return { ok: false, failure: applied.failure };
  return { ok: true, directive: applied.value };
}

/**
 * The whole decision, pure over the state read under the lock.
 *
 * Kept separate from the I/O so every branch is reachable from a test without a
 * filesystem, and so "a rejection writes nothing" is visible in one place: the
 * only branches that return a NEW state are the two that legitimately applied
 * something.
 */
type SubmitDecision = FlowRunMutation<FlowDirective>;

function decide(state: FlowRunState, input: SubmitFlowInput): SubmitDecision {
  const journey = decisionsOfScope(state.flow);
  const incoherent = checkAgainstJourney(state, journey);
  if (incoherent !== null) return { ok: false, failure: incoherent };

  const resolved = resolveBoundary(state, journey);
  if (resolved.stopped === null) {
    return reject(state, resolved, "el recorrido ya terminó: no hay frontera que responder", {
      code: "FLOW_ANSWER_NOT_EXPECTED",
      action: "no queda trabajo pendiente en este recorrido",
    });
  }
  if (state.boundary === null) {
    return reject(state, resolved, "esta corrida todavía no se detuvo en ninguna frontera", {
      code: "FLOW_ANSWER_NOT_EXPECTED",
      action: "corré 'aw flow advance' primero: la frontera la emite el motor, no el llamador",
    });
  }

  // The seal the payload CLAIMS keys the lookup, not the current one: a resend of
  // an answer that was already applied quotes a boundary the run has left, and
  // looking it up under today's seal would never find it. A forged seal buys
  // nothing — matching a recorded attempt requires resending exactly what already
  // ran, and a retry applies nothing.
  const identity = attemptIdentity(state, input, claimedSeal(input.raw) ?? resolved.seal);
  // 1 · Resend, before anything else.
  const resend = resendCheck(state, resolved, identity);
  if (resend !== null) return resend;

  // The action the run is waiting on is the one that was EMITTED, and the seal
  // would already refuse a result about any other. What the persisted digest adds
  // is the diagnosis: when the two differ, the invocation changed underneath a run
  // in flight (a CLI upgraded mid-run), which is a different problem from a state
  // that moved — and it has a different answer.
  const drifted = actionDrift(state, resolved);
  if (drifted !== null) return drifted;

  // 2 · The boundary in force decides what is admissible.
  const admissible = admit(state, resolved, resolved.stopped, input);
  if ("decision" in admissible) return admissible.decision;
  const parsed = admissible;

  // 3 · Apply: the answer is the INPUT to the CLI's decision, so what advances is
  // the transition, never the sender's own verdict.
  const granted = resolved.kind === "authorization" ? (resolved.authorization?.planned ?? []) : [];
  const approved = granted.length > 0 ? withApproval(state, granted) : state;
  // An approval NEVER applies a step by itself. Two reasons it must hold, and the
  // second is the one this phase exists for: doctrine may still own the rule, or
  // the step may be delegated — and an approval that applied a delegated
  // transition would record the search, the write or the check as done because
  // someone said the effect was allowed.
  const holds =
    resolved.kind === "authorization" &&
    (resolved.stopped.ownership !== "cli-owned" || actionOf(resolved.stopped) !== null);
  return holds
    ? holdAfterApproval(approved, journey, identity)
    : applyAndAdvance(approved, journey, resolved.stopped, identity, parsed.answer);
}

/**
 * Everything that decides whether this payload may become a transition.
 *
 * Three refusals live together because they answer the same question — "is this
 * an admissible answer to the boundary in force?" — and none of them writes:
 * a payload the boundary's own contract rejects, a decline (a real answer that
 * applies nothing), and an execution result that did not earn its transition.
 */
function admit(
  state: FlowRunState,
  resolved: ResolvedBoundary,
  stopped: FlowDecision,
  input: SubmitFlowInput,
): { ok: true; answer: FlowAnswer } | { decision: SubmitDecision } {
  const expectedApproval =
    resolved.kind === "authorization"
      ? effectApprovalDigest(stopped.id, resolved.authorization?.planned ?? [])
      : null;
  const parsed = parseFlowAnswer({
    raw: input.raw,
    boundary: resolved.kind,
    decision: stopped,
    seal: resolved.seal,
    choices: resolved.choices,
    approval: input.approval,
    expectedApproval,
    declineLabel: DECLINE_LABEL,
    action: resolved.action,
  });
  if (!parsed.ok) {
    return {
      decision: reject(state, resolved, parsed.failure.message, {
        code: parsed.failure.code,
        action: parsed.failure.action,
      }),
    };
  }
  // Declining is a real answer, and it applies nothing.
  if (parsed.answer.choice === DECLINE_LABEL) {
    return {
      decision: reject(
        state,
        resolved,
        `'${DECLINE_LABEL}': el recorrido queda detenido en esta frontera`,
        {
          code: "FLOW_BOUNDARY_DECLINED",
          action: "reanudá con 'aw flow advance' cuando quieras retomar esta frontera",
          outcome: "cancelled",
        },
      ),
    };
  }
  // An execution result has to EARN the transition. Anything short of a completed
  // run with its evidence and its whole effect keeps the boundary standing: the
  // work stays pending, with the recovery the action declared.
  if (resolved.kind === "execution") {
    const verdict = executionVerdict(parsed.answer, resolved.action, effectsOf(stopped));
    if (verdict !== null) {
      return { decision: reject(state, resolved, verdict.message, verdict.detail) };
    }
  }
  return parsed;
}

/**
 * Why this execution result does not apply the transition — or `null` when it does.
 *
 * Three verdicts, and each one is the answer to a way a run could claim work that
 * never happened: an outcome that is not `completed` did not finish; evidence that
 * is missing, failed or empty means nothing came back from the tool; and an effect
 * ledger short of what the row declared means the invocation got partway. The
 * recovery the action declared travels in every one of them, because a run stopped
 * without a next step is the dead end this whole contract refuses.
 */
function executionVerdict(
  answer: FlowAnswer,
  action: DelegatedAction | null,
  declared: readonly EffectClass[],
): {
  message: string;
  detail: { code: string; action: string; outcome?: CapabilityOutcome };
} | null {
  const result = answer.result;
  if (result === null || action === null) {
    return {
      message: "la respuesta no trae el resultado de la invocación",
      detail: {
        code: "FLOW_RESULT_INVALID",
        action:
          "devolvé el resultado real de la acción: outcome, invocación, validaciones y efectos",
      },
    };
  }
  if (result.outcome !== "completed") {
    return {
      message: `la invocación devolvió '${result.outcome}': la transición sigue pendiente`,
      detail: {
        code: "FLOW_EXECUTION_NOT_COMPLETED",
        action: action.recovery,
        outcome: result.outcome,
      },
    };
  }
  const missing = action.evidence.filter((id) => {
    const found = result.validations.find((validation) => validation.id === id);
    return found === undefined || !found.passed || (found.detail ?? "").trim().length === 0;
  });
  if (missing.length > 0) {
    return {
      message: `falta la evidencia real de ${missing.join(", ")}`,
      detail: {
        code: "FLOW_EVIDENCE_MISSING",
        action: `devolvé cada validación exigida con 'passed' y su 'detail' — la salida de la herramienta, no una afirmación. ${action.recovery}`,
      },
    };
  }
  const applied = new Set(result.effects.applied);
  const partial = declared.filter((effect) => !applied.has(effect));
  if (partial.length > 0) {
    return {
      message: `la invocación declara completa pero no aplicó ${partial.join(", ")}`,
      detail: {
        code: "FLOW_EFFECT_PARTIAL",
        action: action.recovery,
        outcome: "needs_input",
      },
    };
  }
  // Completeness is not an outcome — it answers "does what came back cover what
  // was asked?" — so an attempt that FINISHED can still hand back a partial
  // output. Ignoring that here would let the run credit a search that returned
  // half its matches as if it had returned all of them.
  if (result.output?.completeness === "partial") {
    return {
      message: "la invocación terminó pero su salida declara cobertura parcial",
      detail: {
        code: "FLOW_EFFECT_PARTIAL",
        action: action.recovery,
        outcome: "needs_input",
      },
    };
  }
  return null;
}

/**
 * Whether the sealed action changed underneath a run that is standing on it.
 *
 * Only reachable when the persisted digest and the registry's current one differ —
 * i.e. the build moved while the caller was executing. Saying so beats the generic
 * staleness the seal would otherwise report, because the fix is different: nothing
 * is wrong with the state, the invocation is simply no longer the one that ran.
 */
function actionDrift(state: FlowRunState, resolved: ResolvedBoundary): SubmitDecision | null {
  const pending = state.pending_action;
  if (pending === null || resolved.action === null) return null;
  if (pending.digest === actionDigest(resolved.action)) return null;
  return reject(
    state,
    resolved,
    "la acción de esta frontera cambió después de emitirse: el resultado corresponde a otra invocación",
    {
      code: "FLOW_ACTION_CHANGED",
      action:
        "volvé a correr 'aw flow advance' para recibir la acción vigente y ejecutá esa antes de responder",
    },
  );
}

/**
 * Approving an effect is NOT deciding the step, and never executing it.
 *
 * On a transition doctrine still owns, the approval is recorded and the run stays
 * exactly where it is: the recalculated boundary is the `legacy` one for the same
 * transition, which declares its fallback before anything runs. Applying here
 * would let an approval smuggle in the very step whose rule nobody has read yet.
 *
 * On a DELEGATED transition the same hold, for the sharper reason: the approval
 * authorizes the effect and the recalculated boundary becomes the `execution` one,
 * which still has to come back with real output. "You may write this" and "this
 * was written" are different facts, and only the second one advances a run.
 */
function holdAfterApproval(
  approved: FlowRunState,
  journey: readonly FlowDecision[],
  identity: FlowRunAttempt,
): SubmitDecision {
  const held = advanceFlowRun({ state: withAttempt(approved, identity), journey, applied: [] });
  if (!held.ok) return { ok: false, failure: held.failure };
  return { ok: true, state: held.state, value: held.directive };
}

/** The answer survived: the transition applies and the run keeps advancing. */
function applyAndAdvance(
  approved: FlowRunState,
  journey: readonly FlowDecision[],
  stopped: FlowDecision,
  identity: FlowRunAttempt,
  answer: FlowAnswer,
): SubmitDecision {
  // What the agent OBSERVED outlives the boundary it was asked at: a later rule
  // reads these signals to apply its threshold. The verdict is not stored — it is
  // derived from these on each read, so the two can never disagree.
  let next =
    answer.signals.length > 0
      ? withObservation(approved, { transition: stopped.id, signals: answer.signals })
      : approved;
  next = applyTransition(next, stopped.id, effectsOf(stopped));
  next = withAttempt(next, identity);
  // The boundary follows the position, always: handing the engine a state whose
  // boundary still names the transition just applied is exactly the incoherence
  // `checkAgainstJourney` exists to refuse.
  next = withBoundary(next, journey[next.applied.length]?.id ?? null);

  const advanced = advanceFlowRun({ state: next, journey, applied: [stepOf(stopped)] });
  if (!advanced.ok) return { ok: false, failure: advanced.failure };
  return { ok: true, state: advanced.state, value: advanced.directive };
}

/**
 * Whether this submission is a resend, judged by the ledger that already knows
 * how.
 *
 * The persisted history is replayed through {@link AttemptLedger} rather than
 * counted by hand, so its sequence and parent-linkage rules apply for free — and
 * a history that cannot be replayed is itself a refusal, not something to work
 * around. `null` means "a genuinely new attempt: carry on".
 */
function resendCheck(
  state: FlowRunState,
  resolved: ResolvedBoundary,
  identity: FlowRunAttempt,
): SubmitDecision | null {
  const ledger = new AttemptLedger();
  for (const past of state.attempts) {
    const replay = ledger.record(past);
    if (!replay.ok) return { ok: false, failure: replay.failure };
  }
  const verdict = ledger.record(identity);
  if (!verdict.ok) return { ok: false, failure: verdict.failure };
  if (verdict.kind === "new") return null;
  return reject(
    state,
    resolved,
    "esta respuesta ya se había aplicado: el recorrido no avanza dos veces",
    {
      code: "FLOW_ANSWER_RESENT",
      action: "la frontera vigente es la que devuelve esta directiva; contestá esa",
      outcome: "completed",
    },
  );
}

/**
 * A rejection, expressed as the recalculated directive.
 *
 * The state handed back is the one that was read: nothing is written on this
 * path, and the caller can see that because the mutation returns `ok: false`
 * only for invocation failures — a business rejection returns the state unchanged
 * with its own outcome.
 */
function reject(
  state: FlowRunState,
  resolved: ResolvedBoundary,
  message: string,
  detail: { code: string; action: string; outcome?: CapabilityOutcome },
): SubmitDecision {
  const built = directiveFor(state, resolved, [], {
    // No outcome named ⇒ the boundary decides it: a finished journey reports
    // `completed`, an open one `needs_input`. Hardcoding one here would let a
    // rejection at the end of a run claim work is still pending.
    ...(detail.outcome === undefined ? {} : { outcome: detail.outcome }),
    nextAction: `${message} — ${detail.action}`,
  });
  if (!built.ok) return { ok: false, failure: built.failure };
  // Rewritten with the rejection's own code so the reason is machine-readable and
  // not only prose in `next_action`.
  const directive: FlowDirective = {
    ...built.directive,
    error: { code: detail.code, message, action: detail.action },
  };
  return { ok: true, state, value: directive, persist: false };
}

/**
 * The attempt this submission is, in the terms `AttemptLedger` already validates.
 *
 * `invocation_id` is the boundary's seal: stable while the run stands there, and
 * different the moment the state moves — which is exactly the identity a resend
 * has to match. Reusing the ledger instead of counting by hand is the point: its
 * sequence and parent-linkage rules come for free.
 */
function attemptIdentity(
  state: FlowRunState,
  input: SubmitFlowInput,
  seal: string,
): FlowRunAttempt {
  const digest = semanticDigest({ payload: input.raw, approval: input.approval });
  const prior = state.attempts.filter((past) => past.invocation_id === seal);
  const twin = prior.find((past) => past.request_digest === digest);
  const attempt = twin?.attempt ?? prior.length + 1;
  const parent =
    attempt === 1
      ? null
      : (prior.find((past) => past.attempt === attempt - 1)?.request_digest ?? null);
  return { invocation_id: seal, attempt, request_digest: digest, parent_request_digest: parent };
}
