// Un efecto que puede legítimamente no ocurrir, y la fila que lo exigía igual.
//
// Las filas manuales de PLAN-exec se retiraron: el batch interno deriva su rango
// desde el documento y publica su CAS, así que no necesita una señal que un agente
// pueda afirmar. Sólo queda la condición de scripts de QUICK, donde la señal sí
// expresa un hecho semántico que el CLI no puede derivar por sí solo.
//
// Lo que se fija acá, en los dos sentidos: la fila APLICA cuando su señal se
// observó, se SALTA con su razón cuando no, y las demás filas delegadas con efecto
// no cambiaron — porque su efecto sí ocurre siempre.

import { describe, expect, it } from "vitest";
import { FLOW_DECISIONS, type FlowDecision, conditionOf } from "../../src/domain/flow/authority.js";

/** La única acción con efecto que legítimamente puede no ocurrir. */
const CONDICIONADAS: ReadonlyArray<{ id: string; signal: string; declaredAt: string }> = [
  { id: "quick.db-scripts-only", signal: "quick.db-touched", declaredAt: "quick.db-touched" },
];

function rowOf(id: string): FlowDecision {
  const row = FLOW_DECISIONS.find((decision) => decision.id === id);
  if (row === undefined) throw new Error(`el registro ya no tiene '${id}'`);
  return row;
}

describe("efectos que pueden no ocurrir — la fila los condiciona", () => {
  it("la fila declara su condición sobre la señal que la habilita", () => {
    for (const { id, signal, declaredAt } of CONDICIONADAS) {
      const condition = conditionOf(rowOf(id));
      expect(condition, id).not.toBeNull();
      expect(condition?.threshold.observed, id).toBe(declaredAt);
      expect(condition?.threshold.of, id).toContain(signal);
      expect(condition?.threshold.min, id).toBe(1);
    }
  });

  it("cada `otherwise` dice por qué se pasa por alto, no que se pasó por alto", () => {
    for (const { id } of CONDICIONADAS) {
      const otherwise = conditionOf(rowOf(id))?.otherwise ?? "";
      // Una razón vacía o de una palabra deja al lector sin saber qué pasó.
      expect(otherwise.trim().length, id).toBeGreaterThan(30);
    }
  });

  it("la señal que habilita cada fila está declarada por una fila ANTERIOR del mismo recorrido", () => {
    for (const { id, signal, declaredAt } of CONDICIONADAS) {
      const row = rowOf(id);
      const declarer = rowOf(declaredAt);
      expect(declarer.signals ?? [], `${declaredAt} declara ${signal}`).toContain(signal);
      // Y quien declara es juicio del agente, no regla del CLI: el motor no puede
      // saber por sí mismo si quedó una casilla sin marcar.
      expect(declarer.authority, declaredAt).toBe("agent");
      // El orden importa: una condición que lee una fila posterior nunca dispara.
      const scope = FLOW_DECISIONS.filter((d) => d.scope === row.scope);
      expect(
        scope.findIndex((d) => d.id === declaredAt),
        `${declaredAt} antes de ${id}`,
      ).toBeLessThan(scope.findIndex((d) => d.id === id));
    }
  });

  it("las señales son POSITIVAS: nombran que hay algo que hacer, no que no lo hay", () => {
    // El umbral del motor es positivo — la fila aplica cuando la señal se observó.
    // Una señal redactada al revés («no hay nada que marcar») invertiría el sentido
    // y saltearía un paso que SÍ aplicaba, acreditando trabajo que nadie hizo.
    for (const { signal } of CONDICIONADAS) {
      expect(signal, signal).not.toMatch(/\b(no|nothing|empty|absent|none)\b/i);
    }
  });

  it("ninguna otra fila del registro condiciona sobre estas señales", () => {
    // Una señal reutilizada por dos filas las vuelve indistinguibles: cualquiera
    // de las dos dispararía por la otra.
    const nuestras = new Set(CONDICIONADAS.map((x) => x.signal));
    for (const row of FLOW_DECISIONS) {
      if (CONDICIONADAS.some((x) => x.id === row.id)) continue;
      const of = conditionOf(row)?.threshold.of ?? [];
      expect(
        of.filter((signal) => nuestras.has(signal)),
        row.id,
      ).toEqual([]);
    }
  });
});
