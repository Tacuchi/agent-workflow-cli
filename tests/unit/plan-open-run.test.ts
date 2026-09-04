// Quién tiene un plan, que es la mitad de la salida que el tablero nombra y la
// condición entera del rechazo de `aw settle`. Las tres lecturas se prueban en
// `settle.test.ts` sobre corridas reales; acá se fija la PRECEDENCIA entre ellas,
// que es lo que decide qué sesión se nombra y si se bloquea o no.

import { describe, expect, it } from "vitest";
import { type HoldingRun, holdingRunOf } from "../../src/application/plan-open-run.js";

const PLAN = "docs/plans/042-plan-x.md";

function run(session: string): HoldingRun {
  return { session, command: `aw flow advance --code ${session}`, why: "la tiene" };
}

describe("holdingRunOf — cuál de las lecturas manda", () => {
  it("la corrida que NOMBRA el plan le gana a una ilegible", () => {
    const found = holdingRunOf(
      { byPlan: new Map([[PLAN, run("167-x")]]), unreadable: run("099-ilegible") },
      PLAN,
    );

    // Se prefiere la específica porque su rechazo dice qué plan y qué sesión; la
    // ilegible sigue valiendo para todo plan que ninguna corrida nombre.
    expect(found?.session).toBe("167-x");
  });

  it("la ilegible bloquea todo plan que nadie nombró", () => {
    const found = holdingRunOf(
      { byPlan: new Map([["docs/plans/001-otro.md", run("167-x")]]), unreadable: run("099") },
      PLAN,
    );

    expect(found?.session).toBe("099");
  });

  it("sin corrida ilegible y sin coincidencia, no hay nadie que lo tenga", () => {
    expect(holdingRunOf({ byPlan: new Map(), unreadable: null }, PLAN)).toBeNull();
  });

  it("una ruta que sólo difiere en mayúsculas cuenta como el mismo plan", () => {
    // En un sistema de archivos insensible a mayúsculas —macOS por defecto— las
    // dos rutas son UN documento, y una comparación exacta contestaría «no hay
    // corrida sobre este plan» sobre un plan que una corrida está teniendo.
    const found = holdingRunOf(
      { byPlan: new Map([["docs/Plans/042-Plan-X.md", run("167-x")]]), unreadable: null },
      PLAN,
    );

    expect(found?.session).toBe("167-x");
  });

  it("la coincidencia exacta se prueba primero: dos rutas casi iguales no se mezclan", () => {
    const found = holdingRunOf(
      {
        byPlan: new Map([
          ["docs/Plans/042-Plan-X.md", run("099-plegada")],
          [PLAN, run("167-exacta")],
        ]),
        unreadable: null,
      },
      PLAN,
    );

    expect(found?.session).toBe("167-exacta");
  });
});
