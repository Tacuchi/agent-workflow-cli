/**
 * The answer, validated as DATA before anything moves.
 *
 * What the agent or the person sends back is an input to a CLI decision, never
 * the decision itself. Which shape is admissible is determined by the BOUNDARY IN
 * FORCE — never by a flag the caller passes — so the same command answers a
 * semantic boundary, a human one and an authorization one without the caller
 * being able to claim it is answering something else.
 *
 * Five ways an answer fails, and all five leave state and effects untouched:
 * absent, invalid, ambiguous, out of scope and stale. There was a sixth while the
 * doctrine still decided steps — an answer that never declared which fallback it
 * applied — and it left with the boundary that demanded it. Each rejection carries
 * a code, a message and one valid action, and travels inside the RECALCULATED
 * directive with `ok: true` — with `ok: false` the host never calls `renderHuman`
 * and the person would never see the boundary they have to answer over.
 */

import { resolve } from "node:path";
import type {
  SemanticArtifact,
  SemanticRequest,
} from "../../application/semantic-operation/protocol.js";
import { parseSemanticArtifacts } from "../../application/semantic-operation/protocol.js";
import { EFFECT_CLASSES, type EffectClass, isEffectClass } from "../capability/effects.js";
import {
  CAPABILITY_OUTCOMES,
  COMPLETENESS_VALUES,
  type CapabilityFailure,
  type CapabilityOutcome,
  type Completeness,
  type DurableReference,
  type EffectLedger,
  type OperationOutput,
  type ValidationOutcome,
} from "../capability/protocol.js";
import type { CheckoutProof } from "../source-boundary.js";
import {
  type DelegatedAction,
  type DelegatedInvocation,
  type FlowDecision,
  effectsOf,
  proposalContractOf,
} from "./authority.js";
import { BATCH_REVIEW_CONTRACT, isBatchReview } from "./batch-review.js";
import { type FlowBoundaryKind, type FlowChoice, STOP_LABEL, isFlowControl } from "./directive.js";

/**
 * What came back from a delegated invocation, in the vocabulary already
 * delivered: the receipt's outcome, its `OperationOutput`, its `ValidationOutcome`
 * list and its `EffectLedger`. No new result protocol, and no `confirmed: true` —
 * the whole point is that the run reads what the tool produced, not what the
 * caller says about it.
 */
export interface FlowExecutionResult {
  outcome: CapabilityOutcome;
  /** The invocation the executor actually ran, to compare against the sealed one. */
  invocation: DelegatedInvocation;
  output: OperationOutput | null;
  validations: ValidationOutcome[];
  effects: EffectLedger;
}

/** What survived validation, ready to become a transition. */
export interface FlowAnswer {
  /** Seal of the boundary this answers — the semantic request's own field. */
  input_digest: string;
  /** Signals the agent declared, all of them inside the boundary's vocabulary. */
  signals: string[];
  /** Whatever else the contract asked for, opaque to the CLI. */
  decisions: Record<string, unknown>;
  /** The alternative chosen, at a human or authorization boundary. */
  choice: string | null;
  /** The execution result, at an `execution` boundary. */
  result: FlowExecutionResult | null;
  /**
   * The exact bytes to write, at an authoring boundary that proposes.
   *
   * Empty everywhere else, and that is enforced rather than assumed: a boundary
   * that declares no proposal contract accepts no artifacts at all, so a row
   * cannot start writing files by having somebody send some.
   */
  artifacts: SemanticArtifact[];
}

export type FlowAnswerParse =
  | { ok: true; answer: FlowAnswer }
  | { ok: false; failure: CapabilityFailure };

type Violation = NonNullable<CapabilityFailure["violations"]>[number];

/** Preserve the first code/message while publishing every independent defect. */
function collected(
  entries: readonly { failure: CapabilityFailure; violation: Violation }[],
): CapabilityFailure {
  const first = entries[0];
  if (first === undefined) throw new Error("no hay violaciones para entregar");
  return {
    ...first.failure,
    violations: entries.map((entry) => entry.violation),
  };
}

function violation(
  failure: CapabilityFailure,
  field: string,
  expected: string,
  received: unknown,
): { failure: CapabilityFailure; violation: Violation } {
  return {
    failure,
    violation: {
      code: failure.code,
      field,
      expected,
      received: Array.isArray(received) ? "lista" : received === null ? "null" : typeof received,
      message: failure.message,
    },
  };
}

/**
 * Which rejections COUNT as an attempt at the boundary, and which never reached
 * it.
 *
 * The cap of three exists to stop a gap from being re-fired forever — that is
 * doctrine. What it never meant to protect against is a typo in the envelope, and
 * the difference had a measured cost: hosts spent whole sessions discovering that
 * `outcome` goes at the top level, that a validation carries `id` and not `name`,
 * that an authoring boundary wants its bytes in `artifacts` — and every discovery
 * burned one of the three tries at a boundary they had not yet been able to
 * answer once. Two typos plus one real attempt exhausted a run.
 *
 * So the line is: **did the payload deliver a decision this boundary could
 * weigh?**
 *
 * - `envelope` — nothing was weighed. No payload at all, unparseable JSON, an
 *   answer addressed to another boundary (`STALE`), a boundary that expects none,
 *   a result that is not a result (`FLOW_RESULT_INVALID`), bytes in the wrong
 *   channel or missing from the only channel that carries them
 *   (`FLOW_ARTIFACTS_*`, and the path/size refusals the semantic protocol
 *   raises). At an execution boundary the decision IS the result and at an
 *   authoring one it IS the bytes: with neither there, there is nothing to judge,
 *   and charging for it charges for the envelope.
 * - `evaluated` — the decision arrived and did not resolve the gap. An execution
 *   that did not complete or left its effect half-applied, a scope naming sources
 *   the workspace or the plan does not, a proposal reaching past what its row
 *   declares, or an answer that declares nothing at all. Unknown literals,
 *   malformed proofs, copied digests and invocations are envelope errors.
 * - `control` — a real answer that deliberately applies nothing, or the same
 *   answer arriving twice. Pausing to compact, stopping the run, and a resend are
 *   all decisions somebody made on purpose; charging them would make the flow
 *   control the CLI itself offers cost an attempt, which is the loop the cap is
 *   supposed to prevent rather than one it is supposed to count.
 *
 * `FLOW_ANSWER_STALE` is the one worth spelling out. It looks like a bad answer
 * and is not: it answers a boundary the run has left, so charging it would spend
 * the CURRENT boundary's budget on a payload that was never about it — and
 * staleness is frequently the engine's own doing, since the run may have moved
 * between the directive and the answer.
 *
 * Every code the parser, the execution verdict and `submit` can put in front of a
 * boundary is in here. That is not tidiness: `submit`'s own refusals used to sit
 * outside the table and outside the charge, so a scope answered with an alias the
 * plan does not name could be re-sent forever — never exhausting, never
 * degrading, never recovering. A guard walks the three sources and fails if a
 * code is missing from this table.
 */
