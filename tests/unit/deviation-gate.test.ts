// El gate de desviación deja de ser doctrina sin máquina (F4 del plan 032).
//
// Hasta acá `plan-exec.deviation-gate` no declaraba acción, alternativas ni
// efectos, así que el recorrido lo AUTO-APLICABA y seguía derecho a
// `pending-effects`, `task-marking` y el commit. Declarar una desviación
// estructural no detenía nada, no preguntaba nada y no dirigía a ningún lado: la
// structured-choice que la doctrina prometía existía únicamente en prosa, y
// ningún test verificaba consecuencia alguna.
//
// Validación de fase de F4: el recorrido se atraviesa declarando cada clase y se
// detiene donde promete; dos divergencias en una misma corrida sobreviven las
// dos; el paquete de escalación se entrega completo y el destino lo declara
// consumido; y los guards de vocabulario y doctrina quedan verdes.

import { describe, expect, it } from "vitest";
import { advanceFlowRun, resolveBoundary } from "../../src/application/flow/advance.js";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  actionOf,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";
import {
  type FlowRunState,
  applyTransition,
  newRunState,
  withObservation,
} from "../../src/domain/flow/run-state.js";

const SESSION = "131-desviacion-plan-exec";
const EXEC = journeyOfFlow("plan-exec");

function rowOf(id: string): FlowDecision {
  const row = FLOW_DECISIONS.find((decision) => decision.id === id);
  if (row === undefined) throw new Error(`no existe la fila ${id}`);
  return row;
}

/** Aplica el recorrido hasta la fila indicada, sin pasar por ella. */
function upTo(id: string): FlowRunState {
  let state = newRunState("plan-exec", SESSION);
  for (const decision of EXEC) {
    if (decision.id === id) return state;
    state = applyTransition(state, decision.id);
  }
  throw new Error(`${id} no está en el recorrido de plan-exec`);
}

describe("F4 — el gate se detiene donde promete", () => {
  it("declarada una desviación estructural, la frontera vigente ES el gate", () => {
    const state = withObservation(upTo("plan-exec.deviation-eligibility"), {
      transition: "plan-exec.deviation-recognition",
      signals: ["plan.deviation-structural"],
    });
    const atEligibility = resolveBoundary(state, EXEC);
    expect(atEligibility.stopped?.id).toBe("plan-exec.deviation-eligibility");

    const atGate = resolveBoundary(applyTransition(state, "plan-exec.deviation-eligibility"), EXEC);
    expect(atGate.stopped?.id).toBe("plan-exec.deviation-gate");
    expect(atGate.kind).toBe("human");
  });

  it("y ofrece sus CUATRO salidas, con la de componer recomendada", () => {
    const gate = rowOf("plan-exec.deviation-gate");
    expect(gate.authority).toBe("human");
    expect(gate.alternatives?.map((a) => a.label)).toEqual([
      "Registrar la decisión y seguir",
      "Volver a plan-refine",
      "Volver a spec-refine",
      "Escalar a una spec nueva",
    ]);
    expect(gate.alternatives?.filter((a) => a.recommended).map((a) => a.label)).toEqual([
      "Registrar la decisión y seguir",
    ]);
  });

  it("cada salida dice a dónde deja la corrida: ninguna alternativa es una etiqueta suelta", () => {
    for (const alternative of rowOf("plan-exec.deviation-gate").alternatives ?? []) {
      expect(alternative.consequence.length).toBeGreaterThan(20);
    }
  });

  it("el gate no delega ninguna invocación: la decisión es de la persona, no una acción a correr", () => {
    expect(actionOf(rowOf("plan-exec.deviation-gate"))).toBeNull();
  });

  it("sin desviación declarada el gate se salta y la ejecución sigue — el default de la doctrina", () => {
    // El salto lo decide el WALK, no la resolución de la frontera: `resolveBoundary`
    // devuelve la próxima fila pendiente y `advanceFlowRun` es quien aplica la
    // condición y la pasa por encima cuando no disparó.
    const advanced = advanceFlowRun({
      state: upTo("plan-exec.deviation-eligibility"),
      journey: EXEC,
    });
    if (!advanced.ok) throw new Error("esperaba avanzar");
    const skipped = advanced.state.applied.includes("plan-exec.deviation-gate");
    expect(skipped).toBe(true);
    expect(advanced.directive.boundary.transition).not.toBe("plan-exec.deviation-gate");
  });
});

