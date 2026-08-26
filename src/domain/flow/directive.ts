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
import type { DecisionPreview } from "../decision-preview.js";
import type { PreviewEntry, ProposalScope } from "../proposal.js";
import {
  type DelegatedAction,
  type FlowAuthority,
  type FlowChoice,
  type FlowDecision,
  type FlowTranche,
  type TransitionOwnership,
  trancheOfFlow,
} from "./authority.js";
import type { AttemptAccounting } from "./run-state.js";

export const FLOW_DIRECTIVE_VERSION = 1;

/**
 * The reasons a deterministic advance stops. They are the spec's own list, and
 * collapsing any two would erase the difference between "I need a judgment", "I
 * need a preference", "I need an approval", "I am stuck" and "there is nothing
 * left".
 *
 * There used to be a seventh — `legacy`, "this step is not mine yet" — and it was
 * the only one whose next action sent the reader to a document instead of back to
 * the engine. It is gone with the last row that needed it: every boundary now
 * stands on a step this CLI owns, and a transition that somehow does not is
 * `blocked` with its reason, never handed back to prose.
 *
 * `execution` is the one that stops on a step the CLI DOES own AND cannot apply:
 * the rule is decided and the effect is not the engine's to materialize, so the
 * run holds until the sealed invocation comes back with a verifiable result.
 * Merging it into `human` would turn "run this and show me the output" into
 * "approve this", and an approval is precisely what does not prove anything ran.
 */
export const FLOW_BOUNDARY_KINDS = [
  "semantic",
  "human",
  "authorization",
  "execution",
  "blocked",
  "final",
] as const;

export type FlowBoundaryKind = (typeof FLOW_BOUNDARY_KINDS)[number];

/**
 * The flow control's two labels — canonical, verbatim, on every host.
 *
 * They live in the domain because three layers need the same two strings and
 * none of them may spell them differently: the engine appends them to a
 * boundary, the answer parser lets either through without demanding whatever the
 * boundary was asking for, and `submit` tells them apart to give each its own
 * outcome. Pausing keeps the boundary and the work; stopping keeps the state and
 * ends the run here. Neither resolves the question that was asked.
 */
export const PAUSE_LABEL = "Compactar";
export const STOP_LABEL = "Cerrar";

/** Whether a chosen label is the flow control rather than an answer. */
export function isFlowControl(label: string | null): boolean {
  return label === PAUSE_LABEL || label === STOP_LABEL;
}

// The alternatives of a boundary are DATA OF THE DECISION — a migrated tranche
// declares its own — so the type lives with the registry and is re-exported here,
// where the directive that carries them is defined.
export type { FlowChoice } from "./authority.js";

export interface FlowBoundary {
  kind: FlowBoundaryKind;
  /** The transition standing at the boundary; null only when the run is final. */
  transition: string | null;
  authority: FlowAuthority | null;
  /** With what ownership the run advanced — `cli-owned`, or null when final. */
  ownership: TransitionOwnership | null;
  title: string | null;
  /**
   * The doctrine document behind this transition — where its EXPLANATION lives.
   *
   * It is no longer a fallback declaration: nothing reads it to decide the step.
   * It stays because whoever answers a boundary is entitled to know which document
   * explains what is being asked, and because the guard that keeps the doctrine
   * attributing every migrated rule reads exactly this field.
   */
  document: string | null;
}

/**
 * What the run did with a step it passed: applied it, or skipped it because its
 * condition did not hold.
 *
 * Two words rather than a boolean, and a closed vocabulary rather than prose: the
 * trace is read by whoever resumes, and "the gate did not appear" has to be
 * distinguishable from "the gate was answered" without anyone inferring it.
 */
export const FLOW_STEP_OUTCOMES = ["applied", "skipped"] as const;

export type FlowStepOutcome = (typeof FLOW_STEP_OUTCOMES)[number];

