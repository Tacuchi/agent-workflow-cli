import { describe, expect, it } from "vitest";
import {
  type StructuredChoiceResult,
  TOOL_NAME,
  createElicitationServer,
} from "../../src/application/elicitation-server.js";
import { CHOICE_KEY } from "../../src/domain/elicitation.js";

/**
 * El servidor manejado por un cliente FALSO guionado, que es la única evidencia de
 * cierre que este comportamiento admite desde el checkout: el renderizado del
 * selector sólo lo ejecuta la interfaz interactiva del host, pero la solicitud
 * emitida y la respuesta consumida sí son observables acá — así se estableció la
 * vía en primer lugar.
 */
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
    options: [{ label: "Integrar", consequence: "se mergea a la rama de trabajo" }],
  },
];

/** Un cliente de mentira: guiona el reloj y las respuestas, y graba lo emitido. */
function driver(script: { replies: unknown[]; clock: number[] }) {
  const sent: Record<string, unknown>[] = [];
  let tick = 0;
  const server = createElicitationServer({
    send: (m) => sent.push(m as Record<string, unknown>),
    now: () => script.clock[tick++] ?? 0,
    via: VIA,
  });
  server.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
  server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  server.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: TOOL_NAME, arguments: { questions: QUESTIONS } },
  });
  for (const reply of script.replies) {
    const elicit = sent.filter((m) => m.method === "elicitation/create").at(-1);
    if (elicit === undefined) break;
    server.handle({ jsonrpc: "2.0", id: elicit.id, result: reply });
  }
  const call = sent.find((m) => m.id === 2);
  const content = (call?.result as { content?: { text: string }[] } | undefined)?.content;
  return {
    sent,
    elicitations: sent.filter((m) => m.method === "elicitation/create"),
    result:
      content === undefined
        ? null
        : (JSON.parse(content[0]?.text ?? "{}") as StructuredChoiceResult),
  };
}

/** Un host que declara la vía, para poder afirmar la causa y el remedio. */
const VIA = {
  available: true as const,
  evidence: "probe 2026-08-22",
  blockedBy: "the host was started with `--yolo`",
  recoverBy: "start it on its default approval policy",
};