export const FLOW_ANSWER_REJECTIONS: Readonly<
  Record<string, "envelope" | "evaluated" | "control">
> = {
  FLOW_ANSWER_MISSING: "envelope",
  FLOW_ANSWER_INVALID: "envelope",
  FLOW_ANSWER_STALE: "envelope",
  WORKSPACE_MISMATCH: "envelope",
  FLOW_ANSWER_NOT_EXPECTED: "envelope",
  FLOW_RESULT_INVALID: "envelope",
  FLOW_ARTIFACTS_MISSING: "envelope",
  FLOW_ARTIFACTS_NOT_EXPECTED: "envelope",
  // Raised by `parseSemanticArtifacts` and forwarded verbatim: a destination
  // outside the allowlist, a duplicate, an oversized artifact.
  SEMANTIC_PATH_REJECTED: "envelope",
  SEMANTIC_RESPONSE_INVALID: "envelope",
  // The workspace's documentation layout is invalid before the boundary can
  // inspect an answer. The flow returns its corrective action, but no attempt
  // was made at the pending decision.
  DOCS_CANON_INVALID: "envelope",
  // The registry moved under a run in flight, so the invocation the result is
  // about is no longer the one this build emits. Nothing about the ANSWER was
  // weighed, and the next `advance` re-binds the action by itself.
  FLOW_ACTION_CHANGED: "envelope",
  // A result sent for a step the CLI runs itself. Nothing about it can be weighed
  // — the only credit is the driver's own run — and the way out is to run the
  // action, so charging the envelope would punish choosing the wrong verb.
  FLOW_INTERNAL_ACTION_EXTERNAL_RESULT: "envelope",
  FLOW_ANSWER_AMBIGUOUS: "evaluated",
  FLOW_SIGNAL_UNKNOWN: "envelope",
  FLOW_CHOICE_UNKNOWN: "envelope",
  FLOW_APPROVAL_MISSING: "envelope",
  FLOW_APPROVAL_MISMATCH: "envelope",
  WORKSPACE_COMMIT_UNAVAILABLE: "envelope",
  WORKSPACE_COMMIT_APPROVAL_INVALID: "envelope",
  FLOW_ACTION_MISMATCH: "envelope",
  // The execution verdict's own vocabulary: it judges a result that WAS read.
  FLOW_EXECUTION_NOT_COMPLETED: "evaluated",
  FLOW_EVIDENCE_MISSING: "evaluated",
  WORKLINE_CHECKOUT_PROOF_MISSING: "envelope",
  WORKLINE_CHECKOUT_PROOF_INVALID: "evaluated",
  WORKLINE_CHECKOUT_PROOF_SHAPE_INVALID: "envelope",
  WORKLINE_CHECKOUT_PROOF_ROOT_MISMATCH: "envelope",
  WORKLINE_CHECKOUT_UNOBSERVABLE: "envelope",
  WORKLINE_CHECKOUT_PROOF_STALE: "envelope",
  FLOW_EFFECT_PARTIAL: "evaluated",
  // The phase validation's own: the proofs were read and they are not this
  // batch's — nothing changed since its base, or they already credited another.
  PLAN_EXEC_BATCH_UNCHANGED: "evaluated",
  PLAN_EXEC_BATCH_STALE: "control",
  PLAN_VALIDATION_ONLY_NOT_APPROVED: "evaluated",
  PLAN_EXEC_PROOF_REUSED: "evaluated",
  PLAN_EXEC_BATCH_REVIEW_INVALID: "evaluated",
  PLAN_EXEC_BATCH_COMMIT_UNOBSERVABLE: "envelope",
  PLAN_EXEC_BATCH_COMMIT_MESSAGE_INVALID: "evaluated",
  PLAN_EXEC_BATCH_PATHS_REQUIRED: "evaluated",
  PLAN_EXEC_BATCH_SHARED_PATH: "evaluated",
  PLAN_EXEC_BATCH_PATH_NOT_OWNED: "evaluated",
  PLAN_ISOLATION_INVALID: "envelope",
  PLAN_TEST_RUN_NOT_EXECUTED: "evaluated",
  PLAN_FINAL_PIPELINE_MISSING: "evaluated",
  PLAN_PREEXISTING_FAILURES_INVALID: "evaluated",
  PLAN_TEST_FAILURES_UNREADABLE: "evaluated",
  PLAN_TEST_FAILURE_NEW: "evaluated",
  // The scope boundary distinguishes malformed fields and unavailable documents
  // from a proposed source set that the workspace or plan cannot accept.
  FLOW_SCOPE_INVALID: "evaluated",
  FLOW_SCOPE_SHAPE_INVALID: "envelope",
  FLOW_SCOPE_UNKNOWN_SOURCE: "evaluated",
  FLOW_SCOPE_NOT_IN_PLAN: "evaluated",
  FLOW_SCOPE_PLAN_UNREADABLE: "envelope",
  // The submitted scope named a plan and the CLI read it, but its location
  // violates the canonical documentation boundary.
  FLOW_SCOPE_PLAN_OUTSIDE_CANON: "envelope",
  FLOW_HANDOFF_PLAN_MISSING: "envelope",
  // El preview sin archivos, intención o forma del diff sigue incompleto.
  FLOW_PREVIEW_INVALID: "envelope",
  // The choice itself can be refused (evaluated); missing shape or an unreadable
  // live baseline cannot be charged to its author.
  FLOW_DECISION_SCOPE_MISSING: "envelope",
  FLOW_DECISION_INPUT_INVALID: "envelope",
  FLOW_DECISION_PLAN_UNREADABLE: "envelope",
  FLOW_DECISION_LINEAGE_INVALID: "evaluated",
  FLOW_DECISION_SPEC_UNREADABLE: "envelope",
  FLOW_DECISION_UNRESOLVABLE: "evaluated",
  FLOW_DECISION_PREPARATION_FAILED: "envelope",
  FLOW_DECISION_PREVIEW_ABSENT: "envelope",
  // The settlement's own vocabulary. Both mean the CLI READ the declaration and
  // compared it against what the plan really owes — a declaration that answers
  // for the wrong obligations, or that leaves one unanswered.
  FLOW_SETTLEMENT_INVALID: "evaluated",
  FLOW_SETTLEMENT_INCOMPLETE: "evaluated",
  PLAN_SOURCE_BOUNDARY_MISSING: "envelope",
  PLAN_SOURCE_UNKNOWN: "envelope",
  PLAN_TASK_SOURCE_OUTSIDE_PHASE: "envelope",
  PLAN_SOURCE_EXTERNAL_CLOSURE: "envelope",
  PLAN_SOURCE_LOCAL_PROOF_MISSING: "envelope",
  // The plan's grammar does not spend: a plan published without its lineage is
  // refused for what its header says, and fixing the header is the whole answer.
  PLAN_LINEAGE_UNSEALED: "envelope",
  // The authoring boundary's: the bytes arrived and what they would do is not
  // what the row declares, or their destination could not be read.
  FLOW_PROPOSAL_BEYOND_CONTRACT: "evaluated",
  FLOW_PROPOSAL_DESTINATION_UNOBSERVED: "envelope",
  FLOW_PROPOSAL_BASE_UNREADABLE: "envelope",
  // Route shape is free; attempting to bypass a hard gate is evaluated.
  FLOW_ROUTE_DECISION_INVALID: "envelope",
  FLOW_ROUTE_PROPOSAL_INVALID: "envelope",
  FLOW_ROUTE_SUBSTITUTION_INVALID: "envelope",
  FLOW_ROUTE_HARD_GATE: "evaluated",
  // The author's draft is a shape; a contradictory claim or a scope the
  // contract refuses is content. A moved baseline or publication is state.
  NOTE_NOT_OBJECT: "envelope",
  NOTE_SCHEMA_UNKNOWN: "envelope",
  NOTE_ID_INVALID: "envelope",
  NOTE_DECISION_MISSING: "envelope",
  NOTE_REASON_MISSING: "envelope",
  NOTE_CONSUMERS_MISSING: "envelope",
  NOTE_EVIDENCE_PRESERVED_MISSING: "envelope",
  NOTE_EVIDENCE_INVALIDATED_MISSING: "envelope",
  NOTE_OBLIGATIONS_MISSING: "envelope",
  NOTE_OBLIGATIONS_INVALID: "envelope",
  NOTE_OBLIGATION_KIND_MISSING: "envelope",
  NOTE_RESUME_POINT_MISSING: "envelope",
  NOTE_DATE_INVALID: "envelope",
  NOTE_DIGEST_MISSING: "envelope",
  NOTE_DIGEST_MISMATCH: "envelope",
  NOTE_SCOPE_INVALID: "envelope",
  NOTE_SUPERSEDES_INVALID: "envelope",
  NOTE_ASSERTIONS_MISSING: "envelope",
  NOTE_ASSERTIONS_INVALID: "envelope",
  NOTE_ASSERTIONS_DUPLICATE: "envelope",
  NOTE_LINEAGE_MISSING: "envelope",
  NOTE_LINEAGE_INVALID: "envelope",
  NOTE_LINEAGE_DIGEST_INVALID: "envelope",
  NOTE_EXECUTION_STATE_MISSING: "envelope",
  NOTE_INDEX_UNREADABLE: "envelope",
  NOTE_INDEX_INVALID: "envelope",
  NOTE_INDEX_SCHEMA_UNKNOWN: "envelope",
  NOTE_ALREADY_PUBLISHED: "control",
  NOTE_SUPERSEDES_ABSENT: "evaluated",
  NOTE_REWRITES_BASELINE: "evaluated",
  CONTRACT_BASELINE_ABSENT: "envelope",
  CONTRACT_ASSERTION_ABSENT: "evaluated",
  CONTRACT_OVERLAP: "evaluated",
  CONTRACT_CONTRADICTION: "evaluated",
  DECISION_BASE_ABSENT: "envelope",
  PROPOSAL_LOCKED: "control",
  PROPOSAL_BASELINE_UNSEALED: "envelope",
  PROPOSAL_APPROVAL_MISMATCH: "envelope",
  PROPOSAL_APPROVAL_MISSING: "envelope",
  PROPOSAL_BASE_GONE: "envelope",
  PROPOSAL_BASE_STALE: "envelope",
  // A compensation the run declared STILL PENDING is not a malformed answer and
  // not a failed check: it is the truthful one. The closure stays where it is
  // until the work is done, and charging an attempt for saying so would make
  // telling the truth cost the run its retries.
  PLAN_EXEC_SETTLEMENT_PENDING: "control",
  FLOW_BOUNDARY_PAUSED: "control",
  FLOW_BOUNDARY_DECLINED: "control",
  FLOW_ANSWER_RESENT: "control",
};