describe("F4 — la elegibilidad es cierre, no tamaño", () => {
  const eligibility = rowOf("plan-exec.deviation-eligibility");

  it("su vocabulario son las cuatro condiciones que tienen que cerrar", () => {
    expect(eligibility.signals).toEqual([
      "plan.closure-lineage",
      "plan.closure-intent",
      "plan.closure-impact",
      "plan.closure-recoverable",
    ]);
  });

  it("ninguna señal del vocabulario habla de cantidades", () => {
    const quantity = /count|size|total|number|cantidad|tamaño|criteri|phase|repo/i;
    expect((eligibility.signals ?? []).filter((s) => quantity.test(s))).toEqual([]);
  });

  it("el reconocimiento admite la salida componible y la escalación", () => {
    expect(rowOf("plan-exec.deviation-recognition").signals).toEqual([
      "plan.deviation-structural",
      "plan.deviation-functional",
      "plan.deviation-composable",
      "plan.deviation-escalation",
    ]);
  });
});

describe("F4 — dos divergencias en una misma corrida sobreviven las dos", () => {
  it("la segunda no borra a la primera", () => {
    const first = withObservation(newRunState("plan-exec", SESSION), {
      transition: "plan-exec.deviation-recognition",
      signals: ["plan.deviation-composable"],
    });
    const second = withObservation(first, {
      transition: "plan-exec.deviation-recognition",
      signals: ["plan.deviation-structural"],
    });
    expect(second.observations).toEqual([
      { transition: "plan-exec.deviation-recognition", signals: ["plan.deviation-composable"] },
      { transition: "plan-exec.deviation-recognition", signals: ["plan.deviation-structural"] },
    ]);
  });

  it("y el gate sigue disparando con las dos declaradas", () => {
    let state = upTo("plan-exec.deviation-eligibility");
    state = withObservation(state, {
      transition: "plan-exec.deviation-recognition",
      signals: ["plan.deviation-composable"],
    });
    state = withObservation(state, {
      transition: "plan-exec.deviation-recognition",
      signals: ["plan.deviation-structural"],
    });
    const resolved = resolveBoundary(
      applyTransition(state, "plan-exec.deviation-eligibility"),
      EXEC,
    );
    expect(resolved.stopped?.id).toBe("plan-exec.deviation-gate");
  });
});

describe("F4 — la escalación viaja con su paquete y el destino lo declara consumido", () => {
  it("una desviación estructural abre la fila que empaqueta la escalación", () => {
    let state = upTo("plan-exec.deviation-eligibility");
    state = withObservation(state, {
      transition: "plan-exec.deviation-recognition",
      signals: ["plan.deviation-structural"],
    });
    for (const id of ["plan-exec.deviation-eligibility", "plan-exec.deviation-gate"]) {
      state = applyTransition(state, id);
    }
    expect(resolveBoundary(state, EXEC).stopped?.id).toBe("plan-exec.escalation-package");
  });

  it("una decisión componible NO la abre: no hay escalación que empaquetar", () => {
    let state = upTo("plan-exec.deviation-eligibility");
    state = withObservation(state, {
      transition: "plan-exec.deviation-recognition",
      signals: ["plan.deviation-composable"],
    });
    for (const id of ["plan-exec.deviation-eligibility", "plan-exec.deviation-gate"]) {
      state = applyTransition(state, id);
    }
    const advanced = advanceFlowRun({ state, journey: EXEC });
    if (!advanced.ok) throw new Error("esperaba avanzar");
    // Se salta con su causa, no se queda esperando una entrega que no existe.
    expect(advanced.state.applied).toContain("plan-exec.escalation-package");
    expect(advanced.directive.boundary.transition).not.toBe("plan-exec.escalation-package");
  });

  it("los dos destinos declaran si consumieron el paquete o si no llegó ninguno", () => {
    expect(rowOf("plan-refine.escalation-adoption").signals).toEqual([
      "plan.escalation-adopted",
      "plan.escalation-absent",
    ]);
    expect(rowOf("spec-refine.escalation-adoption").signals).toEqual([
      "spec.escalation-adopted",
      "spec.escalation-absent",
    ]);
  });

  it("y cada uno sigue al preview de ruta como la primera fila de juicio del dominio", () => {
    for (const [flow, id] of [
      ["plan-refine", "plan-refine.escalation-adoption"],
      ["spec-refine", "spec-refine.escalation-adoption"],
    ] as const) {
      const journey = journeyOfFlow(flow);
      const judgment = journey.filter((decision) => decision.authority === "agent");
      expect(judgment[0]?.id).toBe("chassis.route-evaluation");
      expect(judgment[1]?.id).toBe(id);
    }
  });
});
