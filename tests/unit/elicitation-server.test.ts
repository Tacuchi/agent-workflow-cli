import { describe, expect, it } from "vitest";
import {
  type StructuredChoiceResult,
  TOOL_NAME,
  createElicitationServer,
} from "../../src/application/elicitation-server.js";
import { CHOICE_KEY, FREE_TEXT_KEY } from "../../src/domain/elicitation.js";

const QUESTIONS = [
  {
    header: "Commit",
    question: "¿Aprobás los commits?",
    options: [
      { label: "Aprobar", consequence: "un commit por fuente", recommended: true },
      { label: "Dejar sin commitear", consequence: "queda en el árbol" },
    ],
  },
  {
    header: "Integrar",
    question: "¿Integro la unidad?",
    options: [
      { label: "Integrar", consequence: "se mergea a la rama de trabajo", recommended: true },
      { label: "Dejar separada", consequence: "queda sin integrar" },
    ],
  },
];

const VIA = {
  available: true as const,
  evidence: "probe 2026-08-22",
};

function startLegacySession(
  server: ReturnType<typeof createElicitationServer>,
  options: { elicitation?: boolean } = {},
): void {
  server.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: options.elicitation === false ? {} : { elicitation: {} },
    },
  });
  server.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
}

/** Un cliente de mentira que graba el transcript legacy entero. */
function driver(replies: unknown[]) {
  const sent: Record<string, unknown>[] = [];
  const server = createElicitationServer({
    send: (message) => sent.push(message as Record<string, unknown>),
    via: VIA,
  });
  startLegacySession(server);
  server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: TOOL_NAME, arguments: { questions: QUESTIONS } },
  });
  for (const reply of replies) {
    const elicit = sent.filter((message) => message.method === "elicitation/create").at(-1);
    if (elicit === undefined) break;
    server.handle({ jsonrpc: "2.0", id: elicit.id, result: reply });
  }
  const call = sent.find((message) => message.id === 2);
  const content = (call?.result as { content?: { text: string }[] } | undefined)?.content;
  return {
    sent,
    elicitations: sent.filter((message) => message.method === "elicitation/create"),
    result:
      content === undefined
        ? null
        : (JSON.parse(content[0]?.text ?? "{}") as StructuredChoiceResult),
  };
}