/**
 * Whether this refusal spends one of the boundary's three attempts.
 *
 * A code the table does not classify spends, deliberately: the cap is the only
 * thing standing between a run and an infinite loop, and a silent exemption would
 * remove it for whatever was added last. The table is a closed set precisely so
 * this default is never reached — a guard walks the sources and refuses a code
 * nobody placed on one side or the other.
 */
export function spendsAttempt(code: string): boolean {
  const classified = FLOW_ANSWER_REJECTIONS[code];
  return classified === undefined || classified === "evaluated";
}

export interface ParseAnswerInput {
  raw: string;
  boundary: FlowBoundaryKind;
  decision: FlowDecision;
  /** Seal of the boundary in force: the answer has to quote it back verbatim. */
  seal: string;
  /** The alternatives the directive emitted, at a choosing boundary. */
  choices: readonly FlowChoice[];
  /** `--approval <digest>`, and the digest the boundary actually demands. */
  approval: string | null;
  expectedApproval: string | null;
  /** The sealed action, at an `execution` boundary: what the result is about. */
  action?: DelegatedAction | null;
  /**
   * The request this boundary emitted, at an authoring boundary that proposes.
   *
   * Passed in rather than rebuilt because the allowed destinations and the limits
   * the artifacts get checked against have to be the ones the sender was SHOWN:
   * validating against a freshly derived request would let the two drift, and the
   * write boundary is exactly the thing that must not.
   */
  request?: SemanticRequest | null;
}

export function parseFlowAnswer(input: ParseAnswerInput): FlowAnswerParse {
  const payload = readPayload(input.raw);
  if (!payload.ok) return payload;
  const body = payload.value;

  const seal = checkSeal(body, input);
  if (seal !== null) return { ok: false, failure: seal };

  switch (input.boundary) {
    case "semantic":
      return semanticAnswer(body, input);
    case "human":
      return choiceAnswer(body, input);
    case "authorization":
      return approvalAnswer(body, input);
    case "execution":
      return executionAnswer(body, input);
    default:
      return {
        ok: false,
        failure: {
          code: "FLOW_ANSWER_NOT_EXPECTED",
          message: `la frontera vigente es '${input.boundary}' y no espera una respuesta`,
          action:
            input.boundary === "final"
              ? "el recorrido terminó: no hay nada que contestar"
              : "resolvé el bloqueo y volvé a correr 'aw flow advance'",
        },
      };
  }
}

