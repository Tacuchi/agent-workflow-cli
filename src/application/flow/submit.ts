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
 *    does the run keep advancing until the next boundary.
 *
 * Every rejection travels with `ok: true` inside the RECALCULATED directive,
 * carrying its code, message and action — with `ok: false` the host never calls
 * `renderHuman`, and a boundary nobody can see is a boundary that did not happen.
 */

import { AttemptLedger } from "../../domain/capability/protocol.js";
import type { CapabilityFailure, CapabilityOutcome } from "../../domain/capability/protocol.js";
import { claimedSeal, parseFlowAnswer } from "../../domain/flow/answer.js";
import { decisionsOfScope, effectsOf } from "../../domain/flow/authority.js";
import { effectApprovalDigest } from "../../domain/flow/authorization.js";
import type { FlowDirective } from "../../domain/flow/directive.js";
import {
  type FlowRunAttempt,
  type FlowRunState,
  applyTransition,
  checkAgainstJourney,
  withApproval,
  withAttempt,
  withBoundary,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import type { PathsService } from "../paths-service.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import { type SessionResolutionError, resolveSessionTarget } from "../session-resolver.js";
import { type ResolvedBoundary, advanceFlowRun, directiveFor, resolveBoundary } from "./advance.js";
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

  // 2 · The boundary in force decides what is admissible.
  const expectedApproval =
    resolved.kind === "authorization"
      ? effectApprovalDigest(resolved.stopped.id, resolved.authorization?.planned ?? [])
      : null;
  const parsed = parseFlowAnswer({
    raw: input.raw,
    boundary: resolved.kind,
    decision: resolved.stopped,
    seal: resolved.seal,
    choices: resolved.choices,
    approval: input.approval,
    expectedApproval,
    declineLabel: DECLINE_LABEL,
  });
  if (!parsed.ok) {
    return reject(state, resolved, parsed.failure.message, {
      code: parsed.failure.code,
      action: parsed.failure.action,
    });
  }

  // Declining is a real answer, and it applies nothing.
  if (parsed.answer.choice === DECLINE_LABEL) {
    return reject(
      state,
      resolved,
      `'${DECLINE_LABEL}': el recorrido queda detenido en esta frontera`,
      {
        code: "FLOW_BOUNDARY_DECLINED",
        action: "reanudá con 'aw flow advance' cuando quieras retomar esta frontera",
        outcome: "cancelled",
      },
    );
  }

  // 3 · Apply: the answer is the INPUT to the CLI's decision, so what advances is
  // the transition, never the sender's own verdict.
  const granted = resolved.kind === "authorization" ? (resolved.authorization?.planned ?? []) : [];
  let next = granted.length > 0 ? withApproval(state, granted) : state;
  next = applyTransition(next, resolved.stopped.id, effectsOf(resolved.stopped));
  next = withAttempt(next, identity);
  // The boundary follows the position, always: handing the engine a state whose
  // boundary still names the transition just applied is exactly the incoherence
  // `checkAgainstJourney` exists to refuse.
  next = withBoundary(next, journey[next.applied.length]?.id ?? null);

  const advanced = advanceFlowRun({
    state: next,
    journey,
    applied: [resolved.stopped.id],
  });
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
