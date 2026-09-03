import { describe, expect, it } from "vitest";
import { advanceFlowRun } from "../../src/application/flow/advance.js";
import { ALL_COMMANDS, commandDescribes } from "../../src/cli/commands/index.js";
import { groupCommands, renderGroupedCommandLines } from "../../src/cli/help-groups.js";
import type { FlowAuthority, FlowDecision } from "../../src/domain/flow/authority.js";
import { decisionsOfScope } from "../../src/domain/flow/authority.js";
import {
  type FlowRunAttempt,
  type FlowRunState,
  attemptAccountingAt,
  attemptReconciliationsOf,
  newRunState,
  withAttempt,
  withAttemptCounters,
  withEvent,
} from "../../src/domain/flow/run-state.js";

/**
 * One invocation exhausts the deterministic steps and stops at the first
 * boundary that is not the CLI's — with the trace of what it applied left in the
 * run state, so the advance is auditable afterwards instead of asserted.
 */

function decision(id: string, authority: FlowAuthority): FlowDecision {
  return {
    id,
    scope: "quick",
    title: `transición ${id} del fixture de avance`,
    authority,
    // The engine only applies what the CLI owns: a fixture still marked `legacy`
    // would stop at its first step, which is the migration's rule, not this
    // file's subject.
    ownership: "cli-owned",
    document: "loops/quick-loop/LOOP.md",
  };
}

/** Three deterministic transitions, then a semantic boundary. */
const JOURNEY: readonly FlowDecision[] = [
  decision("fixture.uno", "cli"),
  decision("fixture.dos", "cli"),
  decision("fixture.tres", "cli"),
  decision("fixture.semantica", "agent"),
];

/** The transitions a directive says it applied, in order. */
function trace(directive: { applied: { transition: string }[] }): string[] {
  return directive.applied.map((step) => step.transition);
}

describe("aw flow advance — agota los pasos deterministas", () => {
  it("una sola invocación aplica las tres y devuelve la directiva de la cuarta", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey: JOURNEY });
    if (!result.ok) throw new Error(`esperaba avanzar: ${result.failure.code}`);

    expect(trace(result.directive)).toEqual(["fixture.uno", "fixture.dos", "fixture.tres"]);
    // The trace carries the authority each step moved with, not only its id —
    // and whether the run applied it or passed over it.
    expect(result.directive.applied[0]).toEqual({
      transition: "fixture.uno",
      authority: "cli",
      ownership: "cli-owned",
      outcome: "applied",
      reason: null,
    });
    expect(result.directive.boundary.kind).toBe("semantic");
    expect(result.directive.boundary.transition).toBe("fixture.semantica");
    expect(result.directive.outcome).toBe("needs_input");
    expect(result.directive.pending).toEqual(["fixture.semantica"]);
  });

  it("la traza ordenada queda en el estado de corrida, no solo en la respuesta", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey: JOURNEY });
    if (!result.ok) throw new Error("esperaba avanzar");
    expect(result.state.applied).toEqual(["fixture.uno", "fixture.dos", "fixture.tres"]);
    expect(result.state.boundary).toBe("fixture.semantica");
  });

  it("la frontera semántica lleva contrato, sello de entradas y read_set visible", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey: JOURNEY });
    if (!result.ok) throw new Error("esperaba avanzar");
    const request = result.directive.request;
    if (request === null) throw new Error("una frontera semántica trae su pedido");
    expect(request.operation).toBe("flow.fixture.semantica");
    expect(request.contract).toContain("El CLI valida la respuesta");
    expect(request.input_digest.length).toBe(64);
    expect(request.read_set).toEqual(["loops/quick-loop/LOOP.md"]);
    expect(request.allowed_destinations).toEqual([]);
  });

  it("no devuelve ningún paso determinista como tarea del agente", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey: JOURNEY });
    if (!result.ok) throw new Error("esperaba avanzar");
    const deterministic = JOURNEY.filter((entry) => entry.authority === "cli").map((e) => e.id);
    expect(result.directive.pending.some((id) => deterministic.includes(id))).toBe(false);
  });

  it("una segunda invocación sobre la misma frontera no aplica nada nuevo", () => {
    const first = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey: JOURNEY });
    if (!first.ok) throw new Error("esperaba avanzar");
    const second = advanceFlowRun({ state: first.state, journey: JOURNEY });
    if (!second.ok) throw new Error("esperaba una directiva");
    expect(second.directive.applied).toEqual([]);
    expect(second.directive.boundary.transition).toBe("fixture.semantica");
  });

  it("se detiene en una frontera humana con sus alternativas y su consecuencia", () => {
    const journey = [decision("fixture.uno", "cli"), decision("fixture.humana", "human")];
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey });
    if (!result.ok) throw new Error("esperaba avanzar");
    expect(result.directive.boundary.kind).toBe("human");
    expect(result.directive.choices.length).toBeGreaterThanOrEqual(2);
    expect(result.directive.choices.filter((choice) => choice.recommended)).toHaveLength(1);
    for (const choice of result.directive.choices) {
      expect(choice.consequence.length).toBeGreaterThan(0);
    }
  });

  it("un recorrido agotado finaliza declarando que no queda trabajo", () => {
    const journey = [decision("fixture.uno", "cli")];
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey });
    if (!result.ok) throw new Error("esperaba avanzar");
    expect(result.directive.boundary.kind).toBe("final");
    expect(result.directive.pending).toEqual([]);
    expect(result.directive.outcome).toBe("completed");
    expect(result.state.boundary).toBeNull();
  });

  it("un estado que no corresponde al recorrido no avanza", () => {
    const state = { ...newRunState("quick", "001-p-quick"), applied: ["fixture.otro"] };
    const result = advanceFlowRun({ state, journey: JOURNEY });
    if (result.ok) throw new Error("un estado ajeno no puede avanzar");
    expect(result.failure.code).toBe("FLOW_RUN_AHEAD_OF_JOURNEY");
  });

  it("el motor consume el registro real y no acredita nada que no haya corrido", () => {
    const real = decisionsOfScope("plan-exec");
    expect(real.length).toBeGreaterThan(0);
    const result = advanceFlowRun({
      state: newRunState("plan-exec", "001-p-plan-exec"),
      journey: real,
    });
    if (!result.ok) throw new Error(`esperaba avanzar: ${result.failure.code}`);
    // PLAN is cut over, so the first row is no longer handed back to its document
    // — it is handed back as an INVOCATION. The invariant the test guards is the
    // same one, and it is the stronger half: over the live registry the engine
    // still applies NOTHING on the first call, because the first step is something
    // it can direct and cannot materialize.
    expect(result.directive.boundary.kind).toBe("execution");
    expect(result.directive.boundary.transition).toBe(real[0]?.id);
    expect(result.directive.boundary.document).toBe(real[0]?.document);
    expect(result.directive.action?.invocation.program).toBe("aw");
    expect(result.directive.applied).toEqual([]);
  });
});

