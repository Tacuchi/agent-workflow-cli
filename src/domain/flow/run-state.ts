/**
 * The run's state, owned by the CLI — and the reason it can be trusted.
 *
 * A flow run stops at boundaries and is picked up later, possibly from another
 * host, with the original conversation gone. What survives that is this file:
 * which flow, which transitions were already applied, which boundary is in
 * force, what was authorized, and the attempt history that tells a resend apart
 * from a new attempt.
 *
 * It is sealed with the SAME canonicalization the rest of the system uses
 * (`canonicalJson` / `semanticDigest`) rather than a second digest criterion —
 * two digests over the same bytes is exactly how a "tampered" verdict becomes
 * unfalsifiable.
 *
 * Reading is **fail-closed** and the four verdicts are deliberately distinct: an
 * ABSENT state in an open session is a LEGACY session, not corruption, and its
 * answer is an adoption action; an unknown version, invalid JSON or a digest
 * that does not match are refusals with a repair action. None of them advances.
 *
 * The human artifacts (`SESSION.md`, `CHECKPOINT.md`, `BACKLOG.md`) are not
 * touched by any of this: they keep their headings and their role as the run's
 * readable log.
 */

import type { WorklineFlow } from "../../application/capability/compose.js";
import { WORKLINE_FLOWS } from "../../application/capability/compose.js";
import { canonicalJson, semanticDigest } from "../../application/semantic-operation/protocol.js";
import { type EffectClass, isEffectClass } from "../capability/effects.js";
import type { CapabilityFailure, EffectLedger } from "../capability/protocol.js";
import type { FlowDecision } from "./authority.js";

export const FLOW_RUN_STATE_VERSION = 3;

/** The CLI-owned run state inside the session folder. Machine-local, dotted. */
export const FLOW_RUN_STATE_FILE = ".flow-run.json";

/**
 * One attempt already seen on this run.
 *
 * Persisting the history is what lets {@link AttemptLedger} be hydrated on a
 * later invocation: without it, a resend after a crash would look like a brand
 * new attempt and the run would advance twice for one answer.
 */
export interface FlowRunAttempt {
  invocation_id: string;
  attempt: number;
  request_digest: string;
  parent_request_digest: string | null;
}

/**
 * The delegated action the run is waiting on, by its seal.
 *
 * The action itself is derived from the registry row, so copying its fields here
 * would be a second source that can disagree with the first. What IS persisted is
 * the seal of the action that was actually emitted: a CLI that changed underneath
 * a run in flight rebuilds a different action, the seals no longer match, and the
 * result is refused with that reason instead of a generic staleness.
 */
export interface FlowPendingAction {
  transition: string;
  /** Seal over program, arguments, target, input and demanded evidence. */
  digest: string;
}

/**
 * What the agent OBSERVED at a semantic boundary, kept for the rule that reads it
 * later.
 *
 * Only the declared signals — never the verdict they produce. A threshold is
 * derived from these on each read, so there is one source: persisting the verdict
 * too would let the two drift and make "why did the gate fire?" unanswerable.
 */
export interface FlowObservation {
  transition: string;
  signals: string[];
}

export interface FlowRunState {
  version: number;
  flow: WorklineFlow;
  /** Session folder that owns the run (`NNN-<slug>-<flow>`). */
  session: string;
  /**
   * Transition ids the run has already passed, in order — the journey's CURSOR.
   *
   * A member of {@link skipped} was passed WITHOUT being applied. Keeping both in
   * one list is what makes the cursor a length instead of a search, and splitting
   * them into two cursors is how a conditional step would silently desynchronize
   * the run from its journey.
   */
  applied: string[];
  /**
   * Ids the run passed over because their condition did not hold.
   *
   * Always a subset of {@link applied}: a conditional step that never happened is
   * still accounted for, and the difference between "decided" and "did not apply"
   * stays readable after the fact instead of being lost in a cursor.
   */
  skipped: string[];
  /** The transition the run is standing on, or null when nothing is pending. */
  boundary: string | null;
  /** The delegated action awaiting its result, or null when none is pending. */
  pending_action: FlowPendingAction | null;
  /** Validated observations a later rule consumes. */
  observations: FlowObservation[];
  /** Effect classes this run already has authorization for. */
  authorizations: EffectClass[];
  /** Effects across their three moments, so a partial effect is expressible. */
  effects: EffectLedger;
  attempts: FlowRunAttempt[];
  /** Seal over every field above. */
  digest: string;
}

