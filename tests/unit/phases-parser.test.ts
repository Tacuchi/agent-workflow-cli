import { describe, expect, it } from "vitest";
import { parsePhases } from "../../src/application/parsers/phases.js";

const states = (text: string) => parsePhases(text).items.map((p) => p.state);

describe("parsePhases", () => {
  it("reads one state per `### Fn` block, whatever the heading dash or the casing", () => {
    const plan = [
      "# Plan 007 — checkout",
      "",
      "## Tasks",
      "",
      "### F1 — El carrito acepta un cupón",
      "> Estado: validada",
      "- [x] T1.1 — aplica el descuento",
      "",
      "### F2 - El descuento viaja al backend",
      "",
      "> Estado: en ejecucion",
      "- [ ] T2.1 — persiste el cupón",
      "",
      "### F3 — El descuento se persiste",
      "> **Estado:** Pendiente",
      "",
    ].join("\n");

    const out = parsePhases(plan);
    expect(out).toMatchObject({ total: 3, validated: 1 });
    expect(out.items).toEqual([
      { n: 1, name: "El carrito acepta un cupón", state: "validada" },
      { n: 2, name: "El descuento viaja al backend", state: "en ejecución" },
      { n: 3, name: "El descuento se persiste", state: "pendiente" },
    ]);
  });

  it("a legacy plan with no state line reads every phase as `pendiente`", () => {
    const legacy =
      "# Plan 004\n\n## Tasks\n\n### F1 — Modelo\n- [x] T1.1\n\n### F2 — API\n- [x] T2.1\n";
    expect(parsePhases(legacy)).toMatchObject({ total: 2, validated: 0 });
    expect(states(legacy)).toEqual(["pendiente", "pendiente"]);
  });

  it("only marks inside a block count: the plan-level line, a fenced example and a trailing section do not", () => {
    const plan = [
      "# Plan 009 — checkout",
      "",
      "> Estado: done — 2026-06-01 · sesión 120",
      "",
      "## Solution",
      "",
      "```markdown",
      "### F9 — bloque citado como ejemplo",
      "> Estado: validada",
      "```",
      "",
      "## Tasks",
      "",
      "### F1 — El carrito acepta un cupón",
      "> Estado: validada",
      "",
      "### F2 — El descuento se persiste",
      "- [ ] T2.1 — persiste el cupón",
      "",
      "## Validations",
      "> Estado: validada",
      "",
    ].join("\n");

    const out = parsePhases(plan);
    expect(out).toMatchObject({ total: 2, validated: 1 });
    expect(out.items.map((p) => p.n)).toEqual([1, 2]);
    expect(states(plan)).toEqual(["validada", "pendiente"]);
  });

  // The plan-level line already reads `done — <annotation>`; a phase whose proof
  // waits on an operational step (a migration nobody ran) needs the same shape.
  it("an annotation after a separator qualifies the state; glued text is noise", () => {
    const plan = [
      "### F1 — El esquema soporta el cupón",
      "> Estado: validada — SQL pendiente de aplicar",
      "",
      "### F2 — El descuento se persiste",
      "> Estado: pendiente · espera a F1",
      "",
      "### F3 — El cierre",
      "> Estado: validada porque las casillas están marcadas",
      "",
    ].join("\n");

    const out = parsePhases(plan);
    expect(out).toMatchObject({ total: 3, validated: 1 });
    expect(states(plan)).toEqual(["validada", "pendiente", "pendiente"]);
  });

  it("an unrecognized value degrades to `pendiente` instead of counting as validated", () => {
    const plan = "### F1 — Cupón\n> Estado: casi validada\n\n### F2 — Descuento\n> Estado:\n";
    expect(parsePhases(plan)).toMatchObject({ total: 2, validated: 0 });
    expect(states(plan)).toEqual(["pendiente", "pendiente"]);
  });

  it("a document without phase blocks yields no phases", () => {
    expect(parsePhases("# Plan 001\n\n## Tasks\n- [ ] T1 — algo\n")).toEqual({
      total: 0,
      validated: 0,
      items: [],
    });
  });
});
