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

export const FLOW_RUN_STATE_VERSION = 1;

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

export interface FlowRunState {
  version: number;
  flow: WorklineFlow;
  /** Session folder that owns the run (`NNN-<slug>-<flow>`). */
  session: string;
  /** Transition ids already applied, in the order they were applied. */
  applied: string[];
  /** The transition the run is standing on, or null when nothing is pending. */
  boundary: string | null;
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
    boundary: null,
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
export function applyTransition(state: FlowRunState, decisionId: string): FlowRunState {
  return sealRunState({ ...withoutSeal(state), applied: [...state.applied, decisionId] });
}

/** Move the boundary to where the walk stopped, applying nothing. */
export function withBoundary(state: FlowRunState, boundary: string | null): FlowRunState {
  return sealRunState({ ...withoutSeal(state), boundary });
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
    return refuse(
      "FLOW_RUN_VERSION_UNSUPPORTED",
      `versión de estado de corrida no soportada: ${String(parsed.version)}`,
      `esta versión del CLI lee la ${FLOW_RUN_STATE_VERSION}: actualizá el CLI o re-adoptá la sesión`,
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
  if (!isStringArray(parsed.applied)) return invalid("no trae la lista de transiciones aplicadas");
  if (parsed.boundary !== null && typeof parsed.boundary !== "string") {
    return invalid("declara una frontera que no es un identificador");
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
