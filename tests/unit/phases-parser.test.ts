import { describe, expect, it } from "vitest";
import { parsePhases } from "../../src/application/parsers/phases.js";

const states = (text: string) => parsePhases(text).items.map((p) => p.state);

/** A plan-doc whose `## Tasks` section holds the given lines. */
const planWithTasks = (...tasks: string[]) =>
  ["# Plan 007 — checkout", "", "## Tasks", "", ...tasks, ""].join("\n");

describe("parsePhases — the machine state is one exact value", () => {
  it("reads one state per `### Fn` block, whatever the heading dash or the casing", () => {
    const plan = planWithTasks(
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
    );

    const out = parsePhases(plan);
    expect(out).toMatchObject({ total: 3, validated: 1 });
    expect(out.items).toEqual([
      { n: 1, name: "El carrito acepta un cupón", state: "validada", blocker: null },
      { n: 2, name: "El descuento viaja al backend", state: "en ejecución", blocker: null },
      { n: 3, name: "El descuento se persiste", state: "pendiente", blocker: null },
    ]);
  });

  // A finished pre-contract plan must not read as "implemented, not validated":
  // without any `> Estado:` line the phase contract is not in force, so the
  // plan reports zero phases and keeps measuring progress by checkboxes.
  it("a plan with no state line at all predates the contract and reports zero phases", () => {
    const legacy = planWithTasks("### F1 — Modelo", "- [x] T1.1", "", "### F2 — API", "- [x] T2.1");
    expect(parsePhases(legacy)).toEqual({ total: 0, validated: 0, blocked: 0, items: [] });
  });

  it("a missing line among stated blocks reads `pendiente`, never zero phases", () => {
    const plan = planWithTasks(
      "### F1 — Modelo",
      "> Estado: validada",
      "- [x] T1.1",
      "",
      "### F2 — API",
      "- [x] T2.1",
    );
    expect(parsePhases(plan)).toMatchObject({ total: 2, validated: 1 });
    expect(states(plan)).toEqual(["validada", "pendiente"]);
  });

  it("the first `> Estado:` line of a block wins; a later one is prose", () => {
    const plan = planWithTasks("### F1 — Cupón", "> Estado: en ejecución", "> Estado: validada");
    expect(states(plan)).toEqual(["en ejecución"]);
  });

  // Written work and demonstrated result are two different things: the boxes
  // may all be ticked while the proof waits on a migration nobody applied. The
  // phase is `bloqueada`, and its reason rides on its own `> Bloqueo:` line.
  it("`validada` annotated with a pending migration is not a validated phase", () => {
    const plan = planWithTasks(
      "### F1 — El esquema soporta el cupón",
      "> Estado: validada — SQL pendiente de aplicar",
      "- [x] T1.1 — Preparar la migración.",
      "- [x] T1.2 — Conectar el adaptador de persistencia.",
      "",
      "### F2 — El descuento se persiste",
      "> Estado: bloqueada",
      "> Bloqueo: verificación pendiente después de aplicar la migración SQL.",
      "- [x] T2.1 — Persistir el cupón.",
    );

    const out = parsePhases(plan);
    expect(out).toMatchObject({ total: 2, validated: 0 });
    expect(states(plan)).toEqual(["pendiente", "bloqueada"]);
  });

  it("an unrecognized value degrades to `pendiente` instead of counting as validated", () => {
    const plan = planWithTasks(
      "### F1 — Cupón",
      "> Estado: casi validada",
      "",
      "### F2 — Descuento",
      "> Estado:",
      "",
      "### F3 — El cierre",
      "> Estado: validada porque las casillas están marcadas",
    );
    expect(parsePhases(plan)).toMatchObject({ total: 3, validated: 0 });
    expect(states(plan)).toEqual(["pendiente", "pendiente", "pendiente"]);
  });
});

describe("parsePhases — the blocker reason lives on its own line", () => {
  const blockers = (text: string) => parsePhases(text).items.map((p) => p.blocker);

  it("reads the reason without ever letting it qualify the state", () => {
    const plan = planWithTasks(
      "### F1 — El descuento se persiste",
      "> Estado: bloqueada",
      "> Bloqueo: falta aplicar la migración 014.",
      "- [x] T1.1",
    );
    expect(parsePhases(plan)).toMatchObject({ total: 1, validated: 0, blocked: 1 });
    expect(blockers(plan)).toEqual(["falta aplicar la migración 014."]);
  });

  it("a block with no reason keeps `blocker: null` — nothing is invented", () => {
    const plan = planWithTasks("### F1 — Persistencia", "> Estado: bloqueada", "- [x] T1.1");
    expect(blockers(plan)).toEqual([null]);
    expect(parsePhases(plan).blocked).toBe(1);
  });

  it("the first reason of a block wins, and it never leaks into the next phase", () => {
    const plan = planWithTasks(
      "### F1 — Persistencia",
      "> Estado: bloqueada",
      "> Bloqueo: la primera razón.",
      "> Bloqueo: la segunda es prosa.",
      "",
      "### F2 — Reporte",
      "> Estado: pendiente",
    );
    expect(blockers(plan)).toEqual(["la primera razón.", null]);
  });

  it("a reason quoted inside a fence is an example, not a blocker", () => {
    const plan = planWithTasks(
      "### F1 — Persistencia",
      "> Estado: bloqueada",
      "```markdown",
      "> Bloqueo: un ejemplo del contrato",
      "```",
    );
    expect(blockers(plan)).toEqual([null]);
  });

  it("counts blocked phases apart from validated ones", () => {
    const plan = planWithTasks(
      "### F1 — Carrito",
      "> Estado: validada",
      "",
      "### F2 — Persistencia",
      "> Estado: bloqueada",
      "> Bloqueo: falta la migración.",
      "",
      "### F3 — Reporte",
      "> Estado: pendiente",
    );
    expect(parsePhases(plan)).toMatchObject({ total: 3, validated: 1, blocked: 1 });
  });
});