export type FlowRunRead =
  | { ok: true; state: FlowRunState }
  | { ok: false; failure: CapabilityFailure };

/** The state minus its own seal — exactly what {@link sealRunState} digests. */
function withoutSeal(state: FlowRunState): Omit<FlowRunState, "digest"> {
  const { digest: _seal, ...rest } = state;
  return rest;
}

export function sealRunState(state: Omit<FlowRunState, "digest">): FlowRunState {
  return { ...state, digest: semanticDigest(state) };
}

export function newRunState(flow: WorklineFlow, session: string): FlowRunState {
  return sealRunState({
    version: FLOW_RUN_STATE_VERSION,
    flow,
    session,
    applied: [],
    skipped: [],
    boundary: null,
    pending_action: null,
    observations: [],
    authorizations: [],
    effects: { planned: [], approved: [], applied: [] },
    attempts: [],
  });
}

/**
 * Apply one transition, re-sealing the result.
 *
 * Pure on purpose: the atomic write is the service's job, and keeping the state
 * transition free of I/O is what makes "a failure halfway through leaves no
 * intermediate state applied" checkable — the next state either exists whole or
 * was never produced.
 */
export function applyTransition(
  state: FlowRunState,
  decisionId: string,
  effects: readonly EffectClass[] = [],
): FlowRunState {
  return sealRunState({
    ...withoutSeal(state),
    applied: [...state.applied, decisionId],
    // planned before applied, always: an effect that shows up as applied without
    // ever having been planned is the lie `buildReceipt` refuses, and the
    // directive refuses it too.
    effects: {
      planned: union(state.effects.planned, effects),
      approved: [...state.effects.approved],
      applied: union(state.effects.applied, effects),
    },
  });
}

/**
 * Pass over a conditional transition without applying it.
 *
 * The cursor advances — the journey is a sequence and the run has to leave the
 * step behind — but nothing else moves: no effect is planned, none is applied,
 * and the id lands in `skipped` so the trace can say the step was omitted rather
 * than decided. A skip that only advanced the cursor would be indistinguishable
 * from having applied it, which is the exact lie a conditional step invites.
 */
export function skipTransition(state: FlowRunState, decisionId: string): FlowRunState {
  return sealRunState({
    ...withoutSeal(state),
    applied: [...state.applied, decisionId],
    skipped: [...state.skipped, decisionId],
  });
}

/** Move the boundary to where the walk stopped, applying nothing. */
export function withBoundary(state: FlowRunState, boundary: string | null): FlowRunState {
  return sealRunState({ ...withoutSeal(state), boundary });
}

/**
 * Record — or clear — the delegated action the run is waiting on.
 *
 * Clearing is as load-bearing as setting: a run that moved past an execution
 * boundary and kept the old pending action would tell whoever resumes it to run
 * something the engine no longer expects.
 */
export function withPendingAction(
  state: FlowRunState,
  pending: FlowPendingAction | null,
): FlowRunState {
  return sealRunState({ ...withoutSeal(state), pending_action: pending });
}

/** Keep a validated observation for the rule that consumes it later. */
export function withObservation(state: FlowRunState, observation: FlowObservation): FlowRunState {
  return sealRunState({
    ...withoutSeal(state),
    observations: [
      ...state.observations.filter((past) => past.transition !== observation.transition),
      observation,
    ],
  });
}

