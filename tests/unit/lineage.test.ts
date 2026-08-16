// El linaje spec→plan deja de ser un número y pasa a ser un baseline verificable.
//
// Antes de esto un plan sólo podía decir DE QUÉ spec venía, nunca DE QUÉ VERSIÓN:
// una spec re-refinada al día siguiente de derivarse su plan dejaba al plan
// apuntando a un documento que ya no decía lo que el plan implementaba, y nada
// lo notaba. «Mismo número» no es «mismo contrato».
//
// Estos tests son la Validación de fase de F1 del plan 032, en su orden:
//   1. editar un byte de la spec cambia el veredicto de alineación de su plan;
//   2. un plan legacy sin la línea reporta `sin sello` y no entra a ninguna de
//      las dos categorías anteriores;
//   3. los criterios S033/AC-01…AC-14 se extraen en orden y sin duplicados;
//   4. las prioridades del pipeline para planes alineados quedan byte-idénticas.

import { describe, expect, it } from "vitest";
import {
  parseDerivedFromPath,
  parsePlanBaselineSeal,
  parseSpecCriteria,
} from "../../src/application/parsers/spec-relation.js";
import { PathsService } from "../../src/application/paths-service.js";
import { buildWorklineIndex, specConsumers } from "../../src/application/workline-index-service.js";
import {
  alignSpecBaseline,
  formatSpecBaseline,
  specBaselineDigest,
  withSpecBaseline,
} from "../../src/domain/lineage.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const fakeEnv = new FakeEnv("/home", "/cwd");
const NOW = new Date(2026, 7, 16, 12, 0, 0);

const SPEC_PATH = "docs/specs/033-spec-reconciliacion.md";
const PLAN_PATH = "docs/plans/032-plan-reconciliacion.md";

const SPEC = `---
status: ready-for-plan
---

# Spec 033 — reconciliacion

## Acceptance criteria

- S033/AC-01 — el diagnóstico clasifica una sola vez.
- S033/AC-02 — la elegibilidad es cierre semántico.
- S033/AC-03 — todo plan resuelve su spec a un baseline exacto.

## Scenarios

GIVEN una divergencia WHEN se clasifica THEN vale S033/AC-01 y no S033/AC-02.
`;

/** Un plan con su `Derived from` y, si se le da, su `> Baseline:`. */
function plan(baselineLine: string | null): string {
  const header = ["# Plan 032 — reconciliacion", "", `> Derived from ${SPEC_PATH}`];
  if (baselineLine !== null) header.push(baselineLine);
  header.push("> Estado: open", "> Límite de ejecución: checkout");
  return `${header.join("\n")}

## Origin

Spec 033.

## Tasks

### F1 — algo verificable
> Estado: pendiente
> Fuentes: workspace

- [ ] T1.1 — hacer algo _(fuentes: workspace)_
`;
}

function workspace(planText: string, specText: string = SPEC): MemFs {
  const fs = new MemFs({ lenient: true });
  fs.file("/cwd/.workflow/sessions/.keep", "");
  fs.file(`/cwd/${SPEC_PATH}`, specText);
  fs.file(`/cwd/${PLAN_PATH}`, planText);
  return fs;
}

function index(fs: MemFs) {
  return buildWorklineIndex(
    fs,
    fakeEnv,
    new PathsService(normalizeNamespace("workflow"), "/home", "/cwd"),
    { now: NOW },
  );
}

const SEALED = `> Baseline: ${SPEC_PATH}@${specBaselineDigest(SPEC)}`;

describe("F1.1 — editar un byte de la spec cambia el veredicto de alineación", () => {
  it("un plan sellado contra la spec vigente está alineado", async () => {
    const board = await index(workspace(plan(SEALED)));
    const p = board.plans[0];
    expect(p?.baseline).toEqual({ status: "aligned", digest: specBaselineDigest(SPEC) });
  });

  it("un solo byte distinto en la spec lo vuelve divergente, con los dos digests", async () => {
    // Un punto por una coma al final de AC-01: un byte, ningún cambio de sentido.
    const edited = SPEC.replace("una sola vez.", "una sola vez,");
    expect(edited).not.toBe(SPEC);
    expect(edited.length).toBe(SPEC.length);

    const board = await index(workspace(plan(SEALED), edited));
    expect(board.plans[0]?.baseline).toEqual({
      status: "divergent",
      sealed_digest: specBaselineDigest(SPEC),
      current_digest: specBaselineDigest(edited),
    });
  });

  it("el número sigue resolviendo igual: es el contrato lo que cambió, no la spec citada", async () => {
    const edited = SPEC.replace("una sola vez.", "una sola vez,");
    const board = await index(workspace(plan(SEALED), edited));
    expect(board.plans[0]?.spec).toMatchObject({
      status: "resolved",
      number: "033",
      evidence: "derived-from",
    });
  });
});

