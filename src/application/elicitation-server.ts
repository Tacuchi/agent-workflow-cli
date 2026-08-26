/**
 * El servidor propio de Workline: la pieza que convierte una frontera humana en un
 * selector nativo del host.
 *
 * Cómo funciona, y por qué así: el agente llama una herramienta de ESTE servidor
 * con el contenido de la frontera; el servidor le pide la elección al cliente del
 * host por `elicitation/create`, que es protocolo estándar y no un campo interno
 * de nadie; el cliente renderiza su selector; y la elección vuelve como resultado
 * de la herramienta, para que el agente la ponga en el mismo campo del sobre que
 * usa cualquier otra vía. No hay canal paralelo y el protocolo del recorrido no
 * cambia: el motor sigue recibiendo una elección por donde siempre.
 *
 * No habla de transporte. Recibe un `send` y un reloj, así que la misma pieza se
 * maneja desde una entrada y salida reales o desde un cliente falso guionado —
 * que es lo que permite fijar por prueba local un comportamiento cuyo renderizado
 * sólo ocurre dentro de la interfaz interactiva del host.
 */

import { degradationNotice, renderLabeledMarkdown } from "../domain/degradation-notice.js";
import {
  type BoundaryQuestion,
  type ElicitationOutcome,
  classifyElicitationReply,
  elicitationRequestsFor,
  isFlowControl,
  orderedOptions,
} from "../domain/elicitation.js";
import type { HarnessMcpElicitation } from "../domain/harnesses.js";

export const SERVER_NAME = "agent-workflow";
export const TOOL_NAME = "structured_choice";

/** Esta implementación habla deliberadamente el lifecycle legacy. */
const LEGACY_PROTOCOL = "2025-06-18";

export interface ElicitationServerDeps {
  /** Escribe UN mensaje en el canal de protocolo. Nunca diagnóstico. */
  send: (message: unknown) => void;
  /**
   * Lo que el catálogo declara para ESTE host. Evita solicitar elicitation en un
   * host donde la vía no está observada, sin atribuir negativas posteriores.
   */
  via: HarnessMcpElicitation;
}

/** Lo que el agente recibe por cada pregunta contestada. */
export interface BoundaryAnswer {
  header: string;
  choice: string;
  /** La persona escribió en vez de elegir una alternativa. */
  free: boolean;
  /** La elección fue `Compactar` o `Cerrar`, no una alternativa de contenido. */
  flow_control: boolean;
}

export interface StructuredChoiceResult {
  outcome: ElicitationOutcome["kind"];
  answers: BoundaryAnswer[];
  /** El rótulo de la pregunta donde se cortó, cuando no se contestaron todas. */
  stopped_at?: string;
  /**
   * Por qué no hubo elección y qué hacer, ya redactado.
   *
   * Viaja con el resultado en vez de dejar que el agente lo componga: el motivo
   * exacto sale del resultado del protocolo; una negativa no se atribuye al host
   * ni a una persona sin evidencia explícita.
   */
  notice?: string;
  /**
   * La frontera entera en markdown etiquetado, generada del MISMO dato que la
   * solicitud nativa: así la degradada no puede perder una alternativa que la
   * nativa sí mostraba.
   */
  fallback_markdown?: string;
}

interface Pending {
  toolCallId: unknown;
  questions: readonly BoundaryQuestion[];
  requests: ReturnType<typeof elicitationRequestsFor>;
  index: number;
  answers: BoundaryAnswer[];
  elicitId: string;
}

export interface ElicitationServer {
  /** Atiende un mensaje del cliente. Devuelve `true` si lo reconoció. */
  handle: (message: unknown) => boolean;
}

