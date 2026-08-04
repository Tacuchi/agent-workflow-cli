/**
 * The boundary, described so that nobody has to guess what to do next.
 *
 * This is NOT a third protocol family. Outcome, `next_action`, the effect ledger
 * and degradations are the capability receipt's vocabulary, reused by name and by
 * type; a semantic boundary carries the existing `SemanticRequest` whole, with
 * its contract, its limits, its allowed destinations and its own `input_digest`.
 * What is genuinely new here is one field — `state_digest`, the seal of the
 * BOUNDARY (the run state plus the transition it stands on). There is exactly one
 * such seal per boundary and an answer quotes it back verbatim; a semantic
 * boundary also carries it inside its request's own `input_digest`, because the
 * protocol demands it there. One seal, carried where each contract needs it —
 * two would mean two staleness questions and a caller guessing which to answer.
 *
 * `buildFlowDirective` refuses the combinations that would let a run lie: a
 * boundary with no next action, a finalization with work still pending, allowed
 * effects nobody authorized, a block with no cause, a semantic boundary that
 * asks for nothing, a human boundary with nothing to choose between. Same
 * discipline as `buildReceipt`, for the same reason: the shape is the only thing
 * that cannot be forgotten.
 *
 * Directive and business-level rejections travel with `ok: true` plus their
 * outcome; `ok: false` is reserved for invocation failures — exactly how
 * `capability` splits them, because with `ok: false` the host never calls
 * `renderHuman` and a recalculated boundary would be invisible to the person.
 */

import type { WorklineFlow } from "../../application/capability/compose.js";
import type { SemanticRequest } from "../../application/semantic-operation/protocol.js";
import type { EffectClass } from "../capability/effects.js";
import type {
  CapabilityFailure,
  CapabilityOutcome,
  Degradation,
  EffectLedger,
} from "../capability/protocol.js";
import {
  type FlowAuthority,
  type FlowTranche,
  type TransitionOwnership,
  trancheOfFlow,
} from "./authority.js";

export const FLOW_DIRECTIVE_VERSION = 1;

/**
 * The five reasons a deterministic advance stops. They are the spec's own list,
 * and collapsing any two would erase the difference between "I need a judgment",
 * "I need a preference", "I need an approval", "I am stuck" and "there is nothing
 * left" — five situations whose next action has nothing in common.
 */
export const FLOW_BOUNDARY_KINDS = [
  "semantic",
  "human",
  "authorization",
  "blocked",
  "final",
] as const;

export type FlowBoundaryKind = (typeof FLOW_BOUNDARY_KINDS)[number];

/** One alternative of a human boundary: what it is, and what it costs. */
export interface FlowChoice {
  label: string;
  /** What choosing it produces. A choice without a consequence is not a choice. */
  consequence: string;
  recommended: boolean;
}

export interface FlowBoundary {
  kind: FlowBoundaryKind;
  /** The transition standing at the boundary; null only when the run is final. */
  transition: string | null;
  authority: FlowAuthority | null;
  /** Whether this transition is already CLI-owned or still decided by doctrine. */
  ownership: TransitionOwnership | null;
  title: string | null;
}

export interface FlowDirective {
  version: number;
  flow: WorklineFlow;
  tranche: FlowTranche;
  session: string;
  boundary: FlowBoundary;
  outcome: CapabilityOutcome;
  /**
   * Seal of this boundary — the run state plus the transition it stands on.
   *
   * The staleness key for EVERY boundary kind, not only the semantic ones: an
   * answer quotes it back in its `input_digest`, and it changes the moment either
   * the state or the boundary moves.
   */
  state_digest: string;
  /** Transitions applied in THIS invocation, in order. */
  applied: string[];
  /** Transition ids still ahead, so a finalization cannot hide pending work. */
  pending: string[];
  /** Present exactly at a semantic boundary. */
  request: SemanticRequest | null;
  /** Non-empty exactly at a human or authorization boundary. */
  choices: FlowChoice[];
  effects: EffectLedger;
  /** Effect classes this run is allowed to exercise. */
  authorizations: EffectClass[];
  degradations: Degradation[];
  error: CapabilityFailure | null;
  /** Never empty. A directive with no next action is a dead end. */
  next_action: string;
}