describe("F1.2 — un plan sin la línea reporta sin sello", () => {
  it("`unsealed`, que no es ni alineado ni divergente", async () => {
    const board = await index(workspace(plan(null)));
    const baseline = board.plans[0]?.baseline;
    expect(baseline).toEqual({ status: "unsealed" });
    expect(baseline?.status).not.toBe("aligned");
    expect(baseline?.status).not.toBe("divergent");
  });

  it("y sigue siendo un plan legible: la ausencia es diagnóstico, no error", async () => {
    const board = await index(workspace(plan(null)));
    expect(board.plans[0]).toMatchObject({
      number: "032",
      plan_state: "open",
      phases_total: 1,
      tasks_total: 1,
    });
  });

  it("una línea presente y rota es `malformed`, jamás `unsealed`", async () => {
    const board = await index(workspace(plan(`> Baseline: ${SPEC_PATH}@no-es-un-digest`)));
    expect(board.plans[0]?.baseline).toMatchObject({ status: "malformed" });
  });

  it("un digest de largo válido pero no hex tampoco pasa por sello bueno", () => {
    const seal = parsePlanBaselineSeal(plan(`> Baseline: ${SPEC_PATH}@${"z".repeat(64)}`));
    expect(seal.status).toBe("malformed");
  });

  it("una ruta que no es una spec del canon se rechaza nombrando el porqué", () => {
    const seal = parsePlanBaselineSeal(
      plan(`> Baseline: docs/plans/032-plan-x.md@${specBaselineDigest(SPEC)}`),
    );
    expect(seal).toMatchObject({ status: "malformed", why: expect.stringContaining("docs/specs") });
  });

  it("un plan que apunta a una spec ausente es `unresolved`, no `divergent`", async () => {
    const fs = new MemFs({ lenient: true });
    fs.file("/cwd/.workflow/sessions/.keep", "");
    fs.file(`/cwd/${PLAN_PATH}`, plan(SEALED));
    const board = await index(fs);
    expect(board.plans[0]?.baseline).toMatchObject({
      status: "unresolved",
      reason: "spec-not-found",
    });
  });
});

describe("F1.3 — los criterios de una spec se extraen en orden y sin duplicados", () => {
  it("en orden de documento, deduplicados, con la gramática que ya existía", () => {
    // AC-01 y AC-02 aparecen dos veces (lista + escenario) y salen una sola vez.
    expect(parseSpecCriteria(SPEC)).toEqual(["S033/AC-01", "S033/AC-02", "S033/AC-03"]);
  });

  it("una spec de 14 criterios los devuelve los 14, en orden", () => {
    const body = Array.from(
      { length: 14 },
      (_, i) => `- S033/AC-${String(i + 1).padStart(2, "0")} — criterio.`,
    ).join("\n");
    const expected = Array.from(
      { length: 14 },
      (_, i) => `S033/AC-${String(i + 1).padStart(2, "0")}`,
    );
    expect(parseSpecCriteria(`# Spec 033\n\n${body}\n`)).toEqual(expected);
  });

  it("admite la forma con segmento (`S013/AC-SEM-11`) porque la gramática es la misma", () => {
    expect(parseSpecCriteria("- S013/AC-SEM-11 — algo.")).toEqual(["S013/AC-SEM-11"]);
  });

  it("no cosecha dentro de un bloque de código: ahí se cita, no se declara", () => {
    const text =
      "# Spec 033\n\n```\n- S033/AC-99 — ejemplo de la doc.\n```\n\n- S033/AC-01 — real.\n";
    expect(parseSpecCriteria(text)).toEqual(["S033/AC-01"]);
  });
});

