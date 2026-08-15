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

import type {
  SemanticArtifact,
  SemanticRequest,
} from "../../application/semantic-operation/protocol.js";
import { parseSemanticArtifacts } from "../../application/semantic-operation/protocol.js";
import { COMPLETENESS_VALUES, type Completeness } from "../capability/descriptor.js";
import { type EffectClass, isEffectClass } from "../capability/effects.js";
import {
  CAPABILITY_OUTCOMES,
  type CapabilityFailure,
  type CapabilityOutcome,
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
  proposalContractOf,
} from "./authority.js";
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
 * - `evaluated` — the decision arrived and did not resolve the gap. A signal
 *   outside the declared vocabulary, a label that is not one of the emitted
 *   alternatives, an approval over other effects or none at all, a result about a
 *   different invocation, an execution that did not complete or left its effect
 *   half-applied, a scope naming sources the workspace or the plan does not, a
 *   proposal reaching past what its row declares — and an answer that declares
 *   nothing at all, which is the feigned convergence the chassis degrades and
 *   exactly what the cap is for.
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
  FLOW_ANSWER_AMBIGUOUS: "evaluated",
  FLOW_SIGNAL_UNKNOWN: "evaluated",
  FLOW_CHOICE_UNKNOWN: "evaluated",
  FLOW_APPROVAL_MISSING: "evaluated",
  FLOW_APPROVAL_MISMATCH: "evaluated",
  FLOW_ACTION_MISMATCH: "evaluated",
  // The execution verdict's own vocabulary: it judges a result that WAS read.
  FLOW_EXECUTION_NOT_COMPLETED: "evaluated",
  FLOW_EVIDENCE_MISSING: "evaluated",
  WORKLINE_CHECKOUT_PROOF_MISSING: "evaluated",
  WORKLINE_CHECKOUT_PROOF_INVALID: "evaluated",
  WORKLINE_CHECKOUT_PROOF_STALE: "evaluated",
  FLOW_EFFECT_PARTIAL: "evaluated",
  // The scope boundary's own vocabulary. Its answer is `decisions.sources` plus
  // `decisions.plan`, and every one of these means the CLI read them and found
  // them wanting — a decision that did not resolve the gap.
  FLOW_SCOPE_INVALID: "evaluated",
  FLOW_SCOPE_UNKNOWN_SOURCE: "evaluated",
  FLOW_SCOPE_NOT_IN_PLAN: "evaluated",
  FLOW_SCOPE_PLAN_UNREADABLE: "evaluated",
  // The submitted scope named a plan and the CLI read it, but its location
  // violates the canonical documentation boundary.
  FLOW_SCOPE_PLAN_OUTSIDE_CANON: "evaluated",
  PLAN_SOURCE_BOUNDARY_MISSING: "evaluated",
  PLAN_SOURCE_UNKNOWN: "evaluated",
  PLAN_TASK_SOURCE_OUTSIDE_PHASE: "evaluated",
  PLAN_SOURCE_EXTERNAL_CLOSURE: "evaluated",
  PLAN_SOURCE_LOCAL_PROOF_MISSING: "evaluated",
  // The authoring boundary's: the bytes arrived and what they would do is not
  // what the row declares, or their destination could not be read.
  FLOW_PROPOSAL_BEYOND_CONTRACT: "evaluated",
  FLOW_PROPOSAL_DESTINATION_UNOBSERVED: "evaluated",
  FLOW_PROPOSAL_BASE_UNREADABLE: "evaluated",
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

function semanticAnswer(body: Record<string, unknown>, input: ParseAnswerInput): FlowAnswerParse {
  const proposes = proposalContractOf(input.decision);
  const declared = new Set(input.decision.signals ?? []);
  const raw = body.signals;
  if (raw !== undefined && !isStringArray(raw)) {
    return { ok: false, failure: invalid("'signals' tiene que ser una lista de identificadores") };
  }
  const signals = raw ?? [];
  const decisions = body.decisions;
  if (decisions !== undefined && !isRecord(decisions)) {
    return { ok: false, failure: invalid("'decisions' tiene que ser un objeto") };
  }
  const substance = checkSubstance(body, { signals, decisions, proposes: proposes !== null });
  if (substance !== null) return { ok: false, failure: substance };
  const artifacts = proposes === null ? EMPTY : parseArtifacts(body.artifacts, input);
  if (!Array.isArray(artifacts)) return { ok: false, failure: artifacts.failure };
  for (const signal of signals) {
    if (declared.has(signal)) continue;
    return {
      ok: false,
      failure: {
        code: "FLOW_SIGNAL_UNKNOWN",
        message: `'${signal}' no está en el vocabulario que esta frontera admite`,
        action: `declarás solo: ${[...declared].join(", ") || "(ninguna señal en esta frontera)"}`,
      },
    };
  }
  if (new Set(signals).size !== signals.length) {
    return { ok: false, failure: invalid("la misma señal viene declarada dos veces") };
  }
  return {
    ok: true,
    answer: {
      input_digest: body.input_digest as string,
      signals,
      decisions: isRecord(decisions) ? decisions : {},
      choice: null,
      result: null,
      artifacts,
    },
  };
}

