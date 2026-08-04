/**
 * The answer, validated as DATA before anything moves.
 *
 * What the agent or the person sends back is an input to a CLI decision, never
 * the decision itself. Which shape is admissible is determined by the BOUNDARY IN
 * FORCE — never by a flag the caller passes — so the same command answers a
 * semantic boundary, a human one and an authorization one without the caller
 * being able to claim it is answering something else.
 *
 * Six ways an answer fails, and all six leave state and effects untouched: absent,
 * invalid, ambiguous, out of scope, stale, and — at a boundary the CLI does not
 * own yet — an answer that never declared which fallback it applied. Each
 * rejection carries a code, a message and one valid action, and travels inside the
 * RECALCULATED directive with `ok: true` — with `ok: false` the host never calls
 * `renderHuman` and the person would never see the boundary they have to answer
 * over.
 */

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
import type { DelegatedAction, DelegatedInvocation, FlowDecision } from "./authority.js";
import type { FlowBoundaryKind, FlowChoice } from "./directive.js";

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
  /** The fallback document applied, at a boundary the CLI does not own yet. */
  fallback: string | null;
  /** The execution result, at an `execution` boundary. */
  result: FlowExecutionResult | null;
}

export type FlowAnswerParse =
  | { ok: true; answer: FlowAnswer }
  | { ok: false; failure: CapabilityFailure };

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
  /** The alternative that refuses the boundary instead of resolving it. */
  declineLabel: string;
  /** The sealed action, at an `execution` boundary: what the result is about. */
  action?: DelegatedAction | null;
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
    case "legacy":
      return legacyAnswer(body, input);
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
  // Neither an observation nor a decision: nothing the CLI can act on, and
  // guessing which of the two was meant is exactly what it must not do.
  if (signals.length === 0 && (decisions === undefined || Object.keys(decisions).length === 0)) {
    return {
      ok: false,
      failure: {
        code: "FLOW_ANSWER_AMBIGUOUS",
        message: "la respuesta no declara ninguna señal ni ninguna decisión",
        action:
          "declarás las señales que observás en 'signals', o lo que el contrato pide en 'decisions'",
      },
    };
  }
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
      fallback: null,
      result: null,
    },
  };
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
      fallback: null,
      result: null,
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
      fallback: null,
      result: null,
    },
  };
  // DECLINING needs no approval, and demanding one would be absurd: it would ask
  // the person to hand over the very approval they are refusing to give. The
  // emitted alternative has to be answerable, or it is not an alternative.
  if (choice === input.declineLabel) return accepted;

  if (input.approval === null) {
    return {
      ok: false,
      failure: {
        code: "FLOW_APPROVAL_MISSING",
        message: "esta frontera necesita una aprobación de efecto y no llegó ninguna",
        action: `volvé a invocar con --approval ${input.expectedApproval ?? "<digest>"}, o respondé '${input.declineLabel}' para no autorizarla`,
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
 * A legacy step advances only if the answer names the fallback it applied.
 *
 * The directive declared which document decides; echoing it back is what turns
 * "declare the fallback before executing it" into something the CLI can check
 * instead of hope for. A blind submit — the failure mode of a host that never
 * read the boundary — is exactly what this refuses, and refusing it costs the
 * sender one field they already have in front of them.
 */
function legacyAnswer(body: Record<string, unknown>, input: ParseAnswerInput): FlowAnswerParse {
  const declared = body.fallback;
  if (typeof declared !== "string" || declared.trim().length === 0) {
    return {
      ok: false,
      failure: {
        code: "FLOW_FALLBACK_UNDECLARED",
        message:
          "esta transición todavía la decide la doctrina y la respuesta no declara el fallback que aplicó",
        action: `declarás en 'fallback' el documento de la directiva: ${input.decision.document}`,
      },
    };
  }
  if (declared !== input.decision.document) {
    return {
      ok: false,
      failure: {
        code: "FLOW_FALLBACK_UNDECLARED",
        message: `'${declared}' no es el documento cuya regla declara esta frontera`,
        action: `el fallback de esta frontera es ${input.decision.document}`,
      },
    };
  }
  return {
    ok: true,
    answer: {
      input_digest: body.input_digest as string,
      signals: [],
      decisions: {},
      choice: null,
      fallback: declared,
      result: null,
    },
  };
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
    return {
      ok: false,
      failure: badResult("'validations' tiene que ser la lista de ValidationOutcome del resultado"),
    };
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
      fallback: null,
      result: { outcome: outcome as CapabilityOutcome, invocation, output, validations, effects },
    },
  };
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
    out.push({ id: entry.id, passed: entry.passed, detail });
  }
  return out;
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