describe("la entrada pública queda en su familia y ninguna guarda se rompe", () => {
  it("`flow` está registrado junto a `capability` en Orchestration", () => {
    const groups = groupCommands(ALL_COMMANDS.map((command) => command.name));
    const orchestration = groups.find((group) => group.name === "Orchestration");
    expect(orchestration?.commands).toContain("flow");
    expect(orchestration?.commands).toContain("capability");
  });

  it("ningún comando cae en el cajón de sastre del help", () => {
    const groups = groupCommands(ALL_COMMANDS.map((command) => command.name));
    expect(groups.find((group) => group.name === "Other")).toBeUndefined();
  });

  it("el listado agrupado muestra `flow` con su resumen", () => {
    const lines = renderGroupedCommandLines(
      ALL_COMMANDS.map((command) => command.name),
      commandDescribes(),
    );
    const row = lines.find((line) => line.trim().startsWith("flow "));
    expect(row).toBeDefined();
    expect(row).toContain("frontera");
  });

  it("el describe nombra su propia invocación", () => {
    expect(commandDescribes().get("flow")).toContain("aw flow advance");
  });
});

describe("aw flow advance — la contabilidad propia se repara antes de resolver la frontera", () => {
  /**
   * El pedido era «que el CLI ayude con cosas así y ni siquiera notifique al
   * agente». Lo que se fija acá es las dos mitades de eso: el desajuste con
   * lectura única desaparece sin frontera, sin intento y sin ocupar la
   * respuesta; y el que no tiene lectura única sigue bloqueando, nombrando la
   * salida que corresponde en vez de pedir una degradación que no arregla nada.
   */
  const STOPPED = "fixture.semantica";

  const row = (attempt: number, parent: string | null): FlowRunAttempt => ({
    invocation_id: "sello-unico",
    attempt,
    request_digest: `pedido-${attempt}`,
    parent_request_digest: parent,
    transition: STOPPED,
  });

  /** La corrida parada en la frontera semántica, con las filas que se le pasen. */
  function parked(...rows: FlowRunAttempt[]): FlowRunState {
    const walked = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey: JOURNEY });
    if (!walked.ok) throw new Error("esperaba avanzar hasta la frontera semántica");
    return rows.reduce((acc, entry) => withAttempt(acc, entry), walked.state);
  }

  it("el contador por encima de las filas se repara al vuelo: misma frontera, intentos intactos", () => {
    const broken = withAttemptCounters(parked(row(1, null)), {
      floor: { [STOPPED]: 3 },
      grants: {},
    });
    // Antes de avanzar, la frontera está agotada por una cuenta que nadie gastó.
    expect(attemptAccountingAt(broken, STOPPED).available).toBe(0);

    const result = advanceFlowRun({ state: broken, journey: JOURNEY });
    if (!result.ok) throw new Error(`esperaba avanzar: ${result.failure.code}`);

    // La frontera vigente es la que iba a ser, contestable y con sus intentos.
    expect(result.directive.boundary.transition).toBe(STOPPED);
    expect(result.directive.boundary.kind).toBe("semantic");
    expect(result.directive.error).toBeNull();
    expect(attemptAccountingAt(result.state, STOPPED).available).toBe(2);
    // Ni frontera nueva, ni intento gastado, ni degradación pedida.
    expect(result.state.attempts).toHaveLength(1);
    expect(result.state.degraded ?? []).toEqual([]);
    // Y nada de esto aparece en la directiva: sólo en la traza sellada.
    expect(result.directive.applied.map((step) => step.transition)).not.toContain(
      "flow.attempt-reconciliation",
    );
    expect(attemptReconciliationsOf(result.state)).toEqual([
      {
        transition: STOPPED,
        repairs: [
          {
            rule: "forgive-counter-excess",
            cause: expect.stringContaining("contador monótono"),
            field: "attempt_grants",
            before: 0,
            after: 2,
          },
        ],
      },
    ]);
  });

  it("una cadena incontestable con hueco se renumera y la frontera vuelve a contestarse", () => {
    const gapped = parked(row(1, null), row(3, "pedido-1"));
    expect(attemptAccountingAt(gapped, STOPPED).unanswerable).not.toBeNull();

    const result = advanceFlowRun({ state: gapped, journey: JOURNEY });
    if (!result.ok) throw new Error("esperaba avanzar");
    expect(result.directive.boundary.transition).toBe(STOPPED);
    expect(result.directive.error).toBeNull();
    expect(attemptAccountingAt(result.state, STOPPED).unanswerable).toBeNull();
    expect(result.state.attempts.map((entry) => entry.attempt)).toEqual([1, 2]);
  });

  it("un ordinal repetido sigue bloqueando, y la acción nombra recuperar en vez de degradar", () => {
    const twice = withAttemptCounters(parked(row(1, null), row(1, null), row(1, null)), {
      floor: {},
      grants: {},
    });
    const result = advanceFlowRun({ state: twice, journey: JOURNEY });
    if (!result.ok) throw new Error("esperaba una directiva con su bloqueo");

    const error = result.directive.error;
    if (error === null) throw new Error("esperaba que la frontera siguiera bloqueada");
    expect(error.action).toContain("aw flow recover --session");
    expect(error.action).toContain("lo roto es la contabilidad de la corrida, no el gap");
    // La degradación NO se ofrece: degradar un gap que no es el problema no lo arregla.
    expect(error.action).not.toContain("degradá el gap");
    expect(attemptReconciliationsOf(result.state)).toEqual([]);
  });

  it("una frontera que ya materializó efectos no se repara sola: sus contadores quedan como están", () => {
    const moved = withEvent(
      withAttemptCounters(parked(row(1, null), row(2, "pedido-1"), row(3, "pedido-2")), {
        floor: { [STOPPED]: 4 },
        grants: {},
      }),
      {
        kind: "executed",
        transition: STOPPED,
        operation: "fixture.write",
        summary: "escribió el documento",
        output_digest: "salida",
        effects: ["mutate_overwrite"],
        evidence: ["fixture.evidencia"],
      },
    );
    const result = advanceFlowRun({ state: moved, journey: JOURNEY });
    if (!result.ok) throw new Error("esperaba una directiva con su bloqueo");

    // Nada se reparó y nada se perdonó: con el mundo ya movido, la única lectura
    // segura es no tocar la cuenta. Lo que pase después con esa frontera es la
    // conducta que el recorrido ya tenía, y esta fase no la cambia.
    expect(attemptReconciliationsOf(result.state)).toEqual([]);
    expect(result.state.attempt_grants ?? {}).toEqual({});
    expect(result.state.attempt_floor).toEqual({ [STOPPED]: 4 });
  });
});
