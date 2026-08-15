import { describe, expect, it } from "vitest";
import { parseProjectBlock } from "../../src/application/parsers/project-block.js";
import { blockFromParsed, renderProjectBlock } from "../../src/application/render/project-block.js";

// Fidelity of the managed block: what a person writes inside it must neither be
// adopted as CLI data nor disappear when the block is rewritten (S029/AC-01,
// AC-02, AC-09). The block stays CLI property — these tests do not make it
// editable, they make its rewrite faithful.

const BASE = {
  proyecto: "X",
  fuentes: [{ alias: "core", path: "/p", main_branch: "main" }],
  stack: {},
  lastActivity: "2026-01-01 00:00",
} as const;

const NOTA = "- Nota: revisar el changelog antes del release";

/** parse → render, the round-trip every reconcile performs. */
function rewrite(block: string): string {
  const parsed = parseProjectBlock(block);
  if (!parsed) throw new Error("expected parsed block");
  return blockFromParsed(parsed);
}

describe("project-block · el bloque no adopta lo ajeno (AC-01)", () => {
  it("una nota escrita DENTRO de la sección de ramas no se vuelve una rama de trabajo", () => {
    const clean = renderProjectBlock({ ...BASE, workingBranches: { core: "feature/x" } });
    const dirty = clean.replace("  - core: feature/x", `  - core: feature/x\n${NOTA}`);

    const parsed = parseProjectBlock(dirty);
    expect(parsed?.working_branches).toEqual({ core: "feature/x" });
    expect(parsed?.preserved_lines).toEqual([{ slot: "status:working", text: NOTA }]);
  });

  it("y la reescritura NO la re-emite anidada bajo el encabezado de ramas", () => {
    const clean = renderProjectBlock({ ...BASE, workingBranches: { core: "feature/x" } });
    const dirty = clean.replace("  - core: feature/x", `  - core: feature/x\n${NOTA}`);

    const rewritten = rewrite(dirty);
    expect(rewritten).toContain(`\n${NOTA}`);
    expect(rewritten).not.toContain(`  ${NOTA}`);
  });

  it("una entrada anidada con un alias que ninguna fuente declara no entra como rama", () => {
    const clean = renderProjectBlock({
      ...BASE,
      workingBranches: { core: "feature/x" },
      qaBranches: { core: "desarrollo" },
    });
    // `plugin` salió de la tabla de Fuentes: su entrada es un residuo del CLI.
    const stale = clean
      .replace("  - core: feature/x", "  - core: feature/x\n  - plugin: feature/b")
      .replace("  - core: desarrollo", "  - core: desarrollo\n  - plugin: qa/plugin");

    const parsed = parseProjectBlock(stale);
    expect(parsed?.working_branches).toEqual({ core: "feature/x" });
    expect(parsed?.qa_branches).toEqual({ core: "desarrollo" });
    // No desaparece en silencio: la pérdida se declara.
    expect(parsed?.dropped_lines).toEqual(["  - plugin: feature/b", "  - plugin: qa/plugin"]);
    expect(rewrite(stale)).not.toContain("plugin");
  });

  it("un default con un rol inexistente tampoco se adopta, y se declara", () => {
    const clean = renderProjectBlock({ ...BASE, defaultBranches: { principal: "main" } });
    const dirty = clean.replace("  - principal: main", "  - principal: main\n  - inventado: nope");

    const parsed = parseProjectBlock(dirty);
    expect(parsed?.default_branches).toEqual({ principal: "main" });
    expect(parsed?.dropped_lines).toEqual(["  - inventado: nope"]);
  });
});

describe("project-block · el bloque no borra lo ajeno (AC-02)", () => {
  it("conserva una nota escrita ANTES del encabezado de ramas, en su lugar", () => {
    const clean = renderProjectBlock({ ...BASE, workingBranches: { core: "feature/x" } });
    const dirty = clean.replace(
      "- Ramas de trabajo actuales:",
      `${NOTA}\n- Ramas de trabajo actuales:`,
    );

    const rewritten = rewrite(dirty);
    expect(rewritten).toContain(`${NOTA}\n- Ramas de trabajo actuales:`);
  });

  it("conserva una nota escrita ENTRE «Última actividad» e «Histórico», en su lugar", () => {
    const clean = renderProjectBlock(BASE);
    const dirty = clean.replace("- Histórico:", `${NOTA}\n- Histórico:`);

    const rewritten = rewrite(dirty);
    expect(rewritten).toContain(
      `- Última actividad: 2026-01-01 00:00\n${NOTA}\n- Histórico: \`.workflow/HISTORY.md\``,
    );
  });

  it("conserva una nota escrita DESPUÉS de «Histórico»", () => {
    const clean = renderProjectBlock(BASE);
    const dirty = clean.replace(
      "- Histórico: `.workflow/HISTORY.md`",
      `- Histórico: \`.workflow/HISTORY.md\`\n${NOTA}`,
    );
    expect(rewrite(dirty)).toContain(`HISTORY.md\`\n${NOTA}`);
  });

  it("conserva notas en las secciones Fuentes y Stack", () => {
    const clean = renderProjectBlock({ ...BASE, stack: { language: "TypeScript" } });
    const dirty = clean
      .replace(
        "| core | /p | main |",
        "| core | /p | main |\n\nLas rutas son locales a mi máquina.",
      )
      .replace("- Lenguaje: TypeScript", "- Lenguaje: TypeScript\n- Infra: k8s");

    const rewritten = rewrite(dirty);
    expect(rewritten).toContain("Las rutas son locales a mi máquina.");
    expect(rewritten).toContain("- Infra: k8s");
    // Y la nota de Stack no se cuela como parte del stack detectado.
    expect(parseProjectBlock(dirty)?.stack).toEqual({ language: "TypeScript" });
  });

  it("no duplica los placeholders que el propio render emite", () => {
    const empty = renderProjectBlock({ proyecto: "", fuentes: [], stack: {} });
    const rewritten = rewrite(empty);
    expect(rewritten.split("Sin fuentes declaradas")).toHaveLength(2);
    expect(rewritten.split("Stack sin detectar")).toHaveLength(2);
    expect(parseProjectBlock(empty)?.preserved_lines).toBeUndefined();
  });
});