describe("F1.4 — el pipeline de un plan alineado queda byte-idéntico", () => {
  it("sellar un plan no mueve una sola letra de las prioridades", async () => {
    const before = await index(workspace(plan(null)));
    const after = await index(workspace(plan(SEALED)));
    expect(JSON.stringify(after.pipeline)).toBe(JSON.stringify(before.pipeline));
  });

  it("tampoco las mueve que el plan quede divergente: el pipeline es de F7, no de F1", async () => {
    const edited = SPEC.replace("una sola vez.", "una sola vez,");
    const before = await index(workspace(plan(null)));
    const after = await index(workspace(plan(SEALED), edited));
    expect(JSON.stringify(after.pipeline)).toBe(JSON.stringify(before.pipeline));
  });
});

describe("el sello se escribe donde va, y una sola vez", () => {
  const baseline = { path: SPEC_PATH, number: "033", digest: specBaselineDigest(SPEC) };

  it("se inserta justo después de `Derived from`", () => {
    const stamped = withSpecBaseline(plan(null), baseline);
    const lines = stamped.split("\n");
    const derived = lines.findIndex((l) => /derived from/i.test(l));
    expect(lines[derived + 1]).toBe(formatSpecBaseline(baseline));
  });

  it("re-sellar es idempotente byte a byte", () => {
    const once = withSpecBaseline(plan(null), baseline);
    expect(withSpecBaseline(once, baseline)).toBe(once);
  });

  it("un sello viejo se corrige en su sitio, sin duplicar la línea", () => {
    const stale = plan(`> Baseline: ${SPEC_PATH}@${"a".repeat(64)}`);
    const fixed = withSpecBaseline(stale, baseline);
    const count = fixed.split("\n").filter((l) => /^\s*>\s*Baseline:/i.test(l)).length;
    expect(count).toBe(1);
    expect(parsePlanBaselineSeal(fixed)).toEqual({ status: "sealed", baseline });
  });

  it("un documento sin blockquote de cabecera se deja intacto", () => {
    const bare = "# Plan 032\n\n## Origin\n\nnada.\n";
    expect(withSpecBaseline(bare, baseline)).toBe(bare);
  });

  it("lo que se escribe es exactamente lo que se vuelve a leer", () => {
    const stamped = withSpecBaseline(plan(null), baseline);
    expect(parsePlanBaselineSeal(stamped)).toEqual({ status: "sealed", baseline });
    expect(alignSpecBaseline(parsePlanBaselineSeal(stamped), SPEC)).toEqual({
      status: "aligned",
      digest: baseline.digest,
    });
  });

  it("la ruta literal del `Derived from` es la que se sella como hint", () => {
    expect(parseDerivedFromPath(plan(null))).toBe(SPEC_PATH);
  });

  it("dos `Derived from` distintos no sellan nada: la provenencia es contradictoria", () => {
    const two = plan(null).replace(
      `> Derived from ${SPEC_PATH}`,
      `> Derived from ${SPEC_PATH}\n> Derived from docs/specs/044-spec-otra.md`,
    );
    expect(parseDerivedFromPath(two)).toBeNull();
  });
});

describe("consumidores de un baseline", () => {
  it("enumera todo plan derivado de la spec y dice cómo está cada sello", async () => {
    const fs = workspace(plan(SEALED));
    fs.file("/cwd/docs/plans/031-plan-viejo.md", plan(null));
    const board = await index(fs);

    const consumers = specConsumers("033", board.plans);
    expect(consumers.map((c) => [c.number, c.alignment.status])).toEqual([
      ["031", "unsealed"],
      ["032", "aligned"],
    ]);
  });

  it("un plan cuya provenencia no se puede probar no se cuenta como consumidor", async () => {
    const fs = workspace(plan(SEALED));
    fs.file("/cwd/docs/plans/030-plan-huerfano.md", "# Plan 030\n\n## Origin\n\nsin spec.\n");
    const board = await index(fs);
    expect(specConsumers("033", board.plans).map((c) => c.number)).toEqual(["032"]);
  });

  it("una spec sin consumidores devuelve la lista vacía, no todo el tablero", async () => {
    const board = await index(workspace(plan(SEALED)));
    expect(specConsumers("099", board.plans)).toEqual([]);
  });
});
