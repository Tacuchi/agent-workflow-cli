/**
 * Reopening a closed session reopens its run too (052 AC-11): the journey gains
 * the stretch the run has to walk again, and `aw flow advance` resumes there.
 *
 * - A run closed at a boundary (see close-at-boundary) resumes at that boundary:
 *   the rows the close cut come back after its `finalize`.
 * - A run that finished resumes at its last human boundary, walked again as a
 *   copy from there to the end.
 * - A run whose close was never settled takes that close back and resumes at the
 *   boundary it stood on.
 * - Anything else — no run, a run still walking, a handoff — is left alone. A
 *   finished run with nowhere to resume says so instead of staying finished.
 */

import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import { type FlowDecision, occurrenceAt } from "../../domain/flow/authority.js";
import {
  type FlowRunReentry,
  type FlowRunState,
  PLAN_EXEC_BATCH_LOOP_TRANSITIONS,
  type RowIteration,
  restartInvocation,
  sameIteration,
  withBoundary,
  withReentry,
  withoutLastReentry,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { expandedJourneyForRun, journeyForRun } from "./run-journey.js";
import { type FlowRunLocation, applyUnderLock, readRun } from "./run-state-service.js";

const FINALIZE = "chassis.finalize";

/** Unreachable while `allowAbsent` is off: the lock refuses a missing run first. */
const ABSENT: CapabilityFailure = {
  code: "FLOW_RUN_ABSENT",
  message: "la sesión no tiene corrida",
  action: "no hay corrida que reabrir",
};

/** Where the reopened run resumes, `null` when there was nothing to reopen. */
export type RunReopen =
  | { ok: true; resumes_at: string | null }
  | { ok: false; failure: CapabilityFailure };

/** Record the reopen under the run lock. The caller holds no other lock. */
export async function reopenRun(fs: FileSystemPort, location: FlowRunLocation): Promise<RunReopen> {
  // Read first, without the lock: a run with nothing to reopen — absent, still
  // walking, handed off — reopens as before, even when this build cannot write it.
  const read = await readRun(fs, location);
  if (!read.ok) {
    return read.failure.code === ABSENT.code
      ? { ok: true, resumes_at: null }
      : { ok: false, failure: read.failure };
  }
  if (!owesReopen(read.state)) return { ok: true, resumes_at: null };
  const reopened = await applyUnderLock<string | null>(fs, location, (state) => {
    if (state === null) return { ok: false, failure: ABSENT };
    if (!owesReopen(state)) return { ok: true, state, value: null, persist: false };
    const next = reopenedState(state);
    if ("failure" in next) return { ok: false, failure: next.failure };
    const resumes = journeyForRun(next.state)[next.state.applied.length]?.id ?? null;
    // A reopen this journey cannot place would leave the run finished in silence.
    if (resumes === null) return { ok: false, failure: unplaceable(location.session) };
    return { ok: true, state: withBoundary(next.state, resumes), value: resumes };
  });
  if (reopened.ok) return { ok: true, resumes_at: reopened.value };
  // The run vanished between the read and the lock: there is nothing to reopen.
  if (reopened.failure.code === ABSENT.code) return { ok: true, resumes_at: null };
  return { ok: false, failure: reopened.failure };
}

/** A finished run, or one still standing on the `finalize` of a close never settled. */
function owesReopen(state: FlowRunState): boolean {
  const handedOff = state.handoff !== null && state.handoff !== undefined;
  return !handedOff && (finished(state) || unsettledClose(state));
}

function finished(state: FlowRunState): boolean {
  return state.applied.length >= journeyForRun(state).length;
}

/**
 * The session closed but the run never settled the close's `finalize` (a crash,
 * or a refused settle): the close did not happen for the run, so it is taken
 * back and the run resumes at the boundary it stood on.
 */
function unsettledClose(state: FlowRunState): boolean {
  return (
    state.reentries?.at(-1)?.kind === "close" &&
    journeyForRun(state)[state.applied.length]?.id === FINALIZE
  );
}

function reopenedState(
  state: FlowRunState,
): { state: FlowRunState } | { failure: CapabilityFailure } {
  if (unsettledClose(state)) return { state: withoutLastReentry(state) };
  const reentry = reopenOf(state);
  return "failure" in reentry ? reentry : { state: withReentry(state, reentry.reentry) };
}

function unplaceable(session: string): CapabilityFailure {
  return {
    code: "FLOW_REOPEN_UNPLACEABLE",
    message: "el recorrido instalado no tiene dónde retomar esta corrida",
    action: `corré '${restartInvocation(session)}' para empezarla de nuevo`,
  };
}

/** The reopen a finished run is owed: from its close, or from its last human row. */
function reopenOf(
  state: FlowRunState,
): { reentry: FlowRunReentry } | { failure: CapabilityFailure } {
  const last = state.reentries?.at(-1);
  if (last?.kind === "close" && state.applied.at(-1) === FINALIZE) {
    const { transition, occurrence } = last;
    return { reentry: { kind: "reopen", transition, occurrence, from: transition } };
  }
  const { rows } = expandedJourneyForRun(state);
  const human = lastHumanApplied(state);
  const row = human === null ? undefined : rows[human];
  if (human === null || row === undefined) {
    return {
      failure: {
        code: "FLOW_REOPEN_NO_HUMAN",
        message: "la corrida terminó sin ninguna frontera humana aplicada: no hay dónde retomarla",
        action: `corré '${restartInvocation(state.session)}' para empezarla de nuevo`,
      },
    };
  }
  const occurrence = occurrenceAt(rows, human);
  return { reentry: { kind: "reopen", transition: row.id, occurrence, from: row.id } };
}

/**
 * Index of the last human row the run really answered, or `null`.
 *
 * The rule is by id — applied, not in `skipped`, not degraded — and the attempt
 * ledger only tells copies apart: `skipped` names ids, not walks, while every
 * answered boundary left an attempt carrying the identity of its walk. When no
 * attempt matches at all (an older ledger), the id rule decides alone.
 */
function lastHumanApplied(state: FlowRunState): number | null {
  const { rows, copies } = expandedJourneyForRun(state);
  const degraded = new Set((state.degraded ?? []).map((entry) => entry.transition));
  const human = (index: number) => {
    const row = rows[index];
    return row !== undefined && row.authority === "human" && !degraded.has(row.id);
  };
  let byId: number | null = null;
  for (let index = state.applied.length - 1; index >= 0; index -= 1) {
    if (!human(index)) continue;
    const id = rows[index]?.id ?? "";
    const identity = identityAt(state, rows, copies, index);
    if (state.attempts.some((a) => a.transition === id && sameIteration(a, identity))) return index;
    if (byId === null && !state.skipped.includes(id)) byId = index;
  }
  return byId;
}

/** The iteration a walk of the row at `index` recorded its attempts under. */
function identityAt(
  state: FlowRunState,
  rows: readonly FlowDecision[],
  copies: readonly number[],
  index: number,
): RowIteration {
  const row = rows[index];
  const copy = copies[index] ?? 0;
  // A reopen copy is walked after the batch loop closed, so its rows record no batch.
  const batched =
    copy === 0 && state.flow === "plan-exec" && PLAN_EXEC_BATCH_LOOP_TRANSITIONS.has(row?.id ?? "");
  const segment = rows
    .slice(0, index + 1)
    .filter((decision) => decision.id === "plan-exec.batch-eligibility-signal").length;
  return {
    ...(batched && segment > 0 ? { batch_iteration: segment } : {}),
    ...(copy === 0 ? {} : { reentry_iteration: copy }),
  };
}