export function createElicitationServer(deps: ElicitationServerDeps): ElicitationServer {
  let pending: Pending | null = null;
  let elicitCounter = 0;
  let lifecycle: "new" | "awaiting-initialized" | "ready" = "new";
  let clientSupportsElicitation = false;

  function reply(id: unknown, result: unknown): void {
    deps.send({ jsonrpc: "2.0", id, result });
  }

  function replyError(id: unknown, code: number, message: string): void {
    if (id === undefined) return;
    deps.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function finish(outcome: ElicitationOutcome["kind"], stoppedAt?: string): void {
    if (pending === null) return;
    const notice = outcome === "chosen" ? "" : degradationNotice(outcome);
    const result: StructuredChoiceResult = {
      outcome,
      answers: pending.answers,
      ...(stoppedAt === undefined ? {} : { stopped_at: stoppedAt }),
      ...(notice === ""
        ? {}
        : {
            notice,
            // Sólo las que quedaron sin contestar: repetir las ya resueltas le
            // pediría a la persona que decida dos veces lo mismo.
            fallback_markdown: renderLabeledMarkdown(pending.questions.slice(pending.index)),
          }),
    };
    const toolCallId = pending.toolCallId;
    pending = null;
    // El texto ES el JSON: el agente lo lee para poner la elección en el sobre, y
    // una prosa alrededor sería una segunda forma del mismo dato que puede diferir.
    reply(toolCallId, { content: [{ type: "text", text: JSON.stringify(result) }] });
  }

  function ask(): void {
    if (pending === null) return;
    const request = pending.requests[pending.index];
    if (request === undefined) {
      finish("chosen");
      return;
    }
    elicitCounter += 1;
    pending.elicitId = `aw-elicit-${elicitCounter}`;
    deps.send({
      jsonrpc: "2.0",
      id: pending.elicitId,
      method: "elicitation/create",
      params: request,
    });
  }

  function onElicitationReply(message: Record<string, unknown>): void {
    if (pending === null) return;
    const question = pending.questions[pending.index];
    const header = question?.header ?? "";
    const validChoices =
      question === undefined ? [] : orderedOptions(question).map((option) => option.label);
    const outcome = classifyElicitationReply(message.result ?? message.error ?? null, validChoices);
    if (outcome.kind !== "chosen") {
      // Ninguna de estas avanza la frontera. Lo que cambia entre ellas es qué se
      // le dice a la persona, y por eso vuelven distinguidas en vez de colapsadas.
      finish(outcome.kind, header);
      return;
    }
    const flow = isFlowControl(outcome.choice);
    pending.answers.push({
      header,
      choice: outcome.choice,
      free: outcome.free,
      flow_control: flow,
    });
    // Pausar o cerrar corta acá: seguir preguntando después de que alguien pidió
    // pausar es no haberle ofrecido pausar.
    if (flow) {
      finish("chosen", header);
      return;
    }
    pending.index += 1;
    ask();
  }

  /** Un rechazo con forma de resultado: el cliente recibe respuesta, nunca silencio. */
  function refuse(id: unknown, text: string): void {
    reply(id, { isError: true, content: [{ type: "text", text }] });
  }

  function start(id: unknown, args: unknown): void {
    // Una segunda llamada mientras la primera espera dejaría a ESA primera sin
    // respuesta para siempre: el cliente se queda colgado, que es el peor modo de
    // fallo que puede tener un servidor. Se rechaza la nueva y la vigente sigue.
    if (pending !== null) {
      refuse(id, "structured_choice ya está presentando una frontera: contestá esa primero.");
      return;
    }
    const parsed = parseQuestions(args);
    if (!parsed.ok) {
      refuse(id, parsed.error);
      return;
    }
    const questions = parsed.questions;
    pending = {
      toolCallId: id,
      questions,
      requests: elicitationRequestsFor(questions),
      index: 0,
      answers: [],
      elicitId: "",
    };
    ask();
  }

  function replyInitialize(msg: Record<string, unknown>): void {
    const params = isRecord(msg.params) ? msg.params : {};
    const capabilities = isRecord(params.capabilities) ? params.capabilities : {};
    clientSupportsElicitation = isRecord(capabilities.elicitation);
    lifecycle = "awaiting-initialized";
    reply(msg.id, {
      protocolVersion: LEGACY_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: "1" },
    });
  }

  /** Un método conocido, con lifecycle legacy explícito. */
  function dispatch(method: string, msg: Record<string, unknown>): boolean {
    const lifecycleResult = handleLifecycle(method, msg);
    if (lifecycleResult !== null) return lifecycleResult;
    if (requiresInitializedLifecycle(method) && lifecycle !== "ready") {
      replyError(msg.id, -32002, "Server not initialized");
      return true;
    }
    if (method === "tools/list") {
      reply(msg.id, { tools: [TOOL_DESCRIPTOR] });
      return true;
    }
    if (method === "tools/call") return dispatchToolCall(msg);
    return answerUnknownRequest(msg);
  }

  function handleLifecycle(method: string, msg: Record<string, unknown>): boolean | null {
    if (method === "initialize") return handleInitialize(msg);
    if (method === "notifications/initialized") {
      if (lifecycle === "awaiting-initialized") lifecycle = "ready";
      return true;
    }
    // El SDK dual-era intenta este método antes de probar el lifecycle legacy.
    // Responder method-not-found es el fallback pactado, no un vacío ambiguo.
    if (method === "server/discover") {
      replyError(msg.id, -32601, "Method not found");
      return true;
    }
    return null;
  }

  function handleInitialize(msg: Record<string, unknown>): boolean {
    if (lifecycle === "new") {
      replyInitialize(msg);
      return true;
    }
    replyError(msg.id, -32600, "initialize sólo puede llamarse una vez por sesión");
    return true;
  }

  function dispatchToolCall(msg: Record<string, unknown>): boolean {
    const params = isRecord(msg.params) ? msg.params : {};
    // Una herramienta que no es la nuestra igual se CONTESTA: devolver `false`
    // dejaba la llamada sin respuesta, y un cliente esperándola no reintenta.
    if (params.name !== TOOL_NAME) {
      refuse(msg.id, `este servidor sólo expone ${TOOL_NAME}`);
      return true;
    }
    if (!clientSupportsElicitation) {
      refuse(
        msg.id,
        "el cliente MCP no negoció la capability elicitation; no se puede solicitar un selector.",
      );
      return true;
    }
    if (!deps.via.available) {
      refuse(msg.id, "este host no declara una vía MCP de elicitation disponible.");
      return true;
    }
    start(msg.id, params.arguments);
    return true;
  }

  function answerUnknownRequest(msg: Record<string, unknown>): boolean {
    // Cualquier otra petición con id se contesta vacía en vez de dejarse colgada:
    // un cliente esperando una respuesta que nunca llega es peor que una vacía.
    if (msg.id !== undefined) {
      reply(msg.id, {});
      return true;
    }
    return false;
  }

  function requiresInitializedLifecycle(method: string): boolean {
    return method === "tools/list" || method === "tools/call";
  }

  return {
    handle(message: unknown): boolean {
      if (message === null || typeof message !== "object") return false;
      const msg = message as Record<string, unknown>;
      if (pending !== null && msg.id === pending.elicitId) {
        onElicitationReply(msg);
        return true;
      }
      const method = typeof msg.method === "string" ? msg.method : null;
      return method === null ? false : dispatch(method, msg);
    },
  };
}