const EMPTY: SemanticArtifact[] = [];

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
  answered: { signals: readonly string[]; decisions: unknown; proposes: boolean },
): CapabilityFailure | null {
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
    return {
      failure: {
        code: parsed.failure.code,
        message: parsed.failure.message,
        action: parsed.failure.action,
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
  return {
    ok: true,
    answer: {
      input_digest: body.input_digest as string,
      signals: [],
      decisions: {},
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
        action: `volvé a invocar con --approval ${input.expectedApproval ?? "<digest>"}, o respondé '${STOP_LABEL}' para no autorizarla`,
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
  const outcome = body.outcome;
  // Absent and out-of-vocabulary are DIFFERENT failures and no longer share a
  // sentence. They used to, and the sentence described only the second one.
  if (outcome === undefined) {
    return { ok: false, failure: badResult(missingOutcome(body)) };
  }
  if (
    typeof outcome !== "string" ||
    !(CAPABILITY_OUTCOMES as readonly string[]).includes(outcome)
  ) {
    return {
      ok: false,
      failure: badResult(
        `'outcome' tiene que ser uno de: ${CAPABILITY_OUTCOMES.join(", ")} — una confirmación booleana o una narración no son un resultado`,
      ),
    };
  }
  const invocation = readInvocation(body.invocation);
  if (invocation === null) {
    return {
      ok: false,
      failure: {
        code: "FLOW_RESULT_INVALID",
        message: "el resultado no declara la invocación que se ejecutó",
        action:
          "devolvé 'invocation' con el programa, los argumentos y el target que corriste: sin eso, nada distingue una ejecución de una afirmación",
      },
    };
  }
  const mismatch = invocationMismatch(action.invocation, invocation);
  if (mismatch !== null) {
    return {
      ok: false,
      failure: {
        code: "FLOW_ACTION_MISMATCH",
        message: `el resultado corresponde a otra invocación: ${mismatch}`,
        action: `ejecutá exactamente '${[action.invocation.program, ...action.invocation.args].join(" ")}' en ${action.invocation.target} y devolvé su resultado`,
      },
    };
  }
  const validations = readValidations(body.validations);
  if (validations === null) {
    return { ok: false, failure: badResult(badValidations(body.validations, action.evidence)) };
  }
  const effects = readLedger(body.effects);
  if (effects === null) {
    return {
      ok: false,
      failure: badResult(
        "'effects' tiene que traer el registro planned/approved/applied del resultado",
      ),
    };
  }
  const output = readOutput(body.output);
  if (output === undefined) {
    return { ok: false, failure: badResult("'output' tiene que ser un OperationOutput o null") };
  }
  return {
    ok: true,
    answer: {
      input_digest: body.input_digest as string,
      signals: [],
      decisions: {},
      choice: null,
      result: { outcome: outcome as CapabilityOutcome, invocation, output, validations, effects },
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
    if (typeof entry.id !== "string") return `la validación ${index + 1} no trae 'id'${seen}`;
    if (typeof entry.passed !== "boolean") {
      return `la validación '${entry.id}' no trae 'passed' booleano${seen}`;
    }
    if (entry.detail !== undefined && entry.detail !== null && typeof entry.detail !== "string") {
      return `la validación '${entry.id}' trae un 'detail' que no es texto: ahí va la salida real del comando`;
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
  if (sealed.target !== ran.target) return `target '${ran.target}' en vez de '${sealed.target}'`;
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

function readValidations(value: unknown): ValidationOutcome[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const out: ValidationOutcome[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (typeof entry.id !== "string" || typeof entry.passed !== "boolean") return null;
    const detail = entry.detail === undefined ? null : entry.detail;
    if (detail !== null && typeof detail !== "string") return null;
    const proof = entry.proof === undefined ? undefined : readCheckoutProof(entry.proof);
    if (proof === null) return null;
    out.push({
      id: entry.id,
      passed: entry.passed,
      detail,
      ...(proof !== undefined ? { proof } : {}),
    });
  }
  return out;
}

function readCheckoutProof(value: unknown): CheckoutProof | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "command" && value.kind !== "inspection") return null;
  if (
    typeof value.source !== "string" ||
    typeof value.relative_cwd !== "string" ||
    typeof value.checkout_digest !== "string" ||
    !isRecord(value.invocation)
  ) {
    return null;
  }
  const invocation = value.invocation;
  if (value.kind === "command") {
    if (typeof invocation.program !== "string" || !isStringArray(invocation.args)) return null;
    return {
      kind: "command",
      source: value.source,
      relative_cwd: value.relative_cwd,
      checkout_digest: value.checkout_digest,
      invocation: { program: invocation.program, args: invocation.args },
    };
  }
  if (typeof invocation.artifact !== "string") return null;
  return {
    kind: "inspection",
    source: value.source,
    relative_cwd: value.relative_cwd,
    checkout_digest: value.checkout_digest,
    invocation: { artifact: invocation.artifact },
  };
}

function readLedger(value: unknown): EffectLedger | null {
  if (!isRecord(value)) return null;
  const planned = readEffectClasses(value.planned);
  const approved = readEffectClasses(value.approved);
  const applied = readEffectClasses(value.applied);
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
