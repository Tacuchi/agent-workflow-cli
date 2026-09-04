import { describe, expect, it } from "vitest";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  alternativesOf,
  approvalGrantOf,
  custodyOf,
  effectsOf,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";
import {
  CUSTODY_COVERABLE_CLASSES,
  type SealedSubject,
  authorizeTransition,
} from "../../src/domain/flow/authorization.js";

/**
 * Custodia de la corrida — el chasis administra sus propios libros sin preflight.
 *
 * Lo que se fija acá:
 *
 * 1. **La custodia es dato del registro, no inferencia.** Las filas cuyos efectos
 *    ejercen sobre la contabilidad de la propia corrida —su sesión, su estado, las
 *    marcas de avance del doc del flow, correr los criterios que la corrida misma
 *    declaró— la declaran explícitamente, y la lista es cerrada: agregarle custodia
 *    a una fila nueva es una edición consciente de este test.
 * 2. **La custodia tiene techo.** Jamás cubre `destructive` ni `network_external`,
 *    declare lo que declare la fila; y una propuesta sellada nunca viaja cubierta
 *    por custodia — los bytes aprobables son material de alguien, no contabilidad.
 * 3. **Aprobar el commit ES autorizarlo.** La fila humana declara a qué transición
 *    autoriza su label afirmativo, así que decidir una vez nunca se re-pregunta
 *    después con otro vocabulario («Autorizar el efecto»).
 */

const CUSTODY_ROWS = [
  "chassis.finalize",
  "quick.convergence-gate",
  "plan-exec.validation-execution",
  "plan-exec.batch-close",
  // El saldo del cierre: lo que aterriza es el sucesor de una nota cuyo registro
  // una persona ya autorizó en el gate de desviación, derivado —nunca redactado—
  // de la evidencia que la corrida declaró una fila más arriba. Edición
  // consciente de esta lista, no un agregado silencioso.
  "plan-exec.settlement-publication",
  "plan-exec.plan-done",
];

function rowOf(id: string): FlowDecision {
  const row = FLOW_DECISIONS.find((decision) => decision.id === id);
  if (row === undefined) throw new Error(`el registro ya no tiene '${id}'`);
  return row;
}

describe("custodia de la corrida: la contabilidad propia no pide preflight", () => {
  it("cada fila con custodia avanza sin grant: nada queda missing", () => {
    for (const id of CUSTODY_ROWS) {
      const verdict = authorizeTransition(rowOf(id), []);
      expect(verdict.missing, id).toEqual([]);
      for (const effect of effectsOf(rowOf(id))) {
        expect(verdict.covered, id).toContain(effect);
      }
    }
  });

  it("la custodia declarada en el registro es exactamente la esperada", () => {
    const declared = FLOW_DECISIONS.filter((row) => custodyOf(row) === "run").map((row) => row.id);
    expect([...declared].sort()).toEqual([...CUSTODY_ROWS].sort());
  });

  it("ninguna fila con custodia declara efectos fuera del techo", () => {
    for (const row of FLOW_DECISIONS) {
      if (custodyOf(row) !== "run") continue;
      for (const effect of effectsOf(row)) {
        expect(CUSTODY_COVERABLE_CLASSES, row.id).toContain(effect);
      }
    }
  });

  it("la custodia jamás cubre destructive ni network_external, declare lo que declare la fila", () => {
    const liar = {
      ...rowOf("chassis.finalize"),
      id: "fixture.liar",
      effects: ["destructive", "network_external", "mutate_overwrite"],
    } as FlowDecision;
    const verdict = authorizeTransition(liar, []);
    expect(verdict.covered).toEqual(["mutate_overwrite"]);
    expect(verdict.missing).toEqual(["destructive", "network_external"]);
  });

  it("una propuesta sellada nunca viaja cubierta por custodia", () => {
    const subject: SealedSubject = {
      digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      scope: { sensitive_sources: false, scope_expanded: false },
      effects: ["mutate_overwrite"],
    };
    const verdict = authorizeTransition(rowOf("chassis.finalize"), [], subject);
    expect(verdict.missing).toEqual(["mutate_overwrite"]);
  });
});

describe("la aprobación humana del commit ES el grant de su ejecución", () => {
  it("la fila de autorización enlaza la ejecución con su label afirmativo", () => {
    const link = approvalGrantOf(rowOf("plan-exec.commit-authorization"));
    expect(link).toEqual({
      approve: "Aprobar los commits del batch",
      transition: "plan-exec.commit-execution",
    });
  });

  it("el label que otorga existe entre las alternativas y la transición en la jornada", () => {
    for (const row of FLOW_DECISIONS) {
      const link = approvalGrantOf(row);
      if (link === null) continue;
      const labels = (alternativesOf(row) ?? []).map((choice) => choice.label);
      expect(labels, row.id).toContain(link.approve);
      // El grant se computa sobre el sello de la transición enlazada: una que la
      // jornada no camina sería un grant sobre nada, escondido hasta producción.
      const flow = row.scope === "plan-exec" ? "plan-exec" : null;
      expect(flow, `${row.id}: extendé este test al scope '${row.scope}'`).not.toBeNull();
      const journey = journeyOfFlow("plan-exec");
      expect(
        journey.some((candidate) => candidate.id === link.transition),
        row.id,
      ).toBe(true);
    }
  });
});
