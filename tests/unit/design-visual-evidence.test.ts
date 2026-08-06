import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ScreenArtifact, validateDesignArtifact } from "../../src/domain/design/artifact.js";
import type { CatalogEntry } from "../../src/domain/design/manifest.js";
import { gateDesignDocument } from "../../src/domain/design/maturity.js";
import {
  type DesignRendition,
  validateDesignRendition,
} from "../../src/domain/design/rendition.js";
import { crossVisualEvidence } from "../../src/domain/design/visual-evidence.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const FILE = "screens/SCR-001-r002-formulario-alta.md";
const COMPLETE = fixture("SCR-001-r002-formulario-alta.md");

/** The matrix as the fixture writes it, so a variant can replace exactly it. */
const MATRIX = `    classification: visual
    states: [default, error]
    renditions: [DES-001/VIS-001@r1]
    reason: null
`;

const gate = (text: string) => gateDesignDocument(text, "screen", FILE);

describe("F3 · cada screen `handoff` conserva evidencia visual local", () => {
  it("un fixture completo pasa", () => {
    const verdict = gate(COMPLETE);
    expect(verdict.failures).toEqual([]);
    expect(verdict.attainable).toBe("handoff");
  });

  // La prueba de fase, primera mitad: un `handoff` sin preview se rechaza
  // nombrando la screen, y dice qué hacer.
  it("un `handoff` sin preview se rechaza nombrando la screen", () => {
    const verdict = gate(COMPLETE.replace("    renditions: [DES-001/VIS-001@r1]\n", ""));
    expect(verdict.attainable).toBe("outline");
    const failure = verdict.failures.find((f) => f.message.includes("estado base"));
    expect(failure?.artifact).toBe(FILE);
    expect(failure?.message).toContain("default");
    expect(failure?.action).toContain("preview estática local");
  });

  // Segunda mitad: una matriz incompleta se rechaza nombrando el criterio. Una
  // entrada SIN clasificar es la matriz a medias; una entrada que enumera
  // evidencia sin clasificarla es otra cosa —una contradicción— y la rechaza el
  // validador, no el gate (ver el bloque siguiente).
  it("una matriz incompleta se rechaza nombrando el criterio", () => {
    const verdict = gate(COMPLETE.replace(MATRIX, ""));
    expect(verdict.attainable).toBe("outline");
    const failure = verdict.failures.find((f) => f.message.includes("no está clasificado"));
    expect(failure?.message).toContain("S046/AC-02");
    expect(failure?.action).toContain("not_visual");
  });

  it("un criterio 'visual' sin estados se rechaza", () => {
    const verdict = gate(COMPLETE.replace("    states: [default, error]\n", ""));
    expect(verdict.failures.some((f) => f.message.includes("no enumera estados"))).toBe(true);
  });

  it("un criterio de interacción no exige rendition ni storyboard", () => {
    const interaction = COMPLETE.replace(
      MATRIX,
      "    classification: interaction\n    states: [default, error]\n    renditions: []\n    reason: null\n",
    );
    const verdict = gate(interaction);
    expect(verdict.failures).toEqual([]);
    expect(verdict.attainable).toBe("handoff");
  });

  it("un criterio 'not_visual' sin razón se rechaza, y con razón pasa", () => {
    const sinRazon = COMPLETE.replace(MATRIX, "    classification: not_visual\n    reason: null\n");
    expect(gate(sinRazon).failures.some((f) => f.message.includes("no dice por qué"))).toBe(true);

    // Con razón la matriz está completa. Al no quedar ningún criterio visual,
    // no se fabrica una preview sólo para satisfacer el antiguo gate.
    const conRazon = COMPLETE.replace(
      MATRIX,
      "    classification: not_visual\n    reason: es una regla de retención sin superficie visible\n",
    );
    const verdict = gate(conRazon);
    expect(verdict.failures).toEqual([]);
  });

  // AC-REN-01, la mitad que NO cambia: `outline` sigue sin deberle una rendition.
  it("un `outline` sin renditions pasa", () => {
    const outline = COMPLETE.replace("maturity: handoff", "maturity: outline").replace(MATRIX, "");
    const verdict = gate(outline);
    expect(verdict.failures).toEqual([]);
    expect(verdict.attainable).toBe("outline");
  });

  // El guard de AC-SEM-07 sigue vigente ahora que las renditions son declarables:
  // una sección respondida SOLO con una referencia VIS-* no alcanza `handoff`.
  it("una sección esencial respondida solo con una rendition sigue sin alcanzar `handoff`", () => {
    const soloImagen = COMPLETE.replace(
      /## Accessibility\n\n[^#]+/,
      "## Accessibility\n\nDES-001/VIS-001@r1\n\n",
    );
    const verdict = gate(soloImagen);
    expect(verdict.failures.map((f) => f.code)).toContain("DESIGN_EVIDENCE_INSUFFICIENT");
    expect(verdict.attainable).toBe("outline");
  });
});

