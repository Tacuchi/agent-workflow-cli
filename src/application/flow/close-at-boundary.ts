/**
 * Closing a session whose run is still walking: the run ends in a `finalize`
 * placed at the boundary it stood on (052 AC-13).
 *
 * Three steps, each its own call, because the driver never holds the run's lock
 * across an operation: record the intention under the run lock, close the session
 * without it, then settle the applied `finalize` under the lock again. A close
 * that cannot happen takes the intention back, so a refusal leaves nothing half
 * done.
 */

import type { CapabilityFailure } from "../../domain/capability/protocol.js";
import { occurrenceAt } from "../../domain/flow/authority.js";
import {
  type FlowRunState,
  applyTransition,
  iterationOf,
  withBoundary,
  withEvent,
  withPendingAction,
  withReentry,
  withoutLastReentry,
} from "../../domain/flow/run-state.js";
import type { FileSystemPort } from "../../ports/file-system.js";
import { semanticDigest } from "../semantic-operation/protocol.js";
import type { SessionCloseOutput } from "../session-close-service.js";
import { effectsOfTransition } from "./advance.js";
import { journeyForRun } from "./run-journey.js";
import { type FlowRunLocation, applyUnderLock, readRun } from "./run-state-service.js";

const FINALIZE = "chassis.finalize";
const EVIDENCE = "chassis.sesion-cerrada";

/** Unreachable while `allowAbsent` is off: the lock refuses a missing run first. */
const ABSENT: CapabilityFailure = {
  code: "FLOW_RUN_ABSENT",
  message: "la sesión no tiene corrida",
  action: "no hay corrida que cerrar en frontera",
};

/**
 * What the intention step found: a run to close at `boundary`, or nothing to do.
 * `wrote` says whether THIS call recorded the intention: only that one may be
 * taken back, never one a previous, interrupted close left.
 */
export type CloseIntent =
  | { kind: "none" }
  | { kind: "marked"; boundary: string; wrote: boolean }
  | { kind: "failed"; failure: CapabilityFailure };

/** Whether the run stands on a `finalize` — the one a close placed, or its own. */
function standingOnFinalize(state: FlowRunState): boolean {
  return journeyForRun(state)[state.applied.length]?.id === FINALIZE;
}

/** Whether the run stands on the `finalize` a close intention placed. */
function standingOnClose(state: FlowRunState): boolean {
  return state.reentries?.at(-1)?.kind === "close" && standingOnFinalize(state);
}

/** A finished journey or a live handoff: there is nothing left to close at. */
function finished(state: FlowRunState): boolean {
  const handedOff = state.handoff !== null && state.handoff !== undefined;
  return handedOff || journeyForRun(state)[state.applied.length] === undefined;
}

/**
 * Step 1: record, under the run lock, the intention to close at the boundary in
 * force. A run that is finished, handed off or absent is left alone — read first,
 * without the lock, so a legacy registry that is already over closes as before.
 * One standing on a `finalize` (its own, or a close's after a failed attempt)
 * needs no intention: settling applies that very row, so re-running the close is
 * the retry.
 */
export async function markCloseAtBoundary(
  fs: FileSystemPort,
  location: FlowRunLocation,
): Promise<CloseIntent> {
  const read = await readRun(fs, location);
  if (!read.ok) {
    return read.failure.code === ABSENT.code
      ? { kind: "none" }
      : { kind: "failed", failure: read.failure };
  }
  if (finished(read.state)) return { kind: "none" };
  const marked = await applyUnderLock<CloseIntent>(fs, location, (state) => {
    if (state === null) return { ok: false, failure: ABSENT };
    if (finished(state)) return { ok: true, state, value: { kind: "none" }, persist: false };
    if (standingOnFinalize(state)) {
      const boundary = standingOnClose(state) ? closedAt(state) : FINALIZE;
      return { ok: true, state, value: { kind: "marked", boundary, wrote: false }, persist: false };
    }
    const journey = journeyForRun(state);
    const position = state.applied.length;
    const boundary = journey[position]?.id ?? FINALIZE;
    const closing = withBoundary(
      withReentry(state, {
        kind: "close",
        transition: boundary,
        occurrence: occurrenceAt(journey, position),
        from: null,
      }),
      FINALIZE,
    );
    // A close this journey cannot place would report a finalize nobody applied.
    if (!standingOnClose(closing)) {
      return { ok: false, failure: unplaceable(boundary, location.session) };
    }
    return { ok: true, state: closing, value: { kind: "marked", boundary, wrote: true } };
  });
  if (marked.ok) return marked.value;
  // The run vanished between the read and the lock: there is nothing to close.
  if (marked.failure.code === ABSENT.code) return { kind: "none" };
  return { kind: "failed", failure: marked.failure };
}

function closedAt(state: FlowRunState): string {
  return state.reentries?.at(-1)?.transition ?? FINALIZE;
}

function unplaceable(boundary: string, session: string): CapabilityFailure {
  return {
    code: "FLOW_CLOSE_UNPLACEABLE",
    message: `el recorrido de la corrida no puede terminar en '${boundary}'`,
    action: `avanzá la corrida con 'aw flow advance --session ${session}' y volvé a cerrar`,
  };
}

/** Undo step 1 when the close itself did not happen; a no-op once anything moved. */
export async function withdrawCloseAtBoundary(
  fs: FileSystemPort,
  location: FlowRunLocation,
): Promise<CapabilityFailure | null> {
  const withdrawn = await applyUnderLock<null>(fs, location, (state) => {
    if (state === null) return { ok: false, failure: ABSENT };
    if (!standingOnClose(state)) return { ok: true, state, value: null, persist: false };
    const restored = withoutLastReentry(state);
    const boundary = journeyForRun(restored)[restored.applied.length]?.id ?? null;
    return { ok: true, state: withBoundary(restored, boundary), value: null };
  });
  return withdrawn.ok ? null : withdrawn.failure;
}

/**
 * Step 3: settle the `finalize` the close just performed, under the run lock.
 * It records what the close really did — the same material trace an internal
 * `session.close` leaves — and ends the run's journey there. Already settled (a
 * concurrent advance applied it) is fine; not standing on a finalize is not.
 */
export async function settleCloseAtBoundary(
  fs: FileSystemPort,
  location: FlowRunLocation,
  closed: SessionCloseOutput,
): Promise<CapabilityFailure | null> {
  const settled = await applyUnderLock<null>(fs, location, (state) => {
    if (state === null) return { ok: false, failure: ABSENT };
    const row = journeyForRun(state)[state.applied.length];
    if (row?.id !== FINALIZE) {
      if (state.applied.at(-1) === FINALIZE) {
        return { ok: true, state, value: null, persist: false };
      }
      return { ok: false, failure: unplaceable(closedAt(state), location.session) };
    }
    const traced = withEvent(withPendingAction(state, null), {
      kind: "executed",
      transition: FINALIZE,
      ...iterationOf(state, FINALIZE),
      operation: "session.close",
      summary: `sesión ${closed.folder} cerrada en la frontera '${closedAt(state)}'`,
      output_digest: semanticDigest({ output: closed }),
      // What the close really did; the transition applies the row's own effects,
      // the same ones whichever path closes it.
      effects: ["local_additive", "mutate_overwrite"],
      evidence: [EVIDENCE],
    });
    const applied = applyTransition(traced, FINALIZE, effectsOfTransition(state, row));
    const next = journeyForRun(applied)[applied.applied.length]?.id ?? null;
    return { ok: true, state: withBoundary(applied, next), value: null };
  });
  return settled.ok ? null : settled.failure;
}
