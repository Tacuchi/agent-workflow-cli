import { describe, expect, it } from "vitest";
import { advanceFlowRun } from "../../src/application/flow/advance.js";
import { ALL_COMMANDS, commandDescribes } from "../../src/cli/commands/index.js";
import { groupCommands, renderGroupedCommandLines } from "../../src/cli/help-groups.js";
import type { FlowAuthority, FlowDecision } from "../../src/domain/flow/authority.js";
import { decisionsOfScope } from "../../src/domain/flow/authority.js";
import { newRunState } from "../../src/domain/flow/run-state.js";

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
    ownership: "legacy",
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

describe("aw flow advance — agota los pasos deterministas", () => {
  it("una sola invocación aplica las tres y devuelve la directiva de la cuarta", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey: JOURNEY });
    if (!result.ok) throw new Error(`esperaba avanzar: ${result.failure.code}`);

    expect(result.directive.applied).toEqual(["fixture.uno", "fixture.dos", "fixture.tres"]);
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

  it("el motor consume el registro real: el recorrido de cada flow tiene decisiones", () => {
    const real = decisionsOfScope("plan-exec");
    expect(real.length).toBeGreaterThan(0);
    const result = advanceFlowRun({
      state: newRunState("plan-exec", "001-p-plan-exec"),
      journey: real,
    });
    if (!result.ok) throw new Error(`esperaba avanzar: ${result.failure.code}`);
    // The first non-`cli` row of PLAN exec is the consented normalization.
    expect(result.directive.boundary.authority).not.toBe("cli");
    expect(result.directive.applied.length).toBeGreaterThan(0);
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