/**
 * The directive's closed key set.
 *
 * Exported so a guard can assert, at runtime, that no field parallel to one the
 * semantic protocol or the capability receipt already delivers ever appears
 * here. A type would not survive compilation to be checked.
 */
export const FLOW_DIRECTIVE_KEYS = [
  "version",
  "flow",
  "tranche",
  "session",
  "boundary",
  "outcome",
  "state_digest",
  "applied",
  "pending",
  "request",
  "choices",
  "effects",
  "authorizations",
  "degradations",
  "error",
  "next_action",
] as const;

/**
 * Keys the directive shares with the receipt ON PURPOSE, each because it is the
 * SAME concept with the SAME type — reuse, not a parallel field. The guard reads
 * this list, so adding a name here is an explicit decision, never a slip.
 */
export const FLOW_DIRECTIVE_REUSED_KEYS: Readonly<Record<string, string>> = {
  outcome: "el vocabulario de outcome del receipt de capacidad, sin ampliarlo",
  effects: "el EffectLedger del receipt en sus tres momentos",
  degradations: "la Degradation del receipt, con su causa declarada",
  error: "el CapabilityFailure del receipt: código, mensaje y acción",
  next_action: "la próxima acción válida del receipt, que nunca queda vacía",
  version: "el versionado del protocolo semántico, con el mismo nombre",
  authorizations:
    "las clases de efecto autorizadas del request de capacidad, con el mismo nombre y tipo",
};

export interface BuildDirectiveInput {
  flow: WorklineFlow;
  session: string;
  boundary: FlowBoundary;
  outcome: CapabilityOutcome;
  stateDigest: string;
  applied: readonly string[];
  pending: readonly string[];
  request?: SemanticRequest | null;
  choices?: readonly FlowChoice[];
  effects?: Partial<EffectLedger>;
  authorizations?: readonly EffectClass[];
  degradations?: readonly Degradation[];
  error?: CapabilityFailure | null;
  nextAction: string;
}

export type DirectiveBuild =
  | { ok: true; directive: FlowDirective }
  | { ok: false; failure: CapabilityFailure };

export function buildFlowDirective(input: BuildDirectiveInput): DirectiveBuild {
  const directive: FlowDirective = {
    version: FLOW_DIRECTIVE_VERSION,
    flow: input.flow,
    tranche: trancheOfFlow(input.flow),
    session: input.session,
    boundary: input.boundary,
    outcome: input.outcome,
    state_digest: input.stateDigest,
    applied: [...input.applied],
    pending: [...input.pending],
    request: input.request ?? null,
    choices: [...(input.choices ?? [])],
    effects: {
      planned: [...(input.effects?.planned ?? [])],
      approved: [...(input.effects?.approved ?? [])],
      applied: [...(input.effects?.applied ?? [])],
    },
    authorizations: [...(input.authorizations ?? [])],
    degradations: [...(input.degradations ?? [])],
    error: input.error ?? null,
    next_action: input.nextAction,
  };

  for (const check of DIRECTIVE_CHECKS) {
    const failure = check(directive);
    if (failure !== null) return { ok: false, failure };
  }
  return { ok: true, directive };
}

type DirectiveCheck = (directive: FlowDirective) => CapabilityFailure | null;

function reject(code: string, message: string, action: string): CapabilityFailure {
  return { code, message, action };
}

function checkNextAction(directive: FlowDirective): CapabilityFailure | null {
  if (directive.next_action.trim().length > 0) return null;
  return reject(
    "FLOW_DIRECTIVE_NO_NEXT_ACTION",
    "la directiva no dice cómo continuar",
    "declará la próxima acción válida: una frontera sin continuación es un callejón",
  );
}