function readPayload(
  raw: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; failure: CapabilityFailure } {
  if (raw.trim().length === 0) {
    return {
      ok: false,
      failure: {
        code: "FLOW_ANSWER_MISSING",
        message: "no llegó ninguna respuesta por stdin",
        action: "volvé a invocar 'aw flow submit' pasando el JSON de respuesta por stdin",
      },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, failure: invalid("la respuesta no es JSON válido") };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, failure: invalid("la respuesta no es un único objeto JSON") };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * The staleness seal: the boundary moved between the directive and this answer.
 *
 * Recalculating and refusing is the only safe move — the inventory, the state and
 * the alternatives the sender reasoned over are gone.
 */
function checkSeal(
  body: Record<string, unknown>,
  input: ParseAnswerInput,
): CapabilityFailure | null {
  const given = body.input_digest;
  if (typeof given !== "string" || given.length === 0) {
    return invalid("la respuesta no trae el 'input_digest' de la frontera que contesta");
  }
  if (given !== input.seal) {
    return {
      code: "FLOW_ANSWER_STALE",
      message: "la respuesta contesta a un estado anterior de la corrida",
      action: "volvé a correr 'aw flow advance' y respondé sobre la frontera recalculada",
    };
  }
  return null;
}

/**
 * The flow control this body carries, or `null`.
 *
 * Its own function so the semantic parse does not grow one more shape to reason
 * about: `choice` is a control only when the label is one the run already knows
 * how to honour, and anything else is not a control at all.
 */
function flowControlOf(body: Record<string, unknown>): string | null {
  const choice = body.choice;
  if (typeof choice !== "string") return null;
  return isFlowControl(choice) ? choice : null;
}

function semanticAnswer(body: Record<string, unknown>, input: ParseAnswerInput): FlowAnswerParse {
  const proposes = proposalContractOf(input.decision);
  const declared = new Set(input.decision.signals ?? []);
  const raw = body.signals;
  const issues: { failure: CapabilityFailure; violation: Violation }[] = [];
  if (raw !== undefined && !isStringArray(raw)) {
    issues.push(
      violation(
        invalid("'signals' tiene que ser una lista de identificadores"),
        "signals",
        "string[]",
        raw,
      ),
    );
  }
  const signals = isStringArray(raw) ? raw : [];
  const decisions = body.decisions;
  if (decisions !== undefined && !isRecord(decisions)) {
    issues.push(
      violation(invalid("'decisions' tiene que ser un objeto"), "decisions", "objeto", decisions),
    );
  }
  // A flow control IS an answer, including here. It used to die on the emptiness
  // check below — a semantic boundary demands signals or decisions — and
  // `FLOW_ANSWER_AMBIGUOUS` is an EVALUATED rejection, so asking to compact cost
  // an attempt at exactly the boundary somebody was trying to pause.
  const control = flowControlOf(body);
  const substance =
    issues.length > 0
      ? null
      : checkSubstance(body, {
          decision: input.decision,
          signals,
          decisions,
          proposes: proposes !== null,
          control,
        });
  if (substance !== null)
    issues.push(
      violation(substance, "artifacts", "respuesta con contenido para la frontera", body.artifacts),
    );
  const artifacts = proposes === null ? EMPTY : parseArtifacts(body.artifacts, input);
  if (!Array.isArray(artifacts))
    issues.push(
      violation(artifacts.failure, "artifacts", "lista de {path, content}", body.artifacts),
    );
  appendSignalIssues(signals, declared, issues);
  if (issues.length > 0) return { ok: false, failure: collected(issues) };
  return {
    ok: true,
    answer: {
      input_digest: body.input_digest as string,
      signals,
      decisions: isRecord(decisions) ? decisions : {},
      // Carried so `submit` can recognize the pause or the stop it already knows
      // how to honour. Anything that is not a control stays `null`: a semantic
      // boundary has no alternatives of its own to pick from.
      choice: control,
      result: null,
      artifacts: artifacts as SemanticArtifact[],
    },
  };
}

const EMPTY: SemanticArtifact[] = [];

function checkAnswerContract(
  decision: FlowDecision,
  decisions: unknown,
  control: string | null,
): CapabilityFailure | null {
  if (control !== null || decision.answer_contract !== "batch-review") return null;
  if (isRecord(decisions) && isBatchReview(decisions.review)) return null;
  return {
    code: "PLAN_EXEC_BATCH_REVIEW_INVALID",
    message:
      "la revisión del lote falta o no demuestra un revisor distinto y cada corrección revisada",
    action: BATCH_REVIEW_CONTRACT,
  };
}

/**
 * Whether the answer says anything the CLI can act on — and the right thing.
 *
 * Three refusals, and each names a different way an answer can be empty for the
 * boundary it is answering. An authoring boundary asked for BYTES, so signals and
 * decisions do not substitute for them: advancing without the proposal would walk
 * the run into a confirmation with nothing to preview and an approval with
 * nothing to grant over. And a boundary that proposes nothing accepts no
 * artifacts at all — bytes with no declared destination, no effect class and
 * nobody to approve them are precisely the write this contract forbids.
 */
function checkSubstance(
  body: Record<string, unknown>,
  answered: {
    decision: FlowDecision;
    signals: readonly string[];
    decisions: unknown;
    proposes: boolean;
    control: string | null;
  },
): CapabilityFailure | null {
  const contract = checkAnswerContract(answered.decision, answered.decisions, answered.control);
  if (contract !== null) return contract;
  const hasArtifacts = Array.isArray(body.artifacts) && body.artifacts.length > 0;
  if (hasArtifacts && !answered.proposes) {
    return {
      code: "FLOW_ARTIFACTS_NOT_EXPECTED",
      message: "esta frontera no propone ningún efecto local y no admite artefactos",
      action: "contestá con lo que el contrato pide; los bytes se entregan donde el CLI los pide",
    };
  }
  if (answered.proposes && !hasArtifacts) {
    return {
      code: "FLOW_ARTIFACTS_MISSING",
      message: "esta frontera pide los bytes exactos y la respuesta no trae ninguno",
      action:
        "devolvé en 'artifacts' cada archivo con su 'path' y su 'content'; sin propuesta no hay nada que previsualizar ni que aprobar",
    };
  }
  const decisions = answered.decisions;
  const empty =
    answered.control === null &&
    answered.signals.length === 0 &&
    !hasArtifacts &&
    (decisions === undefined || Object.keys(decisions as Record<string, unknown>).length === 0);
  if (!empty) return null;
  return {
    code: "FLOW_ANSWER_AMBIGUOUS",
    message: "la respuesta no declara ninguna señal ni ninguna decisión",
    action:
      "declarás las señales que observás en 'signals', o lo que el contrato pide en 'decisions'",
  };
}

/**
 * The proposed bytes, checked by the SAME rules the semantic protocol applies.
 *
 * Destination allowlist, duplicates and size limits all come from the request the
 * boundary emitted, through `parseSemanticArtifacts` — reused rather than
 * restated, because a second path check is how one entry point ends up enforcing
 * the write boundary and the other not.
 *
 * What comes back is path and content and nothing else. Whether a destination
 * already exists — and therefore whether writing it REPLACES something — is a
 * fact about the workspace, so it is observed where the workspace is readable and
 * never asserted by the sender: a preview that said "creates" because somebody
 * typed so would be the one line of it a person most needs to trust.
 */
function parseArtifacts(
  raw: unknown,
  input: ParseAnswerInput,
): SemanticArtifact[] | { failure: CapabilityFailure } {
  const request = input.request ?? null;
  if (request === null) {
    return {
      failure: {
        code: "FLOW_ARTIFACTS_NOT_EXPECTED",
        message: "la frontera propone efectos locales pero no emitió su contrato de destinos",
        action: "volvé a correr 'aw flow advance' para recibir la frontera con su request vigente",
      },
    };
  }
  const parsed = parseSemanticArtifacts(raw, request);
  if (!parsed.ok) {
    const individual = Array.isArray(raw)
      ? raw.flatMap((entry, index) => {
          const checked = parseSemanticArtifacts([entry], request);
          return checked.ok
            ? []
            : [
                violation(
                  checked.failure,
                  `artifacts[${index}]`,
                  "{path: ruta permitida, content: string}",
                  entry,
                ).violation,
              ];
        })
      : [];
    return {
      failure: {
        code: parsed.failure.code,
        message: parsed.failure.message,
        action: parsed.failure.action,
        violations:
          individual.length > 0
            ? individual
            : [violation(parsed.failure, "artifacts", "lista de {path, content}", raw).violation],
      },
    };
  }
  return parsed.value;
}

function choiceAnswer(body: Record<string, unknown>, input: ParseAnswerInput): FlowAnswerParse {
  const choice = body.choice;
  if (typeof choice !== "string" || choice.trim().length === 0) {
    return {
      ok: false,
      failure: {
        code: "FLOW_ANSWER_AMBIGUOUS",
        message: "una frontera humana espera 'choice' con la etiqueta elegida",
        action: `elegí una de: ${input.choices.map((c) => c.label).join(" | ")}`,
      },
    };
  }
  if (!input.choices.some((candidate) => candidate.label === choice)) {
    return {
      ok: false,
      failure: {
        code: "FLOW_CHOICE_UNKNOWN",
        message: `'${choice}' no es una de las alternativas emitidas`,
        action: `elegí una de: ${input.choices.map((c) => c.label).join(" | ")}`,
      },
    };
  }
  const decisions = body.decisions;
  if (decisions !== undefined && !isRecord(decisions)) {
    return { ok: false, failure: invalid("'decisions' tiene que ser un objeto") };
  }
  return {
    ok: true,
    answer: {
      input_digest: body.input_digest as string,
      signals: [],
      // A typed human route may carry the prepared decision draft. Keeping it
      // through the parser is what lets the gate commit exactly that preview;
      // discarding it here used to make every choice look like "continue".
      decisions: isRecord(decisions) ? decisions : {},
      choice,
      result: null,
      artifacts: EMPTY,
    },
  };
}

/**
 * An authorization boundary needs the approval over the EXACT effects it named.
 *
 * The digest travels apart, in `--approval`, for the same reason the semantic
 * protocol seals its artifacts: what was approved has to be what gets exercised.
 */
function approvalAnswer(body: Record<string, unknown>, input: ParseAnswerInput): FlowAnswerParse {
  const choice = typeof body.choice === "string" ? body.choice : null;
  if (choice !== null && !input.choices.some((candidate) => candidate.label === choice)) {
    return {
      ok: false,
      failure: {
        code: "FLOW_CHOICE_UNKNOWN",
        message: `'${choice}' no es una de las alternativas emitidas`,
        action: `elegí una de: ${input.choices.map((c) => c.label).join(" | ")}`,
      },
    };
  }
  const accepted = {
    ok: true as const,
    answer: {
      input_digest: body.input_digest as string,
      signals: [],
      decisions: {},
      choice,
      result: null,
      artifacts: EMPTY,
    },
  };
  // The FLOW CONTROL needs no approval, and demanding one would be absurd: it
  // would ask the person to hand over the very approval they are declining to
  // give, or make pausing conditional on granting it. Both emitted alternatives
  // have to be answerable, or they are not alternatives.
  if (isFlowControl(choice)) return accepted;

  if (input.approval === null) {
    return {
      ok: false,
      failure: {
        code: "FLOW_APPROVAL_MISSING",
        message: "esta frontera necesita una aprobación de efecto y no llegó ninguna",
        action: `volvé a invocar con --approval ${input.expectedApproval ?? "<digest>"}, o respondé '${STOP_LABEL}' para cerrar la sesión conservando lo pendiente sin autorizar ese efecto`,
      },
    };
  }
  if (input.approval !== input.expectedApproval) {
    return {
      ok: false,
      failure: {
        code: "FLOW_APPROVAL_MISMATCH",
        message: "la aprobación no corresponde a los efectos que esta frontera nombró",
        action: `la aprobación de esta frontera es --approval ${input.expectedApproval ?? "<digest>"}`,
      },
    };
  }
  return accepted;
}

/**
 * The result of a delegated invocation, read as DATA.
 *
 * Three things are checked here, in this order, and none of them is a matter of
 * degree: it has to be a result at all (the receipt's outcome vocabulary), it has
 * to say what was actually run, and what was run has to be what the directive
 * sealed. A payload that claims success without naming an invocation — the
 * `confirmed: true` shape — dies on the second check, which is the one that makes
 * "the caller declared success without executing anything" impossible to express.
 *
 * Whether the result is good ENOUGH to apply the transition is not decided here:
 * evidence coverage and partial effects are verdicts, and they belong where the
 * recovery action lives.
 */
function executionAnswer(body: Record<string, unknown>, input: ParseAnswerInput): FlowAnswerParse {
  const action = input.action ?? null;
  if (action === null) {
    return { ok: false, failure: badResult("esta frontera no declara ninguna acción delegada") };
  }
  const issues: { failure: CapabilityFailure; violation: Violation }[] = [];
  const add = (failure: CapabilityFailure, field: string, expected: string, value: unknown) => {
    issues.push(violation(failure, field, expected, value));
  };
  const outcome = body.outcome;
  appendOutcomeIssues(body, outcome, add);
  const invocation = readInvocation(body.invocation);
  if (invocation === null) {
    add(
      {
        code: "FLOW_RESULT_INVALID",
        message: `el resultado no declara la invocación que se ejecutó: invocation espera {program: string, args: string[], target: string, input: string|null}; recibió ${Array.isArray(body.invocation) ? "lista" : typeof body.invocation}`,
        action:
          "devolvé 'invocation' con el programa, los argumentos y el target que corriste: sin eso, nada distingue una ejecución de una afirmación",
      },
      "invocation",
      "{program, args, target, input}",
      body.invocation,
    );
  } else {
    const mismatch = invocationMismatch(action.invocation, invocation);
    if (mismatch !== null)
      add(
        {
          code: "FLOW_ACTION_MISMATCH",
          message: `el resultado corresponde a otra invocación: ${mismatch}`,
          action: `ejecutá exactamente '${[action.invocation.program, ...action.invocation.args].join(" ")}' en ${action.invocation.target} y devolvé su resultado`,
        },
        "invocation",
        "invocación sellada",
        body.invocation,
      );
  }
  const read = readValidations(body.validations, action.evidence);
  if (!read.ok) {
    issues.push(...read.issues);
  }
  const effects = readLedger(
    body.effects,
    outcome === "completed" ? effectsOf(input.decision) : [],
  );
  if (effects === null) {
    appendEffectsIssue(body.effects, add);
  }
  const output = readOutput(body.output);
  if (output === undefined) {
    add(
      badResult("'output' tiene que ser un OperationOutput o null"),
      "output",
      "OperationOutput | null",
      body.output,
    );
  }
  if (issues.length > 0) return { ok: false, failure: collected(issues) };
  return {
    ok: true,
    answer: {
      input_digest: body.input_digest as string,
      signals: [],
      decisions: {},
      choice: null,
      result: {
        outcome: outcome as CapabilityOutcome,
        invocation: invocation as DelegatedInvocation,
        output: output as OperationOutput | null,
        validations: read.ok ? read.validations : [],
        effects: effects as EffectLedger,
      },
      artifacts: EMPTY,
    },
  };
}

/**
 * Why a result carries no `outcome`, said as the thing to fix.
 *
 * A missing field and a field outside the vocabulary answered the same sentence,
 * and that sentence described only the second one. The cost was measured, not
 * imagined: a host that had nested its whole result under `execution` read
 * "'outcome' has to be one of …", corrected the VALUE exactly as instructed, kept
 * the envelope, got the identical message back, and burned its remaining attempts
 * before abandoning the session. A diagnostic that names the wrong field turns an
 * obedient executor into a loop.
 *
 * The envelope is NAMED when one is really there rather than guessed from a list
 * of likely words: any top-level value that is itself a record carrying `outcome`
 * is the wrapper, whatever it was called. Wrapping is the natural wrong guess —
 * the directive the reader just answered carries an `action.execution` object of
 * its own — so pointing straight at it costs one line and saves the loop.
 */
function missingOutcome(body: Record<string, unknown>): string {
  const wrapper = Object.entries(body).find(
    ([, value]) => isRecord(value) && "outcome" in value,
  )?.[0];
  const where =
    wrapper === undefined
      ? "el resultado no trae 'outcome'"
      : `el resultado trae su 'outcome' anidado dentro de '${wrapper}'`;
  return `${where}: los campos del resultado van en el nivel superior del JSON, no envueltos en otro objeto`;
}

/**
 * Why the validations list was rejected — as the shape to send, not as a type name.
 *
 * The message this replaced said "'validations' has to be the list of
 * ValidationOutcome of the result". `ValidationOutcome` is a TypeScript type: it
 * appears in no document the caller can read, and the sentence never states the
 * three keys or the ids the boundary demands. The cost was measured, and it is
 * the largest this defect class has produced: one host opened ELEVEN throwaway
 * sessions whose declared objective was "discover the contract of `aw flow
 * submit`", all eleven stalling at the same boundary; a second host, independently
 * and without seeing the first, made the same wrong guess. Both sent `name` where
 * the parser wants `id` and `evidence` where it wants `detail` — not bad guesses
 * so much as guesses with nothing to read.
 *
 * So the message names the shape, lists the evidence ids THIS boundary declared,
 * and — the part that ends the loop — reports the keys the offending entry
 * actually carries. "It does not bring 'id' (it brings: name, passed, evidence)"
 * turns a search into a rename. Reporting the real keys instead of matching a
 * table of likely aliases keeps it honest: it describes what arrived rather than
 * guessing what was meant.
 */
function badValidations(value: unknown, evidence: readonly string[]): string {
  const pedidas = evidence.length > 0 ? ` (${evidence.join(", ")})` : "";
  const shape = `una lista de objetos {id, passed, detail}, uno por cada evidencia que esta frontera pide${pedidas}`;
  if (!Array.isArray(value)) return `'validations' tiene que ser ${shape}`;
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return `la validación ${index + 1} no es un objeto; se espera ${shape}`;
    const keys = Object.keys(entry);
    const seen = keys.length > 0 ? ` (trae: ${keys.join(", ")})` : " (viene vacía)";
    if (typeof entry.id !== "string")
      return `la validación ${index + 1} no trae 'id': validations[${index}].id espera string; recibió ${typeof entry.id}${seen}`;
    if (typeof entry.passed !== "boolean") {
      return `validations[${index}].passed espera boolean; recibió ${typeof entry.passed}${seen}`;
    }
    if (entry.detail !== undefined && entry.detail !== null && typeof entry.detail !== "string") {
      return `validations[${index}].detail espera string o null; recibió ${typeof entry.detail}: ahí va la salida real del comando`;
    }
  }
  return `'validations' tiene que ser ${shape}`;
}

