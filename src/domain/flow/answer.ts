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

import type { CapabilityFailure } from "../capability/protocol.js";
import type { FlowDecision } from "./authority.js";
import type { FlowBoundaryKind, FlowChoice } from "./directive.js";

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
    },
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