describe("F3 · una contradicción en la matriz es malformación, no incompletitud", () => {
  it("'not_visual' que enumera renditions no valida en ningún perfil", () => {
    const contradictorio = COMPLETE.replace(
      "    classification: visual\n",
      "    classification: not_visual\n",
    );
    const result = validateDesignArtifact(contradictorio, "screen", FILE);
    expect(result.ok).toBe(false);
    expect(result.failures.some((f) => f.message.includes("enumera estados o renditions"))).toBe(
      true,
    );
  });

  it("una razón sobre un criterio visual no valida", () => {
    const result = validateDesignArtifact(
      COMPLETE.replace("    reason: null\n", "    reason: no tiene nada que mirar\n"),
      "screen",
      FILE,
    );
    expect(result.failures.some((f) => f.message.includes("'reason' explica"))).toBe(true);
  });

  it("un estado que la revisión no declara no valida", () => {
    const result = validateDesignArtifact(
      COMPLETE.replace("    states: [default, error]\n", "    states: [default, inexistente]\n"),
      "screen",
      FILE,
    );
    expect(result.failures.some((f) => f.message.includes("inexistente"))).toBe(true);
  });

  it("evidencia declarada sin clasificar el criterio no valida", () => {
    const result = validateDesignArtifact(
      COMPLETE.replace("    classification: visual\n", "    classification: null\n"),
      "screen",
      FILE,
    );
    expect(result.failures.some((f) => f.message.includes("sin clasificar"))).toBe(true);
  });

  it("un flow no lleva la matriz: su evidencia visual es la de sus screens", () => {
    const flow = fixture("FLW-001-r002-alta-miembro.md");
    expect(validateDesignArtifact(flow, "flow", "flows/FLW-001-r002-alta-miembro.md").ok).toBe(
      true,
    );

    const conMatriz = flow.replace(
      "  - criterion: S046/AC-01",
      "  - criterion: S046/AC-01\n    classification: visual",
    );
    const result = validateDesignArtifact(conMatriz, "flow", "flows/x.md");
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_KEY_UNKNOWN");
  });
});

describe("F3 · el gate cruza la matriz de la screen con la cobertura de la rendition", () => {
  const CATALOG: CatalogEntry[] = [
    {
      id: "VIS-001",
      revision: 1,
      path: "renditions/VIS-001-r001-formulario-alta/rendition.json",
      supersedes: null,
    },
  ];

  const screen = (): ScreenArtifact => {
    const parsed = validateDesignArtifact(COMPLETE, "screen", FILE);
    if (!parsed.ok || parsed.value === null) throw new Error("el fixture de screen no validó");
    return parsed.value as ScreenArtifact;
  };

  const rendition = (patch: Partial<DesignRendition> = {}): DesignRendition => {
    const parsed = validateDesignRendition(
      JSON.parse(fixture("rendition-VIS-001-r001.json")),
      CATALOG[0]?.path as string,
    );
    if (!parsed.ok || parsed.value === null)
      throw new Error(`el fixture de rendition no validó: ${JSON.stringify(parsed.failures)}`);
    return { ...parsed.value, ...patch };
  };

  const cross = (r: DesignRendition | null) =>
    crossVisualEvidence(CATALOG, screen(), FILE, () => r);

  it("una cita respaldada pasa", () => {
    expect(cross(rendition())).toEqual([]);
  });

  it("una cita que el catálogo no contiene se reporta como colgante", () => {
    const failures = crossVisualEvidence([], screen(), FILE, () => rendition());
    expect(failures.map((f) => f.code)).toEqual(["DESIGN_REFERENCE_MISSING"]);
    expect(failures[0]?.message).toContain("DES-001/VIS-001@r1");
  });

  it("una rendition que no se puede leer se reporta, no se asume buena", () => {
    const failures = cross(null);
    expect(failures.map((f) => f.code)).toEqual(["DESIGN_REFERENCE_FILE_MISSING"]);
  });

  // El snapshot confundido con algo más reciente (AC-REN-07): una preview de r1
  // presentada como evidencia de r2.
  it("una rendition que salió de otra revisión no respalda la cita", () => {
    const failures = cross(
      rendition({
        sources: [{ ref: "DES-001/SCR-001@r1", sha256: `sha256:${"6".repeat(64)}` }],
      }),
    );
    expect(failures.map((f) => f.code)).toContain("DESIGN_VISUAL_EVIDENCE_REQUIRED");
    expect(failures.some((f) => f.message.includes("no salió de DES-001/SCR-001@r2"))).toBe(true);
  });

  it("una rendition que no declara cubrir el criterio no respalda la cita", () => {
    const failures = cross(rendition({ coverage: { criteria: [], states: ["default", "error"] } }));
    expect(failures.some((f) => f.message.includes("no declara cubrir 'S046/AC-02'"))).toBe(true);
  });

  it("una rendition que no cubre los estados citados no respalda la cita", () => {
    const failures = cross(
      rendition({ coverage: { criteria: ["S046/AC-02"], states: ["default"] } }),
    );
    expect(failures.some((f) => f.message.includes("no cubre error"))).toBe(true);
  });

  it("un criterio 'interaction' se valida por estados, no por un storyboard redundante", () => {
    const parsed = validateDesignArtifact(
      COMPLETE.replace("    classification: visual\n", "    classification: interaction\n"),
      "screen",
      FILE,
    );
    if (!parsed.ok || parsed.value === null) throw new Error("la variante no validó");
    const interactiva = parsed.value as ScreenArtifact;

    // Aunque cite una rendition, la evidencia de interacción no es una condición
    // adicional de publicación: la interacción queda en los estados y pruebas.
    expect(crossVisualEvidence(CATALOG, interactiva, FILE, () => rendition())).toEqual([]);
    expect(
      crossVisualEvidence(CATALOG, interactiva, FILE, () =>
        rendition({ interaction_evidence: null }),
      ),
    ).toEqual([]);
  });

  it("una preview en un formato que exige proveedor no cuenta como evidencia local", () => {
    const failures = cross(rendition({ format: "html" }));
    expect(failures.some((f) => f.message.includes("preview estática local"))).toBe(true);
    expect(failures.some((f) => f.action.includes("pasó a exigir"))).toBe(true);
  });

  it("una screen en `outline` no se cruza: puede citar una rendition que todavía se dibuja", () => {
    const outline = { ...screen(), maturity: "outline" as const };
    expect(crossVisualEvidence([], outline, FILE, () => null)).toEqual([]);
  });
});