const TOOL_DESCRIPTOR = {
  name: TOOL_NAME,
  description:
    "Presenta una frontera humana con el selector nativo de este host y devuelve la elección de la persona. Usala cuando la herramienta de preguntas del propio host no figure entre las de este turno.",
  inputSchema: {
    type: "object",
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        description: "Hasta 3 preguntas de contenido. El control de flujo lo agrega el servidor.",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          required: ["header", "question", "options"],
          properties: {
            header: { type: "string", minLength: 1, description: "Rótulo corto de la pregunta." },
            question: { type: "string", minLength: 1 },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 3,
              items: {
                type: "object",
                required: ["label", "consequence"],
                properties: {
                  label: { type: "string", minLength: 1 },
                  consequence: {
                    type: "string",
                    minLength: 1,
                    description: "Qué pasa si se elige. Viaja siempre con la alternativa.",
                  },
                  recommended: { type: "boolean" },
                },
              },
            },
          },
        },
      },
    },
  },
};

type ParsedQuestions = { ok: true; questions: BoundaryQuestion[] } | { ok: false; error: string };

/**
 * Valida la entrada entera antes de emitir la primera solicitud. No filtra una
 * pregunta u opción inválida para luego seguir con lo que quedó: perder una
 * alternativa cambiaría la frontera que el agente creyó haber enviado.
 */