function checkFinal(directive: FlowDirective): CapabilityFailure | null {
  const final = directive.boundary.kind === "final";
  if (final && directive.pending.length > 0) {
    return reject(
      "FLOW_DIRECTIVE_FINAL_WITH_PENDING",
      `la directiva declara el recorrido terminado y deja ${directive.pending.length} transición(es) pendientes`,
      "devolvé la frontera que corresponde a la primera transición pendiente",
    );
  }
  if (final && directive.boundary.transition !== null) {
    return reject(
      "FLOW_DIRECTIVE_FINAL_WITH_TRANSITION",
      "una finalización nombra una transición en la que se detuvo",
      "una finalización no se para en ninguna transición: dejá 'transition' en null",
    );
  }
  if (!final && directive.boundary.transition === null) {
    return reject(
      "FLOW_DIRECTIVE_BOUNDARY_WITHOUT_TRANSITION",
      `una frontera '${directive.boundary.kind}' no dice en qué transición se detuvo`,
      "nombrá la transición de la frontera, o declarala 'final'",
    );
  }
  return null;
}

function checkSemantic(directive: FlowDirective): CapabilityFailure | null {
  const semantic = directive.boundary.kind === "semantic";
  if (semantic && directive.request === null) {
    return reject(
      "FLOW_DIRECTIVE_SEMANTIC_WITHOUT_REQUEST",
      "una frontera semántica no trae el pedido acotado que el agente tiene que contestar",
      "construí el SemanticRequest con su contrato, sus límites y su read_set visible",
    );
  }
  if (!semantic && directive.request !== null) {
    return reject(
      "FLOW_DIRECTIVE_REQUEST_WITHOUT_SEMANTIC",
      `una frontera '${directive.boundary.kind}' trae un pedido semántico`,
      "el pedido acotado viaja solo en la frontera semántica",
    );
  }
  return null;
}

function checkChoices(directive: FlowDirective): CapabilityFailure | null {
  const chooses =
    directive.boundary.kind === "human" || directive.boundary.kind === "authorization";
  if (!chooses) {
    if (directive.choices.length === 0) return null;
    return reject(
      "FLOW_DIRECTIVE_CHOICES_WITHOUT_BOUNDARY",
      `una frontera '${directive.boundary.kind}' ofrece alternativas`,
      "las alternativas viajan solo en una frontera humana o de autorización",
    );
  }
  if (directive.choices.length < 2) {
    return reject(
      "FLOW_DIRECTIVE_CHOICE_SET_TOO_SMALL",
      "una frontera que pide una preferencia ofrece menos de dos alternativas",
      "si no hay más de una continuación válida, no es una preferencia: aplicá la regla",
    );
  }
  for (const choice of directive.choices) {
    if (choice.label.trim().length === 0 || choice.consequence.trim().length === 0) {
      return reject(
        "FLOW_DIRECTIVE_CHOICE_WITHOUT_CONSEQUENCE",
        "una alternativa no declara su etiqueta o su consecuencia",
        "cada alternativa lleva etiqueta y consecuencia: elegir a ciegas no es elegir",
      );
    }
  }
  if (directive.choices.filter((choice) => choice.recommended).length !== 1) {
    return reject(
      "FLOW_DIRECTIVE_RECOMMENDATION_AMBIGUOUS",
      "el conjunto de alternativas no tiene exactamente una recomendación",
      "marcá una sola recomendación: la persona ratifica o corrige, nunca arranca en frío",
    );
  }
  return null;
}

function checkBlocked(directive: FlowDirective): CapabilityFailure | null {
  if (directive.boundary.kind === "blocked" && directive.error === null) {
    return reject(
      "FLOW_DIRECTIVE_BLOCKED_WITHOUT_CAUSE",
      "una frontera de bloqueo no dice qué lo bloquea",
      "declará el error con código, mensaje y acción: un bloqueo sin causa es un callejón",
    );
  }
  return null;
}

/**
 * The authorization boundary has to be about something.
 *
 * If every planned effect is already covered, stopping to ask would be ceremony
 * — and worse, it would train whoever reads the run to click through approvals
 * that mean nothing.
 */
function checkAuthorization(directive: FlowDirective): CapabilityFailure | null {
  if (directive.boundary.kind !== "authorization") return null;
  const granted = new Set(directive.authorizations);
  if (directive.effects.planned.some((effect) => !granted.has(effect))) return null;
  return reject(
    "FLOW_DIRECTIVE_AUTHORIZATION_WITHOUT_GAP",
    "una frontera de autorización no nombra ningún efecto que falte autorizar",
    "seguí avanzando: todo lo planeado ya está cubierto por la autorización vigente",
  );
}

