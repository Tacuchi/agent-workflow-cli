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

import {
  type BoundaryQuestion,
  type ElicitationOutcome,
  classifyElicitationReply,
  elicitationRequestsFor,
  isFlowControl,
} from "../domain/elicitation.js";

export const SERVER_NAME = "agent-workflow";
export const TOOL_NAME = "structured_choice";

/** La versión que se le devuelve al cliente si no propone ninguna. */
const FALLBACK_PROTOCOL = "2025-06-18";

export interface ElicitationServerDeps {
  /** Escribe UN mensaje en el canal de protocolo. Nunca diagnóstico. */
  send: (message: unknown) => void;
  /** Milisegundos monótonos. Inyectado porque la clasificación es una regla. */
  now: () => number;
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
}

interface Pending {
  toolCallId: unknown;
  questions: readonly BoundaryQuestion[];
  requests: ReturnType<typeof elicitationRequestsFor>;
  index: number;
  answers: BoundaryAnswer[];
  elicitId: string;
  sentAt: number;
}

export interface ElicitationServer {
  /** Atiende un mensaje del cliente. Devuelve `true` si lo reconoció. */
  handle: (message: unknown) => boolean;
}

export function createElicitationServer(deps: ElicitationServerDeps): ElicitationServer {
  let pending: Pending | null = null;
  let elicitCounter = 0;

  function reply(id: unknown, result: unknown): void {
    deps.send({ jsonrpc: "2.0", id, result });
  }

  function finish(outcome: ElicitationOutcome["kind"], stoppedAt?: string): void {
    if (pending === null) return;
    const result: StructuredChoiceResult = {
      outcome,
      answers: pending.answers,
      ...(stoppedAt === undefined ? {} : { stopped_at: stoppedAt }),
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
    pending.sentAt = deps.now();
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
    const outcome = classifyElicitationReply(
      message.result ?? message.error ?? null,
      deps.now() - pending.sentAt,
    );
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
    const questions = questionsOf(args);
    if (questions.length === 0) {
      refuse(id, "structured_choice necesita al menos una pregunta con sus alternativas.");
      return;
    }
    pending = {
      toolCallId: id,
      questions,
      requests: elicitationRequestsFor(questions),
      index: 0,
      answers: [],
      elicitId: "",
      sentAt: 0,
    };
    ask();
  }

  function replyInitialize(msg: Record<string, unknown>): void {
    const params = (msg.params ?? {}) as Record<string, unknown>;
    reply(msg.id, {
      protocolVersion:
        typeof params.protocolVersion === "string" ? params.protocolVersion : FALLBACK_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: "1" },
    });
  }

  /** Un método conocido, o la respuesta vacía que evita dejar al cliente colgado. */
  function dispatch(method: string, msg: Record<string, unknown>): boolean {
    if (method === "initialize") {
      replyInitialize(msg);
      return true;
    }
    if (method === "tools/list") {
      reply(msg.id, { tools: [TOOL_DESCRIPTOR] });
      return true;
    }
    if (method === "tools/call") {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      // Una herramienta que no es la nuestra igual se CONTESTA: devolver `false`
      // dejaba la llamada sin respuesta, y un cliente esperándola no reintenta.
      if (params.name !== TOOL_NAME) {
        refuse(msg.id, `este servidor sólo expone ${TOOL_NAME}`);
        return true;
      }
      start(msg.id, params.arguments);
      return true;
    }
    // Cualquier otra petición con id se contesta vacía en vez de dejarse colgada:
    // un cliente esperando una respuesta que nunca llega es peor que una vacía.
    if (msg.id !== undefined) {
      reply(msg.id, {});
      return true;
    }
    return false;
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
        items: {
          type: "object",
          required: ["header", "question", "options"],
          properties: {
            header: { type: "string", description: "Rótulo corto de la pregunta." },
            question: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                required: ["label", "consequence"],
                properties: {
                  label: { type: "string" },
                  consequence: {
                    type: "string",
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

/** Las preguntas que traen los argumentos, o vacío si no tienen la forma. */
function questionsOf(args: unknown): BoundaryQuestion[] {
  if (args === null || typeof args !== "object") return [];
  const raw = (args as Record<string, unknown>).questions;
  if (!Array.isArray(raw)) return [];
  const questions: BoundaryQuestion[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    if (typeof q.header !== "string" || typeof q.question !== "string") continue;
    if (!Array.isArray(q.options)) continue;
    const options = q.options
      .filter((o): o is Record<string, unknown> => o !== null && typeof o === "object")
      .filter((o) => typeof o.label === "string" && typeof o.consequence === "string")
      .map((o) => ({
        label: o.label as string,
        consequence: o.consequence as string,
        ...(o.recommended === true ? { recommended: true } : {}),
      }));
    if (options.length === 0) continue;
    questions.push({ header: q.header, question: q.question, options });
  }
  return questions;
}