/** Record one attempt in the persisted history, re-sealing the result. */
export function withAttempt(state: FlowRunState, attempt: FlowRunAttempt): FlowRunState {
  return sealRunState({ ...withoutSeal(state), attempts: [...state.attempts, attempt] });
}

/**
 * Grant the run an authorization the person just gave.
 *
 * The classes land in BOTH `authorizations` — what the run may exercise from here
 * on — and `effects.approved` — the ledger moment. The two are the same split the
 * capability contract already makes between the request's authorizations and the
 * receipt's approved effects, and the directive enforces `approved ⊆ authorizations`.
 */
export function withApproval(state: FlowRunState, effects: readonly EffectClass[]): FlowRunState {
  return sealRunState({
    ...withoutSeal(state),
    authorizations: union(state.authorizations, effects),
    effects: {
      planned: union(state.effects.planned, effects),
      approved: union(state.effects.approved, effects),
      applied: [...state.effects.applied],
    },
  });
}

function union(current: readonly EffectClass[], added: readonly EffectClass[]): EffectClass[] {
  return [...new Set([...current, ...added])];
}

/**
 * Parse a persisted state, refusing anything that cannot be trusted.
 *
 * Order matters: shape before version before seal. A file whose version is
 * unknown must not be judged by a digest rule that version may not even use.
 */