/** Which field of the invocation differs, in the order a reader would check them. */
function invocationMismatch(sealed: DelegatedInvocation, ran: DelegatedInvocation): string | null {
  if (sealed.program !== ran.program)
    return `programa '${ran.program}' en vez de '${sealed.program}'`;
  if (sealed.args.length !== ran.args.length || sealed.args.some((arg, i) => arg !== ran.args[i])) {
    return `argumentos '${ran.args.join(" ")}' en vez de '${sealed.args.join(" ")}'`;
  }
  if (resolve(sealed.target) !== resolve(ran.target))
    return `target '${ran.target}' en vez de '${sealed.target}'`;
  if ((sealed.input ?? null) !== (ran.input ?? null)) return "otro input";
  return null;
}

function readInvocation(value: unknown): DelegatedInvocation | null {
  if (!isRecord(value)) return null;
  if (typeof value.program !== "string" || value.program.trim().length === 0) return null;
  if (!isStringArray(value.args)) return null;
  if (typeof value.target !== "string" || value.target.trim().length === 0) return null;
  const input = value.input === undefined ? null : value.input;
  if (input !== null && typeof input !== "string") return null;
  return { program: value.program, args: value.args, target: value.target, input };
}

/**
 * A container defect and a nested proof defect keep their own codes, even when
 * several independent fields in the same list need correcting.
 */
