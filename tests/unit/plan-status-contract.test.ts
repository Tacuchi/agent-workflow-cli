// Spec 066, ID01-ID02: el plan declara su estado en un único campo, una línea
// «Próximo paso» mientras se ejecuta y hasta cinco líneas de evidencia por lote.
// Los valores del modelo de sesiones se leen sólo para nombrar la migración.

import { describe, expect, it } from "vitest";
import { parseBatchEvidence } from "../../src/application/parsers/batch-evidence.js";
import { parsePhases } from "../../src/application/parsers/phases.js";
import { PLAN_STATES, parsePlanStatus } from "../../src/application/parsers/plan-status.js";
import { validatePlanStatusContract } from "../../src/application/plan-status-contract.js";

const plan = (preamble: string[], tail: string[] = []) =>
  [
    "# Plan 012 — checkout",
    "",
    "> Derived from docs/specs/003-spec-foo.md",
    ...preamble,
    "",
    "## Tasks",
    "",
    "### F1 — El carrito acepta un cupón",
    "> Estado: validada",
    "- [x] T1.1",
    "",
    "### F2 — El cupón vence",
    "> Estado: en ejecución",
    "- [ ] T2.1",
    "",
    ...tail,
  ].join("\n");

const codes = (text: string) => validatePlanStatusContract(text).map((failure) => failure.code);

describe("el campo único de estado del plan", () => {
  it("lee los cinco valores exactos del contrato nuevo", () => {
    expect([...PLAN_STATES]).toEqual(["draft", "ready", "in-progress", "done", "abandoned"]);
    for (const value of ["draft", "ready", "done", "abandoned"]) {
      const status = parsePlanStatus(plan([`> Estado: ${value}`]));
      expect(status.declared, value).toBe(value);
      expect(status.unmigrated, value).toBeNull();
      expect(codes(plan([`> Estado: ${value}`])), value).toEqual([]);
    }
    const running = plan(["> Estado: in-progress", "> Próximo paso: T2.1 — vencer el cupón"]);
    expect(parsePlanStatus(running)).toMatchObject({
      declared: "in-progress",
      unmigrated: null,
      next_step: { task: "T2.1", text: "T2.1 — vencer el cupón", line: 5 },
    });
    expect(codes(running)).toEqual([]);
  });

  it("trata open y los sufijos heredados como hub sin migrar, nombrando aw hub-migrate", () => {
    expect(parsePlanStatus(plan(["> Estado: open"])).unmigrated).toBe("legacy-value");
    expect(parsePlanStatus(plan(["> Estado: done — 2026-07-27 · sesión 123"])).unmigrated).toBe(
      "legacy-suffix",
    );
    for (const legacy of ["> Estado: open", "> Estado: done — 2026-07-27 · sesión 123"]) {
      const failures = validatePlanStatusContract(plan([legacy]));
      expect(
        failures.map((failure) => failure.code),
        legacy,
      ).toEqual(["PLAN_STATUS_UNMIGRATED"]);
      expect(failures[0]?.message).toContain("aw hub-migrate");
      expect(failures[0]?.line).toBe(4);
    }
  });

  it("un valor ilegible no se lee como ningún estado; uno ausente lo sella la publicación", () => {
    expect(codes(plan(["> Estado: cerrado"]))).toEqual(["PLAN_STATUS_INVALID"]);
    expect(parsePlanStatus(plan([])).declared).toBe("absent");
    expect(codes(plan([]))).toEqual([]);
  });

  it("el próximo paso va sólo mientras el plan está in-progress", () => {
    expect(codes(plan(["> Estado: in-progress"]))).toEqual(["PLAN_NEXT_STEP_MISSING"]);
    expect(codes(plan(["> Estado: ready", "> Próximo paso: T2.1 — x"]))).toEqual([
      "PLAN_NEXT_STEP_MISPLACED",
    ]);
  });

  it("los estados de fase no cambian", () => {
    const phases = parsePhases(
      plan(["> Estado: in-progress", "> Próximo paso: T2.1 — vencer el cupón"]),
    );
    expect(phases.items.map((phase) => phase.state)).toEqual(["validada", "en ejecución"]);
  });
});

describe("la evidencia acotada por lote", () => {
  const evidence = (...lines: string[]) =>
    plan(["> Estado: done"], ["## Evidencia de lotes", "", ...lines, ""]);

  it("lee la fila del lote con sus hashes y sus sub-viñetas", () => {
    const parsed = parseBatchEvidence(
      evidence(
        "- B1 · cli 1a2b3c4",
        "  - Validado: vitest 40/40",
        "  - Externo sin comprobar: despliegue",
        "- B2 · cli 5d6e7f8",
      ),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed.groups.map((group) => [group.batch, group.commits, group.lines])).toEqual([
      ["B1", "cli 1a2b3c4", 3],
      ["B2", "cli 5d6e7f8", 1],
    ]);
    expect(parsed.groups[0]?.entries.map((entry) => entry.label)).toEqual([
      "Validado",
      "Externo sin comprobar",
    ]);
  });

  it("acepta cinco líneas y rechaza la sexta", () => {
    const five = [
      "- B1 · cli 1a2b3c4",
      "  - Validado: a",
      "  - Fallido: b",
      "  - Pendiente: c",
      "  - Externo sin comprobar: d",
    ];
    expect(codes(evidence(...five))).toEqual([]);
    expect(codes(evidence(...five, "  - nota: e"))).toEqual([
      "PLAN_BATCH_EVIDENCE_TOO_LONG",
      "PLAN_BATCH_EVIDENCE_INVALID",
    ]);
  });

  it("rechaza una etiqueta fuera del vocabulario o una línea suelta", () => {
    expect(codes(evidence("- B1 · cli 1a2b3c4", "  - Log: 300 líneas"))).toEqual([
      "PLAN_BATCH_EVIDENCE_INVALID",
    ]);
    expect(codes(evidence("salida pegada del test"))).toEqual(["PLAN_BATCH_EVIDENCE_INVALID"]);
  });
});