describe("project-block · idempotencia y compatibilidad (AC-09, AC-10)", () => {
  it("un bloque limpio no gana campos nuevos ni cambia al reescribirse", () => {
    const clean = renderProjectBlock({
      ...BASE,
      defaultBranches: { principal: "main" },
      workingBranches: { core: "feature/x" },
      qaBranches: { core: "desarrollo" },
    });
    const parsed = parseProjectBlock(clean);
    expect(parsed).not.toHaveProperty("preserved_lines");
    expect(parsed).not.toHaveProperty("dropped_lines");
    expect(rewrite(clean)).toBe(clean);
  });

  it("un bloque con notas ajenas es un punto fijo: la segunda reescritura no cambia nada", () => {
    const clean = renderProjectBlock({
      ...BASE,
      workingBranches: { core: "feature/x" },
      qaBranches: { core: "desarrollo" },
    });
    const dirty = clean
      .replace("- Ramas de trabajo actuales:", `${NOTA}\n- Ramas de trabajo actuales:`)
      .replace("  - core: feature/x", "  - core: feature/x\n- Otra nota: pendiente")
      .replace("- Histórico:", "- Recordatorio: avisar al equipo\n- Histórico:");

    const once = rewrite(dirty);
    const twice = rewrite(once);
    expect(twice).toBe(once);
    for (const nota of [NOTA, "- Otra nota: pendiente", "- Recordatorio: avisar al equipo"]) {
      expect(once).toContain(nota);
    }
  });
});

describe("project-block · una sección propia dentro del bloque sobrevive (AC-02)", () => {
  // Las cuatro secciones del bloque se leen POR NOMBRE, así que todo lo que
  // viviera bajo otro `##` era invisible para el parser y simplemente no volvía
  // — y un `##` es la forma más natural en que una persona agrega contenido
  // propio a un bloque Markdown.
  const NOTAS = ["## Notas", "", "Esto lo escribí yo y me importa."].join("\n");

  it("se conserva y vuelve completa, encabezado incluido", () => {
    const clean = renderProjectBlock({ ...BASE, workingBranches: { core: "feature/x" } });
    const dirty = clean.replace(
      "<!-- WORKFLOW-PROJECT-END -->",
      `${NOTAS}\n\n<!-- WORKFLOW-PROJECT-END -->`,
    );

    const parsed = parseProjectBlock(dirty);
    expect(parsed?.preserved_lines).toEqual([
      { slot: "trailing", text: "## Notas" },
      { slot: "trailing", text: "" },
      { slot: "trailing", text: "Esto lo escribí yo y me importa." },
    ]);
    expect(rewrite(dirty)).toContain("Esto lo escribí yo y me importa.");
  });

  it("también cuando está EN MEDIO de las secciones que el bloque sí posee", () => {
    const clean = renderProjectBlock({ ...BASE, workingBranches: { core: "feature/x" } });
    const dirty = clean.replace("## Status", `${NOTAS}\n\n## Status`);
    const rewritten = rewrite(dirty);
    expect(rewritten).toContain("## Notas");
    expect(rewritten).toContain("Esto lo escribí yo y me importa.");
    // Y lo que el bloque sí posee sigue en su lugar.
    expect(rewritten).toContain("  - core: feature/x");
  });

  it("y la segunda reescritura no la mueve ni la duplica", () => {
    const clean = renderProjectBlock({ ...BASE, workingBranches: { core: "feature/x" } });
    const dirty = clean.replace(
      "<!-- WORKFLOW-PROJECT-END -->",
      `${NOTAS}\n\n<!-- WORKFLOW-PROJECT-END -->`,
    );
    const once = rewrite(dirty);
    expect(rewrite(once)).toBe(once);
    expect(once.match(/## Notas/g)).toHaveLength(1);
  });
});