type ValidationsRead =
  | { ok: true; validations: ValidationOutcome[] }
  | { ok: false; issues: { failure: CapabilityFailure; violation: Violation }[] };

function readValidations(value: unknown, evidence: readonly string[]): ValidationsRead {
  if (value === undefined) return { ok: true, validations: [] };
  const bad = () => badResult(badValidations(value, evidence));
  if (!Array.isArray(value))
    return {
      ok: false,
      issues: [violation(bad(), "validations", "lista de {id, passed, detail}", value)],
    };
  const out: ValidationOutcome[] = [];
  const issues: { failure: CapabilityFailure; violation: Violation }[] = [];
  const add = (failure: CapabilityFailure, field: string, expected: string, received: unknown) => {
    issues.push(violation(failure, field, expected, received));
  };
  for (const [index, entry] of value.entries()) {
    appendValidationEntry(entry, index, bad, add, out);
  }
  return issues.length === 0 ? { ok: true, validations: out } : { ok: false, issues };
}

/**
 * Why a nested `CheckoutProof` was refused, in the terms a fix needs.
 *
 * The knowledge was always here — the reader below has always known which fields
 * each `kind` requires. What it used to do with that knowledge was throw it away
 * and return `null`, which discarded the WHOLE `validations` list and made the
 * envelope report a malformed container. The list was fine; the proof was not.
 */