export function parseRunState(raw: string): FlowRunRead {
  if (raw.trim().length === 0) {
    return refuse(
      "FLOW_RUN_INVALID",
      "el estado de corrida está vacío",
      "reconstruí la corrida con 'aw flow advance --adopt', o restaurá el archivo",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse(
      "FLOW_RUN_INVALID",
      "el estado de corrida no es JSON válido",
      "no se avanza sobre un estado ilegible: restauralo o re-adoptá la sesión con 'aw flow advance --adopt'",
    );
  }
  if (!isRecord(parsed)) {
    return refuse(
      "FLOW_RUN_INVALID",
      "el estado de corrida no es un objeto JSON",
      "restauralo o re-adoptá la sesión con 'aw flow advance --adopt'",
    );
  }
  if (parsed.version !== FLOW_RUN_STATE_VERSION) {
    // No silent migration, in either direction: an older state predates fields
    // the engine now reads, and inventing them would fabricate the very history
    // this file exists to make trustworthy. Re-adoption is explicit and cheap.
    return refuse(
      "FLOW_RUN_VERSION_UNSUPPORTED",
      `versión de estado de corrida no soportada: ${String(parsed.version)}`,
      `esta versión del CLI lee la ${FLOW_RUN_STATE_VERSION}: actualizá el CLI, o re-adoptá la sesión con 'aw flow advance --flow <flow> --adopt' (no hay migración automática)`,
    );
  }
  const shape = checkShape(parsed);
  if (shape !== null) return { ok: false, failure: shape };

  const state = parsed as unknown as FlowRunState;
  if (semanticDigest(withoutSeal(state)) !== state.digest) {
    return refuse(
      "FLOW_RUN_TAMPERED",
      "el estado de corrida no coincide con su propio sello",
      "fue editado fuera del CLI: descartá el archivo y re-adoptá la sesión con 'aw flow advance --adopt'",
    );
  }
  return { ok: true, state };
}

export function serializeRunState(state: FlowRunState): string {
  return `${canonicalJson(state)}\n`;
}

/**
 * Whether the persisted state is coherent with the journey it claims to walk.
 *
 * A state can be well-formed and sealed and still be AHEAD of the journey — it
 * names transitions this build does not know, or in an order the journey does
 * not have. Advancing over it would apply transitions on top of a history
 * nobody can reproduce, so it is refused with the same fail-closed rule.
 */
export function checkAgainstJourney(
  state: FlowRunState,
  journey: readonly FlowDecision[],
): CapabilityFailure | null {
  const ids = journey.map((decision) => decision.id);
  for (const [index, applied] of state.applied.entries()) {
    if (ids[index] === applied) continue;
    return {
      code: "FLOW_RUN_AHEAD_OF_JOURNEY",
      message: `el estado dice haber aplicado '${applied}' donde el recorrido tiene '${ids[index] ?? "(nada)"}'`,
      action:
        "el estado no corresponde a este recorrido: revisá el flow de la corrida o re-adoptá la sesión",
    };
  }
  const next = ids[state.applied.length] ?? null;
  if (state.boundary !== null && state.boundary !== next) {
    return {
      code: "FLOW_RUN_AHEAD_OF_JOURNEY",
      message: `la frontera vigente dice '${state.boundary}' y el recorrido sigue en '${next ?? "(nada)"}'`,
      action:
        "recalculá la frontera avanzando de nuevo; no se responde sobre una frontera que el estado no sostiene",
    };
  }
  return null;
}

function checkShape(parsed: Record<string, unknown>): CapabilityFailure | null {
  const invalid = (why: string): CapabilityFailure => ({
    code: "FLOW_RUN_INVALID",
    message: `el estado de corrida ${why}`,
    action: "restauralo o re-adoptá la sesión con 'aw flow advance --adopt'",
  });

  if (!(WORKLINE_FLOWS as readonly unknown[]).includes(parsed.flow)) {
    return invalid(`declara un flow desconocido: ${String(parsed.flow)}`);
  }
  if (typeof parsed.session !== "string" || parsed.session.trim().length === 0) {
    return invalid("no dice a qué sesión pertenece");
  }
  const applied = parsed.applied;
  if (!isStringArray(applied)) return invalid("no trae la lista de transiciones aplicadas");
  if (!isStringArray(parsed.skipped)) return invalid("no trae la lista de transiciones omitidas");
  if (parsed.skipped.some((id) => !applied.includes(id))) {
    return invalid("declara una transición omitida que el recorrido nunca pasó");
  }
  if (parsed.boundary !== null && typeof parsed.boundary !== "string") {
    return invalid("declara una frontera que no es un identificador");
  }
  if (!isPendingAction(parsed.pending_action)) {
    return invalid("declara una acción pendiente sin transición o sin sello");
  }
  if (!isObservationArray(parsed.observations)) {
    return invalid("trae observaciones que no son señales declaradas por transición");
  }
  if (!isEffectClassArray(parsed.authorizations)) {
    return invalid("declara autorizaciones que no son clases de efecto");
  }
  if (!isEffectLedger(parsed.effects)) return invalid("no trae el registro de efectos completo");
  if (!isAttemptArray(parsed.attempts)) return invalid("trae un historial de intentos inválido");
  if (typeof parsed.digest !== "string") return invalid("no trae su sello");
  return null;
}

function refuse(code: string, message: string, action: string): FlowRunRead {
  return { ok: false, failure: { code, message, action } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isEffectClassArray(value: unknown): value is EffectClass[] {
  return Array.isArray(value) && value.every(isEffectClass);
}

function isEffectLedger(value: unknown): value is EffectLedger {
  if (!isRecord(value)) return false;
  return (
    isEffectClassArray(value.planned) &&
    isEffectClassArray(value.approved) &&
    isEffectClassArray(value.applied)
  );
}

function isPendingAction(value: unknown): value is FlowPendingAction | null {
  if (value === null) return true;
  return (
    isRecord(value) && typeof value.transition === "string" && typeof value.digest === "string"
  );
}

function isObservationArray(value: unknown): value is FlowObservation[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      isRecord(entry) && typeof entry.transition === "string" && isStringArray(entry.signals),
  );
}

function isAttemptArray(value: unknown): value is FlowRunAttempt[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.invocation_id === "string" &&
      Number.isInteger(entry.attempt) &&
      typeof entry.request_digest === "string" &&
      (entry.parent_request_digest === null || typeof entry.parent_request_digest === "string"),
  );
}