/**
 * One transition the run passed, with the authority that moved it.
 *
 * The trace is a list of these instead of bare ids because during the migration
 * "it advanced" is not the whole truth: whoever executes has to see whether the
 * step came from a rule this CLI owns or from doctrine it merely recorded. The
 * facts travel with the step so they can never be read apart.
 */
export interface FlowStep {
  transition: string;
  authority: FlowAuthority;
  ownership: TransitionOwnership;
  outcome: FlowStepOutcome;
  /** Why it was skipped. Present only on a skipped step; never invented. */
  reason: string | null;
}

/** Project a decision into the trace entry of having passed it. */
export function stepOf(decision: FlowDecision): FlowStep {
  return {
    transition: decision.id,
    authority: decision.authority,
    ownership: decision.ownership,
    outcome: "applied",
    reason: null,
  };
}

/** Project a decision into the trace entry of having passed OVER it. */
export function skippedStepOf(decision: FlowDecision, reason: string): FlowStep {
  return { ...stepOf(decision), outcome: "skipped", reason };
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
  /** Transitions applied in THIS invocation, in order, each with its authority. */
  applied: FlowStep[];
  /** Transition ids still ahead, so a finalization cannot hide pending work. */
  pending: string[];
  /** Present exactly at a semantic boundary. */
  request: SemanticRequest | null;
  /**
   * Present exactly at an `execution` boundary: what to run, and what has to come
   * back. Sealed by `state_digest` along with the state and the transition, so
   * changing the program, an argument, the target, the input or the demanded
   * evidence makes any result that quotes the old seal stale.
   *
   * Those five ARE the seal's whitelist, so the action is no longer uniformly
   * sealed: `checkouts` is a host-local observation attached on the way out and is
   * deliberately outside it. That is what lets an answer produced on one machine
   * stay valid — a path inside the seal would make an identical reply stale merely
   * for having been written somewhere else.
   */
  action: DelegatedAction | null;
  /** Non-empty exactly at a human or authorization boundary. */
  choices: FlowChoice[];
  /**
   * Present exactly at a boundary that decides a sealed local proposal: what
   * lands where, how much it weighs and what it replaces.
   *
   * The bytes are NOT here. Whoever authored them already has them, and copying
   * them into the directive would make the preview a second copy of the content
   * that can drift from the sealed one. What the engine adds is the part nobody
   * else can compute: the seal, the destinations and the effects.
   */
  proposal: DirectiveProposal | null;
  /**
   * The full decision-registration view prepared before the deviation choice.
   *
   * It is not a second copy of a generic proposal: its eight sections explain
   * the effective-contract consequence the human is about to authorize. `null`
   * everywhere except a prepared PLAN-exec deviation gate.
   */
  decision_preview: DecisionPreview | null;
  effects: EffectLedger;
  /**
   * Effect classes covered AT THE BOUNDARY IN FORCE — never a run-wide permit.
   *
   * It used to be the run's accumulated classes, which is exactly the leak the
   * scoped grant closes: approving one overwrite left the list saying the run
   * could overwrite anything. A grant is given over a seal, so what a directive
   * can honestly report is what the boundary it stands on is covered for.
   */
  authorizations: EffectClass[];
  degradations: Degradation[];
  error: CapabilityFailure | null;
  /**
   * What the boundary in force has spent, and what disagrees — or `null`.
   *
   * `null` only where there is no boundary to count: a finished run. Everywhere
   * else it travels, whether or not the directive carries an error, because the
   * question "how many tries do I have left" is asked most often by somebody who
   * has not been refused yet. Its absence used to be the whole defect: the spend
   * lived in a Spanish sentence inside `next_action`, so a host could show it to
   * a person and no program could read it, and the representations that
   * disagreed had no field to be named in at all.
   */
  attempt_accounting: AttemptAccounting | null;
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
  "action",
  "choices",
  "proposal",
  "decision_preview",
  "effects",
  "authorizations",
  "degradations",
  "error",
  "attempt_accounting",
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

/**
 * The sealed local change a boundary is deciding.
 *
 * `digest` is what makes an identical retry free: the same proposal produces the
 * same seal, the grant already given over it still matches, and nobody is asked
 * twice. Anything material that changes changes the seal, and the question comes
 * back with a new preview.
 */
export interface DirectiveProposal {
  digest: string;
  preview: PreviewEntry[];
  /** What publishing it exercises. */
  effects: EffectClass[];
  /** Of those, the ones the person has to approve for it to happen at all. */
  requires_approval: EffectClass[];
  scope: ProposalScope;
}

export interface BuildDirectiveInput {
  flow: WorklineFlow;
  session: string;
  boundary: FlowBoundary;
  outcome: CapabilityOutcome;
  stateDigest: string;
  applied: readonly FlowStep[];
  pending: readonly string[];
  request?: SemanticRequest | null;
  action?: DelegatedAction | null;
  choices?: readonly FlowChoice[];
  proposal?: DirectiveProposal | null;
  decisionPreview?: DecisionPreview | null;
  effects?: Partial<EffectLedger>;
  authorizations?: readonly EffectClass[];
  degradations?: readonly Degradation[];
  error?: CapabilityFailure | null;
  attemptAccounting?: AttemptAccounting | null;
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
    action: input.action ?? null,
    choices: [...(input.choices ?? [])],
    proposal: input.proposal ?? null,
    decision_preview: input.decisionPreview ?? null,
    effects: {
      planned: [...(input.effects?.planned ?? [])],
      approved: [...(input.effects?.approved ?? [])],
      applied: [...(input.effects?.applied ?? [])],
    },
    authorizations: [...(input.authorizations ?? [])],
    degradations: [...(input.degradations ?? [])],
    error: input.error ?? null,
    attempt_accounting: input.attemptAccounting ?? null,
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

/**
 * An `execution` boundary is the action, and nothing else is.
 *
 * Without the action the boundary would say "something has to run" and name
 * nothing — the confirmation-shaped failure this whole phase exists to refuse.
 * Carrying it anywhere else would be worse: a second place where an invocation
 * can be read, only one of which the seal covers.
 *
 * The evidence and the recovery are demanded HERE, at construction, for the same
 * reason: an action nobody can check is a confirmation with extra steps, and one
 * that does not say what to do when it comes back half-done leaves the run's
 * only real failure mode without an answer.
 */
function checkExecution(directive: FlowDirective): CapabilityFailure | null {
  const execution = directive.boundary.kind === "execution";
  if (!execution) {
    if (directive.action === null) return null;
    return reject(
      "FLOW_DIRECTIVE_ACTION_WITHOUT_BOUNDARY",
      `una frontera '${directive.boundary.kind}' trae una acción delegada`,
      "la acción viaja solo en la frontera 'execution': es la única que espera un resultado de ejecución",
    );
  }
  const action = directive.action;
  if (action === null) {
    return reject(
      "FLOW_DIRECTIVE_EXECUTION_WITHOUT_ACTION",
      "una frontera de ejecución no dice qué hay que ejecutar",
      "declará la invocación exacta: programa, argumentos, target y la evidencia que tiene que volver",
    );
  }
  if (
    action.invocation.program.trim().length === 0 ||
    action.invocation.target.trim().length === 0
  ) {
    return reject(
      "FLOW_DIRECTIVE_ACTION_INCOMPLETE",
      "la acción delegada no nombra su programa o su target",
      "una invocación sin programa o sin dónde corre no es reproducible: declaralos",
    );
  }
  if (action.evidence.length === 0) {
    return reject(
      "FLOW_DIRECTIVE_ACTION_WITHOUT_EVIDENCE",
      "la acción delegada no exige ninguna evidencia de que ocurrió",
      "nombrá las validaciones cuya salida real tiene que volver: sin eso, el resultado es una confirmación",
    );
  }
  if (action.recovery.trim().length === 0) {
    return reject(
      "FLOW_DIRECTIVE_ACTION_WITHOUT_RECOVERY",
      "la acción delegada no declara qué hacer si vuelve fallida o parcial",
      "declará la recuperación: un efecto parcial sin salida deja la corrida sin próxima acción",
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
    if (!isNonBlankString(choice.label) || !isNonBlankString(choice.consequence)) {
      return reject(
        "FLOW_DIRECTIVE_CHOICE_WITHOUT_CONSEQUENCE",
        "una alternativa no declara su etiqueta o su consecuencia",
        "cada alternativa lleva etiqueta y consecuencia: elegir a ciegas no es elegir",
      );
    }
    if (!isChoiceOutcome(choice.outcome)) {
      return reject(
        "FLOW_DIRECTIVE_CHOICE_OUTCOME_INVALID",
        `la alternativa '${choice.label}' no declara una consecuencia ejecutable válida`,
        "cada alternativa debe continuar, registrar una decisión, entregar a un destino o ser un control explícito",
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

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isChoiceOutcome(value: unknown): value is FlowChoice["outcome"] {
  if (typeof value !== "object" || value === null) return false;
  const outcome = value as Record<string, unknown>;
  return (
    outcome.kind === "continue" ||
    outcome.kind === "register-decision" ||
    (outcome.kind === "handoff" &&
      (outcome.destination === "plan-refine" ||
        outcome.destination === "spec-refine" ||
        outcome.destination === "spec-new")) ||
    (outcome.kind === "control" && (outcome.control === "pause" || outcome.control === "stop"))
  );
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
  // `approved ⊆ authorizations` used to be checked here too, and it stopped being
  // checkable when the permit stopped being run-wide: `authorizations` now reports
  // what the BOUNDARY IN FORCE is covered for, so a directive standing on a later
  // step legitimately says nothing about the grant given for an earlier proposal —
  // and comparing the accumulated ledger against it would refuse every honest
  // directive. The invariant did not disappear: `withApproval` writes the grant and
  // the `approved` moment from the same object, so they cannot diverge at the only
  // place either of them is produced.
  return null;
}

/**
 * A boundary that asks anything stands on a transition this CLI owns.
 *
 * This is what the retired fallback leaves behind. While `legacy` existed the
 * check was a correspondence — that kind and ownership told the same story — and
 * an unowned transition had somewhere to go. Now it has none, so the rule is flat:
 * emitting a bounded request, a set of alternatives or an invocation for a step
 * the registry does not say the CLI owns would be the engine speaking for a
 * document nobody read. Such a transition is `blocked`, and it says why.
 *
 * `blocked` is exempt because that IS the answer for one; `authorization` because
 * it asks to approve an EFFECT rather than decide the step, and refusing that
 * combination would bypass the effect gate.
 */
function checkOwnership(directive: FlowDirective): CapabilityFailure | null {
  const boundary = directive.boundary;
  if (boundary.transition === null) return null;
  if (boundary.kind === "blocked" || boundary.kind === "authorization") return null;
  if (boundary.ownership === "cli-owned") return null;
  return reject(
    "FLOW_DIRECTIVE_OWNERSHIP_CONTRADICTED",
    `una frontera '${boundary.kind}' declara la transición como '${boundary.ownership}'`,
    "la propiedad sale del registro y ya no hay doctrina a la que devolver el paso: una transición sin propiedad del CLI se devuelve bloqueada",
  );
}

function checkApplied(directive: FlowDirective): CapabilityFailure | null {
  const seen = new Set(directive.applied.map((step) => step.transition));
  if (seen.size !== directive.applied.length) {
    return reject(
      "FLOW_DIRECTIVE_APPLIED_REPEATED",
      "la traza de esta invocación repite una transición",
      "una transición se aplica una sola vez por recorrido",
    );
  }
  // A skipped step without its cause is worse than no trace at all: it says the
  // run passed a decision nobody made and gives the reader nothing to check.
  for (const step of directive.applied) {
    const omitted = step.outcome === "skipped";
    if (omitted === (step.reason ?? "").trim().length > 0) continue;
    return reject(
      "FLOW_DIRECTIVE_STEP_REASON_MISMATCH",
      `el paso '${step.transition}' declara '${step.outcome}' y ${omitted ? "no dice por qué se omitió" : "trae un motivo de omisión"}`,
      "un paso omitido declara su motivo; uno aplicado no lleva ninguno",
    );
  }
  return null;
}

const DIRECTIVE_CHECKS: readonly DirectiveCheck[] = [
  checkNextAction,
  checkFinal,
  checkSemantic,
  checkExecution,
  checkChoices,
  checkBlocked,
  checkAuthorization,
  checkOwnership,
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
    const trace = directive.applied
      .map((step) => {
        const base = `${step.transition} (${step.authority} · ${step.ownership}`;
        // The omission carries its cause in the same breath: a step that reads
        // "omitida" and nothing else sends the reader to the registry to find out
        // why the run did not stop where the doctrine says it stops.
        return step.outcome === "skipped"
          ? `${base} · OMITIDA: ${step.reason ?? "sin motivo declarado"})`
          : `${base})`;
      })
      .join(", ");
    lines.push(`pasos de esta invocación: ${trace}`);
  }
  if (directive.pending.length > 0) lines.push(`pendientes: ${directive.pending.length}`);
  return lines;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one renderer keeps every visible boundary field in one ordered projection.
function askLines(directive: FlowDirective): string[] {
  const lines: string[] = [];
  if (directive.request !== null) {
    lines.push(`contrato de respuesta: ${directive.request.contract}`);
    lines.push(`read_set visible: ${directive.request.read_set.join(", ") || "ninguno"}`);
  }
  if (directive.action !== null) {
    const call = directive.action.invocation;
    lines.push(`ejecutar: ${[call.program, ...call.args].join(" ")}`);
    lines.push(`en: ${call.target}${call.input === null ? "" : " (con input por stdin)"}`);
    lines.push(`evidencia exigida: ${directive.action.evidence.join(", ")}`);
    // The root the validator will measure, said out loud. Publishing it is the
    // whole point: the prover cannot deduce which directory the digest covers, and
    // the alias alone sent readers hunting for a change in an intact tree.
    const checkouts = directive.action.checkouts ?? [];
    if (checkouts.length > 0) {
      const observed = checkouts
        .map((checkout) => `${checkout.source} → ${checkout.root}`)
        .join(" · ");
      lines.push(`checkout que validará (observación local de esta corrida): ${observed}`);
      lines.push(
        "esa raíz es de este host; la regla portátil que la eligió está en 'aw flow --help', y 'aw flow prove' captura y prevalida la prueba contra ella",
      );
    }
    lines.push(`si vuelve fallida o parcial: ${directive.action.recovery}`);
  }
  const preview = directive.decision_preview;
  if (preview !== null) {
    lines.push(`vista previa de decisión: ${preview.baseline.path} @ ${preview.baseline.digest}`);
    lines.push(
      `cambios efectivos: ${preview.effective_change.map((change) => change.assertion).join(", ") || "ninguno"}`,
    );
    lines.push(`consumidores: ${preview.consumers.join(", ") || "ninguno"}`);
    lines.push(
      `impacto: ${preview.impact.scope} · ${preview.impact.assertions} assertion(es) · ${preview.impact.consumers} consumidor(es)`,
    );
    lines.push(
      `evidencia: conserva ${preview.evidence.preserved.join(", ") || "ninguna"}; invalida ${preview.evidence.invalidated.join(", ") || "ninguna"}`,
    );
    lines.push(`obligaciones: ${preview.obligations.join(", ") || "ninguna"}`);
    lines.push(`reanudación: ${preview.resume_point}`);
    lines.push(
      `efectos de decisión: ${preview.effects.classes.join(", ") || "ninguno"} · ${preview.effects.entries.map((entry) => entry.path).join(", ")}`,
    );
    lines.push(`sello del preview: ${preview.proposal.digest}`);
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