interface ProofShapeDefect {
  /** The `kind` the proof declared, or `null` when it is not one this contract has. */
  kind: string | null;
  /** The fields that `kind` requires — what a corrective edit has to produce. */
  expected: readonly string[];
  /** The keys that actually arrived, so the fix is a rename and not a search. */
  received: readonly string[];
  /** Which half is wrong, so the message does not blame the whole object. */
  where: "kind" | "proof" | "invocation";
}

type ProofRead = { ok: true; proof: CheckoutProof } | { ok: false; defect: ProofShapeDefect };

/** The fields each `kind` demands of its `invocation`, named once. */
const PROOF_INVOCATION_FIELDS: Readonly<Record<"command" | "inspection", readonly string[]>> = {
  command: ["program", "args"],
  inspection: ["artifact"],
};

const PROOF_FIELDS = ["kind", "source", "relative_cwd", "checkout_digest", "invocation"] as const;

function readCheckoutProof(value: unknown): ProofRead {
  if (!isRecord(value)) {
    return {
      ok: false,
      defect: { kind: null, expected: [...PROOF_FIELDS], received: [], where: "proof" },
    };
  }
  const declared = typeof value.kind === "string" ? value.kind : null;
  if (value.kind !== "command" && value.kind !== "inspection") {
    // Its own case, because a misspelled kind used to produce a message whose
    // expected and received lists were byte-identical — the reader was told the
    // shape was wrong and shown the shape they had sent. A typo is the likeliest
    // way to get here, so it is the case that most needs a usable sentence.
    return {
      ok: false,
      defect: {
        kind: declared,
        expected: ["command", "inspection"],
        received: declared === null ? [] : [declared],
        where: "kind",
      },
    };
  }
  const expected = [
    ...PROOF_FIELDS,
    ...PROOF_INVOCATION_FIELDS[value.kind].map((f) => `invocation.${f}`),
  ];
  if (
    typeof value.source !== "string" ||
    typeof value.relative_cwd !== "string" ||
    typeof value.checkout_digest !== "string" ||
    !isRecord(value.invocation)
  ) {
    return {
      ok: false,
      defect: { kind: value.kind, expected, received: Object.keys(value), where: "proof" },
    };
  }
  const invocation = value.invocation;
  if (value.kind === "command") {
    if (typeof invocation.program !== "string" || !isStringArray(invocation.args)) {
      return {
        ok: false,
        defect: {
          kind: "command",
          expected: PROOF_INVOCATION_FIELDS.command,
          received: Object.keys(invocation),
          where: "invocation",
        },
      };
    }
    return {
      ok: true,
      proof: {
        kind: "command",
        source: value.source,
        relative_cwd: value.relative_cwd,
        checkout_digest: value.checkout_digest,
        invocation: { program: invocation.program, args: invocation.args },
      },
    };
  }
  if (typeof invocation.artifact !== "string") {
    return {
      ok: false,
      defect: {
        kind: "inspection",
        expected: PROOF_INVOCATION_FIELDS.inspection,
        received: Object.keys(invocation),
        where: "invocation",
      },
    };
  }
  return {
    ok: true,
    proof: {
      kind: "inspection",
      source: value.source,
      relative_cwd: value.relative_cwd,
      checkout_digest: value.checkout_digest,
      invocation: { artifact: invocation.artifact },
    },
  };
}

/**
 * The proof's own rejection — never the container's.
 *
 * `FLOW_RESULT_INVALID` is reserved for a result or a `validations` list that
 * breaks its OWN shape. Spending it on a diagnosable nested proof sent readers to
 * rebuild a list that was already correct.
 */
function proofShapeFailure(defect: ProofShapeDefect): CapabilityFailure {
  const received =
    defect.received.length > 0 ? `trae: ${defect.received.join(", ")}` : "viene vacía";
  const message =
    defect.where === "kind"
      ? `el 'proof' declara kind ${defect.kind === null ? "ninguno" : `'${defect.kind}'`}, que no existe: los kinds son 'command' (pide invocation {program, args}) e 'inspection' (pide invocation {artifact})`
      : defect.where === "invocation"
        ? `el 'proof' de kind '${defect.kind}' trae una 'invocation' que ese kind no acepta: espera ${defect.expected.join(", ")} y ${received}`
        : `el 'proof' de kind '${defect.kind ?? "(ausente)"}' no satisface la forma de su kind: espera ${defect.expected.join(", ")} (${received})`;
  return {
    code: "WORKLINE_CHECKOUT_PROOF_SHAPE_INVALID",
    message,
    action:
      "corregí el 'proof' anidado, no la lista 'validations': un kind 'command' pide {program, args} y un 'inspection' pide {artifact} — sin 'target' ni 'input', aunque la directiva los traiga. 'aw flow prove' lo produce ya bien formado y sin gastar intento",
  };
}

function readLedger(
  value: unknown,
  defaultApplied: readonly EffectClass[] = [],
): EffectLedger | null {
  if (!isRecord(value)) return null;
  const planned = readEffectClasses(value.planned);
  const approved = readEffectClasses(value.approved);
  const applied =
    value.applied === undefined ? [...defaultApplied] : readEffectClasses(value.applied);
  if (planned === null || approved === null || applied === null) return null;
  return { planned, approved, applied };
}