function checkEffectLedger(directive: FlowDirective): CapabilityFailure | null {
  const planned = new Set(directive.effects.planned);
  const stages: Array<[readonly EffectClass[], string]> = [
    [directive.effects.applied, "aplicado"],
    [directive.effects.approved, "aprobado"],
  ];
  for (const [effects, verb] of stages) {
    for (const effect of effects) {
      if (planned.has(effect)) continue;
      return reject(
        "FLOW_DIRECTIVE_EFFECT_UNPLANNED",
        `declara un efecto '${effect}' ${verb} que no estaba planeado`,
        "declará cada efecto antes de ejercerlo",
      );
    }
  }
  const granted = new Set(directive.authorizations);
  for (const effect of directive.effects.approved) {
    if (granted.has(effect)) continue;
    return reject(
      "FLOW_DIRECTIVE_EFFECT_UNAUTHORIZED",
      `el efecto '${effect}' figura aprobado y ninguna autorización de la corrida lo cubre`,
      "pedí la autorización en una frontera humana antes de aprobar el efecto",
    );
  }
  return null;
}

function checkApplied(directive: FlowDirective): CapabilityFailure | null {
  const seen = new Set(directive.applied);
  if (seen.size === directive.applied.length) return null;
  return reject(
    "FLOW_DIRECTIVE_APPLIED_REPEATED",
    "la traza de esta invocación repite una transición",
    "una transición se aplica una sola vez por recorrido",
  );
}

const DIRECTIVE_CHECKS: readonly DirectiveCheck[] = [
  checkNextAction,
  checkFinal,
  checkSemantic,
  checkChoices,
  checkBlocked,
  checkAuthorization,
  checkEffectLedger,
  checkApplied,
];

/**
 * The human projection — DERIVED, never authored beside the data.
 *
 * Every line reads a field of the directive it was given, the same rule
 * `renderReceiptHuman` follows, so the prose cannot contradict the structured
 * form: there is no second source for it to disagree with.
 */
export function renderDirectiveHuman(directive: FlowDirective): string {
  return [
    `${directive.flow} (${directive.tranche}) — frontera ${directive.boundary.kind}: ${directive.outcome}`,
    ...boundaryLines(directive),
    ...askLines(directive),
    ...effectLines(directive),
    `continuidad: ${directive.state_digest}`,
    `siguiente: ${directive.next_action}`,
  ].join("\n");
}

function boundaryLines(directive: FlowDirective): string[] {
  const lines: string[] = [];
  if (directive.boundary.transition !== null) {
    const owner = directive.boundary.ownership === null ? "" : ` · ${directive.boundary.ownership}`;
    const title = directive.boundary.title === null ? "" : ` — ${directive.boundary.title}`;
    lines.push(`detenido en ${directive.boundary.transition}${owner}${title}`);
  }
  if (directive.applied.length > 0) {
    lines.push(`aplicadas en esta invocación: ${directive.applied.join(", ")}`);
  }
  if (directive.pending.length > 0) lines.push(`pendientes: ${directive.pending.length}`);
  return lines;
}

function askLines(directive: FlowDirective): string[] {
  const lines: string[] = [];
  if (directive.request !== null) {
    lines.push(`contrato de respuesta: ${directive.request.contract}`);
    lines.push(`read_set visible: ${directive.request.read_set.join(", ") || "ninguno"}`);
  }
  for (const choice of directive.choices) {
    lines.push(
      `${choice.recommended ? "· (recomendada) " : "· "}${choice.label} — ${choice.consequence}`,
    );
  }
  return lines;
}

function effectLines(directive: FlowDirective): string[] {
  const lines: string[] = [];
  if (directive.authorizations.length > 0) {
    lines.push(`efectos permitidos: ${directive.authorizations.join(", ")}`);
  }
  if (directive.effects.applied.length > 0) {
    lines.push(`efectos aplicados: ${directive.effects.applied.join(", ")}`);
  }
  for (const degradation of directive.degradations) {
    lines.push(`degradación (${degradation.cause}): ${degradation.loss}`);
  }
  if (directive.error !== null) {
    lines.push(`error ${directive.error.code}: ${directive.error.message}`);
  }
  return lines;
}