describe("parsePhases — `## Tasks` is the only source of phases", () => {
  it("ignores `### Fn` headings before, outside and after the section, fenced or not", () => {
    const plan = [
      "# Plan 009 — checkout",
      "",
      "> Estado: done — 2026-06-01 · sesión 120",
      "",
      "### F8 — fase huérfana antes de la sección",
      "> Estado: validada",
      "",
      "## Solution",
      "",
      "### F9 — fase citada en la solución",
      "> Estado: validada",
      "",
      "```markdown",
      "### F6 — ejemplo fenced fuera de Tasks",
      "> Estado: validada",
      "```",
      "",
      "## Tasks",
      "",
      "```markdown",
      "### F5 — ejemplo fenced dentro de Tasks",
      "> Estado: validada",
      "```",
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
      "### F7 — fase huérfana después de la sección",
      "> Estado: validada",
      "",
    ].join("\n");

    const out = parsePhases(plan);
    expect(out).toMatchObject({ total: 2, validated: 1 });
    expect(out.items.map((p) => p.n)).toEqual([1, 2]);
    expect(states(plan)).toEqual(["validada", "pendiente"]);
  });

  it("a legacy plan with a `## Phases` table and no `## Tasks` reports zero phases", () => {
    const legacy = [
      "# Plan 004 — legacy",
      "",
      "## Phases",
      "",
      "| Fase | Estado |",
      "|---|---|",
      "| F1 | validada |",
      "",
      "### F1 — Modelo",
      "> Estado: validada",
      "",
    ].join("\n");
    expect(parsePhases(legacy)).toEqual({ total: 0, validated: 0, blocked: 0, items: [] });
  });

  it("tolerates an annotated section heading and closes the block at a sibling heading", () => {
    const plan = [
      "# Plan 010 — cupón",
      "",
      "## Tasks (core):",
      "",
      "### F1 — El carrito acepta un cupón",
      "> Estado: validada",
      "",
      "### Notas de ejecución",
      "> Estado: validada",
      "",
    ].join("\n");

    const out = parsePhases(plan);
    expect(out).toMatchObject({ total: 1, validated: 1 });
    expect(out.items.map((p) => p.n)).toEqual([1]);
  });

  it("tolerates `## Tasks:` with a bare colon", () => {
    const plan = ["# P", "", "## Tasks:", "", "### F1 — Cupón", "> Estado: validada", ""].join(
      "\n",
    );
    expect(parsePhases(plan)).toMatchObject({ total: 1, validated: 1 });
  });

  // A sibling non-phase heading closes the block in force: the `> Estado:`
  // under it belongs to nobody and must not land on the previous phase.
  it("a `> Estado:` under a sibling non-phase heading never reaches the open phase", () => {
    const plan = planWithTasks(
      "### F1 — Cupón",
      "- [ ] T1.1",
      "",
      "### Notas de ejecución",
      "> Estado: validada",
      "",
      "### F2 — Descuento",
      "> Estado: en ejecución",
    );
    expect(parsePhases(plan)).toMatchObject({ total: 2, validated: 0 });
    expect(states(plan)).toEqual(["pendiente", "en ejecución"]);
  });

  it("a fence closes only with its own marker: nested examples never leak phases", () => {
    const plan = [
      "# Plan 011",
      "",
      "## Tasks",
      "",
      "````markdown",
      "```",
      "### F9 — ejemplo dentro de un fence de 4 backticks",
      "> Estado: validada",
      "```",
      "````",
      "",
      "```markdown",
      "~~~",
      "### F8 — ejemplo con marcador tilde dentro",
      "> Estado: validada",
      "~~~",
      "```",
      "",
      "### F1 — El carrito acepta un cupón",
      "> Estado: validada",
      "",
    ].join("\n");

    const out = parsePhases(plan);
    expect(out).toMatchObject({ total: 1, validated: 1 });
    expect(out.items.map((p) => p.n)).toEqual([1]);
  });

  it("a document without phase blocks yields no phases", () => {
    expect(parsePhases("# Plan 001\n\n## Tasks\n- [ ] T1 — algo\n")).toEqual({
      total: 0,
      validated: 0,
      blocked: 0,
      items: [],
    });
  });
});
