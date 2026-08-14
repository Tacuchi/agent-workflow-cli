// Un efecto que puede legítimamente no ocurrir, y la fila que lo exigía igual.
//
// Cuatro filas delegadas del registro declaraban su efecto SIN condición, así que
// un batch válido que no tenía ese efecto no podía contestarlas con la verdad: la
// única respuesta honesta era negarlo, y una frontera negada que se vuelve a emitir
// agota sus intentos y detiene la corrida. Pasó de verdad — `plan-exec.task-marking`
// agotó los tres intentos en una corrida con 11 de 11 casillas ya marcadas.
//
// Lo que se fija acá, en los dos sentidos: la fila APLICA cuando su señal se
// observó, se SALTA con su razón cuando no, y las demás filas delegadas con efecto
// no cambiaron — porque su efecto sí ocurre siempre.

import { describe, expect, it } from "vitest";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  actionOf,
  conditionOf,
  effectsOf,
  flowOfScope,
} from "../../src/domain/flow/authority.js";

/** Las cuatro, y la señal que las habilita. */
const CONDICIONADAS: ReadonlyArray<{ id: string; signal: string; declaredAt: string }> = [
  {
    id: "plan-exec.task-marking",
    signal: "plan.tasks-to-mark",
    declaredAt: "plan-exec.pending-effects",
  },
  {
    id: "plan-exec.plan-done",
    signal: "plan.plan-closable",
    declaredAt: "plan-exec.pending-effects",
  },
  {
    id: "plan-exec.commit-execution",
    signal: "plan.commit-pending",
    declaredAt: "plan-exec.pending-effects",
  },
  { id: "quick.db-scripts-only", signal: "quick.db-touched", declaredAt: "quick.db-touched" },
];

function rowOf(id: string): FlowDecision {
  const row = FLOW_DECISIONS.find((decision) => decision.id === id);
  if (row === undefined) throw new Error(`el registro ya no tiene '${id}'`);
  return row;
}

/** Filas delegadas de un recorrido público que declaran un efecto propio. */
function delegatedWithEffects(): FlowDecision[] {
  const SELF = ["read_only"];
  return FLOW_DECISIONS.filter(
    (row) =>
      flowOfScope(row.scope) !== null &&
      actionOf(row) !== null &&
      effectsOf(row).some((effect) => !SELF.includes(effect)),
  );
}

describe("efectos que pueden no ocurrir — la fila los condiciona", () => {
  it("las cuatro declaran su condición sobre la señal que las habilita", () => {
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

  it("las demás filas delegadas con efecto NO cambiaron: su efecto siempre ocurre", () => {
    const condicionadas = new Set(CONDICIONADAS.map((x) => x.id));
    const resto = delegatedWithEffects().filter((row) => !condicionadas.has(row.id));
    // Trece, y ninguna con condición. Si una gana una, es una decisión que hay
    // que justificar acá: dar condición a una fila cuyo efecto sí ocurre siempre
    // abre un camino para declarar hecho lo que no se hizo.
    //
    // La decimotercera es `plan-new.numbering`, que dejó de ser sólo atribución:
    // el reclamo del correlativo ESCRIBE el slot en `docs/plans` —siempre, sin
    // condición— y ahora viaja como la acción delegada que es, con la reserva que
    // produjo como evidencia. Antes el motor acreditaba la transición sin que nada
    // hubiera tocado el workspace.
    //
    // Siguen siendo doce, con tres altas y tres bajas: entran las publicaciones de
    // propuesta —spec, plan y plan refinado—, que escriben SIEMPRE porque sólo se
    // llega a ellas con una propuesta sellada y aprobada; salen las tres
    // escrituras que absorbieron (`spec-refine.status-promotion`,
    // `plan-refine.split-in-place` y `plan-refine.normalize-on-write`).
    // `split-in-place` sobrevive como fila sin efecto: decide qué bytes se
    // proponen, y su condición ya no gobierna ninguna escritura.
    //
    // La decimocuarta es `plan-exec.unit-acquisition`, y tampoco lleva condición
    // por la misma razón: el scope que la habilita NUNCA está vacío —una corrida
    // que no aísla ninguna fuente no tiene dónde escribir, y el CLI rechaza esa
    // respuesta— así que la unidad se crea siempre. Y cuando ya existe, el efecto
    // igual ocurre: el árbol ESTÁ, que es la misma lectura que hace la
    // publicación de una propuesta ya aplicada.
    //
    // La decimoquinta es `plan-exec.unit-integration`, sin condición por el mismo
    // motivo que su gemela de apertura: la corrida llega acá con una unidad por
    // cada fuente de su scope, así que siempre hay algo que integrar. Condicionarla
    // sería exactamente el camino que este test cierra — una fila que se puede
    // saltar es una fila que puede declarar integrado lo que sigue en su rama.
    expect(resto.length).toBe(15);
    expect(resto.filter((row) => conditionOf(row) !== null).map((row) => row.id)).toEqual([]);
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
