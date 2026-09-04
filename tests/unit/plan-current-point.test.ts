// El punto de reanudación VIGENTE (plan 042 · F3 · D6, y la base de F4).
//
// Una nota de decisión graba su punto el día que se escribió, y eso es historia:
// cuando alguien vuelve a saldar la obligación que creó, la fase que nombró
// puede estar validada e integrada. Ofrecerla como lugar al que volver manda a
// trabajo ya hecho — que es exactamente lo que pasó en el incidente.

import { describe, expect, it } from "vitest";
import { currentResumePoint } from "../../src/application/plan-current-point.js";

const phase = (n: number, state: string, extra: readonly string[] = []): string[] => [
  `### F${n} — fase ${n}`,
  `> Estado: ${state}`,
  ...extra,
  "",
  `- [ ] T${n}.1 — trabajo _(fuentes: workspace)_`,
  "",
];

const plan = (...blocks: readonly string[][]): string =>
  ["# 032 — plan", "", "## Tasks", "", ...blocks.flat()].join("\n");

describe("currentResumePoint", () => {
  it("es la primera fase no validada, aunque la nota apunte a una anterior", () => {
    expect(currentResumePoint(plan(phase(1, "validada"), phase(2, "pendiente")))).toBe(
      "F2 — fase 2",
    );
  });

  it("con todas validadas es el cierre: ahí es donde vive el saldo", () => {
    expect(currentResumePoint(plan(phase(1, "validada"), phase(2, "validada")))).toBe(
      "el cierre del plan",
    );
  });

  it("una fase bloqueada es el punto, y su motivo viaja con ella", () => {
    const text = plan(
      phase(1, "validada"),
      phase(2, "bloqueada", ["> Bloqueo: falta aplicar la migración 014"]),
    );

    expect(currentResumePoint(text)).toBe(
      "F2 — fase 2 (bloqueada: falta aplicar la migración 014)",
    );
  });

  it("el orden es por NÚMERO, no por posición en el documento", () => {
    // Un plan cuyos bloques quedaron desordenados nombraría la fase equivocada
    // si se leyera en orden de documento.
    const text = plan(phase(3, "pendiente"), phase(1, "validada"), phase(2, "pendiente"));

    expect(currentResumePoint(text)).toBe("F2 — fase 2");
  });

  it("un plan SIN contrato de fases no dice «el cierre»: dice que no lo declara", () => {
    // El caso de los planes legados, que es donde un saldo transversal apunta
    // más seguido. «Todo validado» y «este documento no declara estados» no
    // pueden leerse igual: lo segundo informado como lo primero es trabajo sin
    // terminar reportado como terminado.
    const legacy = [
      "# 032 — plan legado",
      "",
      "## Tasks",
      "",
      "### F1 — la primera",
      "",
      "- [ ] T1.1 — trabajo",
      "",
    ].join("\n");

    expect(currentResumePoint(legacy)).toBe("sin contrato de fases: el plan no declara estados");
  });

  it("un plan sin sección de tareas tampoco inventa un cierre", () => {
    expect(currentResumePoint("# 032 — plan\n\n## Origin\n\ntexto\n")).toBe(
      "sin contrato de fases: el plan no declara estados",
    );
  });
});