describe("el servidor propio, manejado por un cliente falso", () => {
  it("saluda, ofrece su herramienta y recién entonces pide la elección", () => {
    const run = driver({ replies: [], clock: [0, 0] });

    const hello = run.sent.find((m) => m.id === 0)?.result as Record<string, unknown>;
    expect((hello.serverInfo as { name: string }).name).toBe("agent-workflow");
    const tools = (run.sent.find((m) => m.id === 1)?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([TOOL_NAME]);
    // Una sola solicitud hasta que la contesten: no se adelanta la siguiente.
    expect(run.elicitations).toHaveLength(1);
  });

  it("recorre las preguntas y devuelve la elección por el resultado de la herramienta", () => {
    const run = driver({
      replies: [
        { action: "accept", content: { [CHOICE_KEY]: "Aprobar" } },
        { action: "accept", content: { [CHOICE_KEY]: "Integrar" } },
      ],
      clock: [0, 3000, 3000, 9000, 9000],
    });

    expect(run.elicitations).toHaveLength(2);
    expect(run.result).toEqual({
      outcome: "chosen",
      answers: [
        { header: "Commit", choice: "Aprobar", free: false, flow_control: false },
        { header: "Integrar", choice: "Integrar", free: false, flow_control: false },
      ],
    });
  });

  it("pausar en la PRIMERA pregunta corta el recorrido y no sigue preguntando", () => {
    const run = driver({
      replies: [{ action: "accept", content: { [CHOICE_KEY]: "Compactar" } }],
      clock: [0, 2000],
    });

    // Es lo que hace honesta la forma de una solicitud por pregunta: seguir
    // preguntando después de que alguien pidió pausar es no haberle ofrecido pausar.
    expect(run.elicitations).toHaveLength(1);
    expect(run.result?.answers[0]).toEqual({
      header: "Commit",
      choice: "Compactar",
      free: false,
      flow_control: true,
    });
    expect(run.result?.stopped_at).toBe("Commit");
  });

  it("un rechazo INMEDIATO se devuelve como del host y sin ninguna elección", () => {
    const run = driver({ replies: [{ action: "decline" }], clock: [0, 0] });

    // El host arrancado con una política que promete no interrumpir contesta así,
    // sin mostrar nada. No avanza la frontera y no se le atribuye a la persona.
    expect(run.result?.outcome).toBe("refused-by-host");
    expect(run.result?.answers).toEqual([]);
    expect(run.elicitations).toHaveLength(1);
    // Y la degradación viaja YA REDACTADA: el motivo exacto sale del catálogo y
    // del reloj, y el agente no tiene ninguno de los dos.
    expect(run.result?.notice).toContain("NOT read as their decision");
    expect(run.result?.notice).toContain("--yolo");
    expect(run.result?.notice).toContain("default approval policy");
    // La frontera entera sobrevive a la degradación, con sus dos preguntas.
    expect(run.result?.fallback_markdown).toContain("Aprobar — un commit por fuente");
    expect(run.result?.fallback_markdown).toContain("¿Integro la unidad?");
    expect(run.result?.fallback_markdown).toContain("Compactar");
  });

  it("un rechazo con tiempo de lectura se devuelve como de la persona", () => {
    const run = driver({ replies: [{ action: "decline" }], clock: [0, 5000] });

    expect(run.result?.outcome).toBe("declined-by-person");
    expect(run.result?.answers).toEqual([]);
  });

  it("cortar a mitad conserva lo ya contestado y dice dónde se cortó", () => {
    const run = driver({
      replies: [{ action: "accept", content: { [CHOICE_KEY]: "Aprobar" } }, { action: "cancel" }],
      clock: [0, 3000, 3000, 8000, 8000],
    });

    expect(run.result?.outcome).toBe("cancelled");
    expect(run.result?.answers).toHaveLength(1);
    expect(run.result?.stopped_at).toBe("Integrar");
  });

  it("cortar a mitad NO vuelve a preguntar lo ya resuelto", () => {
    const run = driver({
      replies: [{ action: "accept", content: { [CHOICE_KEY]: "Aprobar" } }, { action: "decline" }],
      clock: [0, 3000, 3000, 9000, 9000],
    });

    // Repetir en el markdown una pregunta que la persona ya contestó le pediría
    // decidir dos veces lo mismo.
    expect(run.result?.fallback_markdown).toContain("¿Integro la unidad?");
    expect(run.result?.fallback_markdown).not.toContain("¿Aprobás los commits?");
    expect(run.result?.notice).toContain("saw the selector and refused it");
  });

  it("una elección NO trae degradación: no hay nada que degradar", () => {
    const run = driver({
      replies: [
        { action: "accept", content: { [CHOICE_KEY]: "Aprobar" } },
        { action: "accept", content: { [CHOICE_KEY]: "Integrar" } },
      ],
      clock: [0, 3000, 3000, 9000, 9000],
    });

    expect(run.result?.notice).toBeUndefined();
    expect(run.result?.fallback_markdown).toBeUndefined();
  });

  it("una llamada sin preguntas no emite ninguna solicitud y lo dice", () => {
    const sent: Record<string, unknown>[] = [];
    const server = createElicitationServer({
      send: (m) => sent.push(m as never),
      now: () => 0,
      via: VIA,
    });
    server.handle({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: TOOL_NAME, arguments: { questions: [] } },
    });

    expect(sent.filter((m) => m.method === "elicitation/create")).toHaveLength(0);
    expect((sent[0]?.result as { isError: boolean }).isError).toBe(true);
  });

  it("una segunda llamada mientras la primera espera NO deja colgada a la primera", () => {
    const sent: Record<string, unknown>[] = [];
    const server = createElicitationServer({
      send: (m) => sent.push(m as never),
      now: () => 0,
      via: VIA,
    });
    const call = (id: number) =>
      server.handle({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: TOOL_NAME, arguments: { questions: QUESTIONS } },
      });

    call(1);
    call(2);

    // La primera sigue viva y esperando su elección; la segunda recibe un rechazo
    // con forma de resultado. Pisar el estado dejaría a la 1 sin respuesta jamás.
    expect(sent.filter((m) => m.id === 2)).toHaveLength(1);
    expect((sent.find((m) => m.id === 2)?.result as { isError: boolean }).isError).toBe(true);
    expect(sent.filter((m) => m.id === 1)).toHaveLength(0);
    expect(sent.filter((m) => m.method === "elicitation/create")).toHaveLength(1);
  });

  it("una herramienta ajena se contesta con un error, no con silencio", () => {
    const sent: Record<string, unknown>[] = [];
    const server = createElicitationServer({
      send: (m) => sent.push(m as never),
      now: () => 0,
      via: VIA,
    });

    expect(
      server.handle({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "otra_cosa", arguments: {} },
      }),
    ).toBe(true);
    expect((sent[0]?.result as { isError: boolean }).isError).toBe(true);
  });

  it("una petición que no conoce se contesta vacía en vez de dejar al cliente colgado", () => {
    const sent: Record<string, unknown>[] = [];
    const server = createElicitationServer({
      send: (m) => sent.push(m as never),
      now: () => 0,
      via: VIA,
    });

    expect(server.handle({ jsonrpc: "2.0", id: 5, method: "resources/list" })).toBe(true);
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 5, result: {} });
    // Una notificación no lleva id y no se contesta.
    expect(server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(false);
  });
});