function readEffectClasses(value: unknown): EffectClass[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isEffectClass)) return null;
  return value;
}

/** `undefined` means malformed; `null` means legitimately absent. */
function readOutput(value: unknown): OperationOutput | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  const completeness = value.completeness ?? null;
  if (
    completeness !== null &&
    !(COMPLETENESS_VALUES as readonly unknown[]).includes(completeness)
  ) {
    return undefined;
  }
  const reference = readReference(value.reference);
  if (reference === undefined) return undefined;
  return {
    value: value.value === undefined ? null : value.value,
    reference,
    completeness: completeness as Completeness | null,
  };
}

/** `undefined` means malformed; `null` means the output referenced nothing durable. */
function readReference(value: unknown): DurableReference | null | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) return undefined;
  if (typeof value.id !== "string" || typeof value.digest !== "string") return undefined;
  if (typeof value.locator !== "string") return undefined;
  const revision = value.revision ?? null;
  if (revision !== null && !Number.isInteger(revision)) return undefined;
  return {
    id: value.id,
    revision: revision as number | null,
    digest: value.digest,
    locator: value.locator,
  };
}

/**
 * The seal the payload CLAIMS to answer, read before anything is validated.
 *
 * The resend check needs it first: a resend of an answer that was already applied
 * quotes the seal of a boundary the run has since left, so judging staleness
 * before consulting the attempt history would report "stale" for what is really
 * "already applied" — and the two have different next actions.
 */
export function claimedSeal(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    return typeof parsed.input_digest === "string" ? parsed.input_digest : null;
  } catch {
    return null;
  }
}

/**
 * A payload that is well-formed JSON and still is not an execution RESULT.
 *
 * Its own code, apart from `FLOW_ANSWER_INVALID`, because the fix is different:
 * the sender did not mistype a field, they sent an assertion where the contract
 * demands what the tool produced.
 */
function badResult(message: string): CapabilityFailure {
  return {
    code: "FLOW_RESULT_INVALID",
    message,
    action:
      "devolvé el resultado real de la invocación: 'outcome', la 'invocation' que corriste, sus 'validations' con la salida en 'detail' y su 'effects'",
  };
}

function invalid(message: string): CapabilityFailure {
  return {
    code: "FLOW_ANSWER_INVALID",
    message,
    action: "corregí la respuesta según el 'contract' de la directiva y reenviala",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function appendSignalIssues(
  signals: string[],
  declared: Set<string>,
  issues: { failure: CapabilityFailure; violation: Violation }[],
): void {
  for (const signal of signals) {
    if (declared.has(signal)) continue;
    const failure = {
      code: "FLOW_SIGNAL_UNKNOWN",
      message: `'${signal}' no está en el vocabulario que esta frontera admite`,
      action: `declarás solo: ${[...declared].join(", ") || "(ninguna señal en esta frontera)"}`,
    };
    issues.push(violation(failure, "signals", [...declared].join(" | ") || "ninguna", signal));
  }
  if (new Set(signals).size !== signals.length) {
    issues.push(
      violation(
        invalid("la misma señal viene declarada dos veces"),
        "signals",
        "identificadores únicos",
        signals,
      ),
    );
  }
}

type AddAnswerIssue = (
  failure: CapabilityFailure,
  field: string,
  expected: string,
  value: unknown,
) => void;
function appendOutcomeIssues(
  body: Record<string, unknown>,
  outcome: unknown,
  add: AddAnswerIssue,
): void {
  // Absent and out-of-vocabulary are DIFFERENT failures and no longer share a
  // sentence. They used to, and the sentence described only the second one.
  if (outcome === undefined) {
    add(badResult(missingOutcome(body)), "outcome", CAPABILITY_OUTCOMES.join(" | "), outcome);
  } else if (
    typeof outcome !== "string" ||
    !(CAPABILITY_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    add(
      badResult(
        `'outcome' tiene que ser uno de: ${CAPABILITY_OUTCOMES.join(", ")} — una confirmación booleana o una narración no son un resultado`,
      ),
      "outcome",
      CAPABILITY_OUTCOMES.join(" | "),
      outcome,
    );
  }
}

function appendEffectsIssue(ledger: unknown, add: AddAnswerIssue): void {
  const field = isRecord(ledger) && ledger.applied !== undefined ? "effects.applied" : "effects";
  const unknown =
    isRecord(ledger) && Array.isArray(ledger.applied)
      ? ledger.applied.find((effect) => !isEffectClass(effect))
      : undefined;
  add(
    badResult(
      unknown === undefined
        ? "'effects' tiene que traer el registro planned/approved/applied del resultado"
        : `'effects.applied' trae la clase ${JSON.stringify(unknown)}; las válidas son ${EFFECT_CLASSES.join(", ")}`,
    ),
    field,
    "{planned: EffectClass[], approved: EffectClass[], applied: EffectClass[]}",
    field === "effects" ? ledger : (ledger as Record<string, unknown>).applied,
  );
}

function appendValidationEntry(
  entry: unknown,
  index: number,
  bad: () => CapabilityFailure,
  add: AddAnswerIssue,
  out: ValidationOutcome[],
): void {
  if (!isRecord(entry)) {
    add(bad(), `validations[${index}]`, "{id, passed, detail}", entry);
    return;
  }
  const field = `validations[${index}]`;
  if (typeof entry.id !== "string") {
    add(bad(), `${field}.id`, "string", entry.id);
  }
  if (typeof entry.passed !== "boolean") {
    add(bad(), `${field}.passed`, "boolean", entry.passed);
  }
  const detail = entry.detail === undefined ? null : entry.detail;
  if (detail !== null && typeof detail !== "string") {
    add(bad(), `${field}.detail`, "string | null", detail);
  }
  if (entry.proof === undefined || entry.proof === null) {
    const outcome = validationFields(entry, detail);
    if (outcome !== null) out.push(outcome);
    return;
  }
  const read = readCheckoutProof(entry.proof);
  if (!read.ok) {
    const failure = proofShapeFailure(read.defect);
    const suffix = read.defect.where === "proof" ? "" : `.${read.defect.where}`;
    add(failure, `${field}.proof${suffix}`, read.defect.expected.join(" | "), entry.proof);
    return;
  }
  const outcome = validationFields(entry, detail);
  if (outcome !== null) out.push({ ...outcome, proof: read.proof });
}

function validationFields(
  entry: Record<string, unknown>,
  detail: unknown,
): ValidationOutcome | null {
  if (
    typeof entry.id !== "string" ||
    typeof entry.passed !== "boolean" ||
    (detail !== null && typeof detail !== "string")
  )
    return null;
  return { id: entry.id, passed: entry.passed, detail };
}