function parseQuestions(args: unknown): ParsedQuestions {
  if (!isRecord(args)) {
    return { ok: false, error: "structured_choice necesita un objeto con questions." };
  }
  const raw = args.questions;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) {
    return { ok: false, error: "structured_choice requiere entre 1 y 3 preguntas." };
  }
  const questions: BoundaryQuestion[] = [];
  for (const [questionIndex, item] of raw.entries()) {
    const parsed = parseQuestion(item, questionIndex + 1);
    if (!parsed.ok) return parsed;
    questions.push(parsed.question);
  }
  return { ok: true, questions };
}

type ParsedQuestion = { ok: true; question: BoundaryQuestion } | { ok: false; error: string };
type ParsedOptions =
  | { ok: true; options: Array<BoundaryQuestion["options"][number]> }
  | { ok: false; error: string };
type ParsedOption =
  | { ok: true; option: BoundaryQuestion["options"][number] }
  | { ok: false; error: string };

function parseQuestion(raw: unknown, position: number): ParsedQuestion {
  if (!isRecord(raw)) return { ok: false, error: `La pregunta ${position} debe ser un objeto.` };
  const header = nonEmptyString(raw.header);
  const question = nonEmptyString(raw.question);
  if (header === null || question === null) {
    return { ok: false, error: `La pregunta ${position} necesita header y question no vacíos.` };
  }
  const options = parseOptions(raw.options, position);
  if (!options.ok) return options;
  return { ok: true, question: { header, question, options: options.options } };
}

function parseOptions(raw: unknown, questionPosition: number): ParsedOptions {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) {
    return {
      ok: false,
      error: `La pregunta ${questionPosition} requiere entre 2 y 3 alternativas de contenido.`,
    };
  }
  const labels = new Set<string>();
  const options: Array<BoundaryQuestion["options"][number]> = [];
  let recommendations = 0;
  for (const [optionIndex, rawOption] of raw.entries()) {
    const parsed = parseOption(rawOption, questionPosition, optionIndex + 1);
    if (!parsed.ok) return parsed;
    if (labels.has(parsed.option.label)) {
      return {
        ok: false,
        error: `La alternativa '${parsed.option.label}' se repite en la pregunta ${questionPosition}.`,
      };
    }
    labels.add(parsed.option.label);
    if (parsed.option.recommended === true) recommendations += 1;
    options.push(parsed.option);
  }
  if (recommendations !== 1) {
    return {
      ok: false,
      error: `La pregunta ${questionPosition} debe tener exactamente una alternativa recomendada.`,
    };
  }
  return { ok: true, options };
}

function parseOption(raw: unknown, questionPosition: number, optionPosition: number): ParsedOption {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: `La alternativa ${optionPosition} de la pregunta ${questionPosition} debe ser un objeto.`,
    };
  }
  const label = nonEmptyString(raw.label);
  const consequence = nonEmptyString(raw.consequence);
  if (label === null || consequence === null) {
    return {
      ok: false,
      error: `La alternativa ${optionPosition} de la pregunta ${questionPosition} necesita label y consequence no vacíos.`,
    };
  }
  if (isFlowControl(label)) {
    return {
      ok: false,
      error: `La alternativa '${label}' de la pregunta ${questionPosition} está reservada para control de flujo.`,
    };
  }
  if (raw.recommended !== undefined && typeof raw.recommended !== "boolean") {
    return {
      ok: false,
      error: `recommended de la alternativa ${optionPosition} de la pregunta ${questionPosition} debe ser booleano.`,
    };
  }
  return {
    ok: true,
    option: { label, consequence, ...(raw.recommended === true ? { recommended: true } : {}) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