describe("el servidor propio, manejado por un cliente falso", () => {
  it("negocia el lifecycle legacy y sólo pide la elección después de initialized", () => {
    const run = driver([]);

    const hello = run.sent.find((message) => message.id === 0)?.result as Record<string, unknown>;
    expect(hello.protocolVersion).toBe("2025-06-18");
    expect((hello.serverInfo as { name: string }).name).toBe("agent-workflow");
    const tools = (
      run.sent.find((message) => message.id === 1)?.result as { tools: { name: string }[] }
    ).tools;
    expect(tools.map((tool) => tool.name)).toEqual([TOOL_NAME]);
    expect(run.elicitations).toHaveLength(1);
  });

  it("recorre las preguntas y devuelve la elección por el resultado de la herramienta", () => {
    const run = driver([
      { action: "accept", content: { [CHOICE_KEY]: "Aprobar" } },
      { action: "accept", content: { [CHOICE_KEY]: "Integrar" } },
    ]);

    expect(run.elicitations).toHaveLength(2);
    expect(run.result).toEqual({
      outcome: "chosen",
      answers: [
        { header: "Commit", choice: "Aprobar", free: false, flow_control: false },
        { header: "Integrar", choice: "Integrar", free: false, flow_control: false },
      ],
    });
  });

  it("una respuesta libre no vacía prevalece sobre el enum", () => {
    const run = driver([
      {
        action: "accept",
        content: { [CHOICE_KEY]: "Aprobar", [FREE_TEXT_KEY]: "commiteá sin push" },
      },
      { action: "accept", content: { [CHOICE_KEY]: "Integrar" } },
    ]);

    expect(run.result?.answers[0]).toEqual({
      header: "Commit",
      choice: "commiteá sin push",
      free: true,
      flow_control: false,
    });
  });

  it("pausar en la primera pregunta corta el recorrido", () => {
    const run = driver([{ action: "accept", content: { [CHOICE_KEY]: "Compactar" } }]);

    expect(run.elicitations).toHaveLength(1);
    expect(run.result?.answers[0]).toEqual({
      header: "Commit",
      choice: "Compactar",
      free: false,
      flow_control: true,
    });
    expect(run.result?.stopped_at).toBe("Commit");
  });

  it("decline queda sin atribución temporal y conserva toda la frontera", () => {
    const run = driver([{ action: "decline" }]);

    expect(run.result?.outcome).toBe("declined");
    expect(run.result?.answers).toEqual([]);
    expect(run.result?.notice).toContain("selector reported a decline");
    expect(run.result?.notice).not.toContain("host");
    expect(run.result?.fallback_markdown).toContain("Aprobar — un commit por fuente");
    expect(run.result?.fallback_markdown).toContain("¿Integro la unidad?");
  });

  it("no deja avanzar una etiqueta inventada", () => {
    const run = driver([{ action: "accept", content: { [CHOICE_KEY]: "inventada" } }]);

    expect(run.result?.outcome).toBe("empty");
    expect(run.result?.answers).toEqual([]);
  });

  it("exige initialized antes de tools/call", () => {
    const sent: Record<string, unknown>[] = [];
    const server = createElicitationServer({
      send: (message) => sent.push(message as never),
      via: VIA,
    });
    server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} } },
    });
    server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: TOOL_NAME, arguments: { questions: QUESTIONS } },
    });

    expect(sent.find((message) => message.id === 2)?.error).toMatchObject({ code: -32002 });
    expect(sent.some((message) => message.method === "elicitation/create")).toBe(false);
  });

  it("exige capability elicitation antes de solicitarla", () => {
    const sent: Record<string, unknown>[] = [];
    const server = createElicitationServer({
      send: (message) => sent.push(message as never),
      via: VIA,
    });
    startLegacySession(server, { elicitation: false });
    server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: TOOL_NAME, arguments: { questions: QUESTIONS } },
    });

    expect((sent.find((message) => message.id === 3)?.result as { isError: boolean }).isError).toBe(
      true,
    );
    expect(sent.some((message) => message.method === "elicitation/create")).toBe(false);
  });

  it("responde method not found a server/discover para que un cliente dual haga fallback", () => {
    const sent: Record<string, unknown>[] = [];
    const server = createElicitationServer({
      send: (message) => sent.push(message as never),
      via: VIA,
    });

    expect(server.handle({ jsonrpc: "2.0", id: 7, method: "server/discover" })).toBe(true);
    expect(sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32601, message: "Method not found" },
    });
  });

  it.each([
    ["sin preguntas", { questions: [] }],
    [
      "una opción",
      { questions: [{ ...QUESTIONS[0], options: QUESTIONS[0]?.options.slice(0, 1) }] },
    ],
    [
      "sin recomendación",
      {
        questions: [
          {
            ...QUESTIONS[0],
            options: QUESTIONS[0]?.options.map((option) => ({ ...option, recommended: false })),
          },
        ],
      },
    ],
    [
      "etiqueta reservada",
      {
        questions: [
          {
            ...QUESTIONS[0],
            options: [
              { label: "Compactar", consequence: "ajena", recommended: true },
              { label: "Otra", consequence: "otra" },
            ],
          },
        ],
      },
    ],
  ])("rechaza la entrada completa cuando hay %s", (_reason, arguments_) => {
    const sent: Record<string, unknown>[] = [];
    const server = createElicitationServer({
      send: (message) => sent.push(message as never),
      via: VIA,
    });
    startLegacySession(server);
    server.handle({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: TOOL_NAME, arguments: arguments_ },
    });

    expect((sent.find((message) => message.id === 8)?.result as { isError: boolean }).isError).toBe(
      true,
    );
    expect(sent.some((message) => message.method === "elicitation/create")).toBe(false);
  });
});
