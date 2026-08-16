// Las fronteras nuevas conservan su semántica en todos los hosts (T8.1 del plan
// 032, S033/AC-14).
//
// La equivalencia general ya la prueba `flow-host-equivalence.test.ts` sobre el
// recorrido entero, y por eso cubre estas filas sin nombrarlas. Lo que NO cubre
// es lo propio de este plan: que las salidas del gate de desviación y las filas
// que nacieron con él lleguen COMPLETAS a un host que sólo puede escribir
// markdown etiquetado. Degradar el mecanismo es legítimo; perder una alternativa
// no lo es, porque la que se caiga es una decisión que nadie va a poder tomar.

import { describe, expect, it } from "vitest";
import {
  type FlowDecision,
  alternativesOf,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";

/** Las filas que este plan agregó o cambió de autoridad. */
const NEW_ROWS = [
  "plan-exec.deviation-eligibility",
  "plan-exec.deviation-gate",
  "plan-exec.escalation-package",
  "spec-refine.escalation-adoption",
  "plan-refine.escalation-adoption",
] as const;

function rowsOf(flow: "plan-exec" | "spec-refine" | "plan-refine"): FlowDecision[] {
  return journeyOfFlow(flow);
}

const ALL_ROWS: FlowDecision[] = [
  ...rowsOf("plan-exec"),
  ...rowsOf("spec-refine"),
  ...rowsOf("plan-refine"),
];

function row(id: string): FlowDecision {
  const found = ALL_ROWS.find((r) => r.id === id);
  if (found === undefined) throw new Error(`la fila ${id} no está en ningún recorrido`);
  return found;
}

describe("T8.1 — las fronteras nuevas existen en su recorrido y con su autoridad", () => {
  it.each(NEW_ROWS)("%s está registrada", (id) => {
    expect(row(id).id).toBe(id);
  });

  it("el gate de desviación es de la PERSONA, no del CLI", () => {
    expect(row("plan-exec.deviation-gate").authority).toBe("human");
  });
});

describe("T8.1 — ninguna alternativa se pierde al degradar a markdown etiquetado", () => {
  const humanRows = ALL_ROWS.filter(
    (r) =>
      (r.authority === "human" || r.authority === "authorization") &&
      NEW_ROWS.includes(r.id as (typeof NEW_ROWS)[number]),
  );

  it("hay fronteras nuevas que presentar", () => {
    expect(humanRows.length).toBeGreaterThan(0);
  });

  it.each(humanRows.map((r) => r.id))(
    "%s da cada alternativa con su etiqueta Y su frase funcional",
    (id) => {
      const alternatives = alternativesOf(row(id));
      expect(alternatives.length).toBeGreaterThan(0);
      for (const alternative of alternatives) {
        // La etiqueta es lo que se contesta; la frase es lo que deja decidir. Una
        // etiqueta sin frase obliga a adivinar qué hace la opción, que es
        // exactamente la pérdida que el fallback no puede permitirse.
        expect(alternative.label.trim().length, `${id}: etiqueta`).toBeGreaterThan(0);
        expect(
          alternative.consequence.trim().length,
          `${id}: frase de ${alternative.label}`,
        ).toBeGreaterThan(2);
      }
    },
  );

  it("el gate ofrece sus CUATRO salidas, y las cuatro sobreviven a la degradación", () => {
    const alternatives = alternativesOf(row("plan-exec.deviation-gate"));
    expect(alternatives).toHaveLength(4);

    // El fallback del host: cada alternativa como `Etiqueta — frase funcional`.
    const markdown = alternatives.map((a) => `- ${a.label} — ${a.consequence}`).join("\n");
    for (const alternative of alternatives) {
      expect(markdown).toContain(alternative.label);
      expect(markdown).toContain(alternative.consequence);
    }
    expect(markdown.split("\n")).toHaveLength(4);

    // Y ninguna etiqueta se repite: dos opciones con el mismo nombre son una
    // opción menos en cuanto alguien contesta por etiqueta.
    expect(new Set(alternatives.map((a) => a.label)).size).toBe(4);
  });
});

describe("T8.1 — la semántica no cambia con el host", () => {
  it("ninguna fila nueva nombra un host, una capacidad nativa ni un mecanismo de UI", () => {
    const forbidden = [
      "claude",
      "codex",
      "gemini",
      "cursor",
      "kimi",
      "AskUserQuestion",
      "markdown",
    ];
    for (const id of NEW_ROWS) {
      const serialized = JSON.stringify(row(id)).toLowerCase();
      for (const token of forbidden) {
        expect(serialized, `${id} menciona ${token}`).not.toContain(token.toLowerCase());
      }
    }
  });

  it("cada fila nueva declara su documento de doctrina, que es el mismo para todo host", () => {
    for (const id of NEW_ROWS) {
      expect(row(id).document.length, id).toBeGreaterThan(0);
    }
  });
});
