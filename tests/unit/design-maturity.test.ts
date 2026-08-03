import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBody } from "../../src/domain/design/artifact-body.js";
import { splitDesignDocument, validateDesignArtifact } from "../../src/domain/design/artifact.js";
import type { DesignArtifact } from "../../src/domain/design/artifact.js";
import { checkMaturity, gateDesignDocument } from "../../src/domain/design/maturity.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const FLOW = "FLW-001-r002-alta-miembro.md";
const SCREEN = "SCR-001-r002-formulario-alta.md";

/** The document as the gate sees it: validated, plus its parsed sections. */
function judge(text: string, kind: "flow" | "screen") {
  const document = validateDesignArtifact(text, kind, "doc.md");
  if (!document.ok || document.value === null) {
    throw new Error(`el fixture no valida: ${document.failures[0]?.message}`);
  }
  const split = splitDesignDocument(text);
  if (split === null) throw new Error("sin frontmatter");
  return checkMaturity(
    document.value as DesignArtifact,
    parseBody(split.body, split.bodyLine).sections,
    kind,
    "doc.md",
  );
}

describe("el gate handoff juzga lo que el documento RECLAMA", () => {
  it("los fixtures handoff pasan su propio gate", () => {
    expect(judge(fixture(FLOW), "flow").failures).toEqual([]);
    expect(judge(fixture(SCREEN), "screen").failures).toEqual([]);
    expect(judge(fixture(SCREEN), "screen").attainable).toBe("handoff");
  });

  it("una incógnita bloqueante impide declararse handoff", () => {
    const con = fixture(SCREEN).replace("blocking: false", "blocking: true");
    const verdict = judge(con, "screen");
    expect(verdict.attainable).toBe("outline");
    expect(verdict.failures[0]?.code).toBe("DESIGN_MATURITY_BLOCKED");
    expect(verdict.failures[0]?.message).toContain("pasaporte");
  });

  it("y la misma incógnita en outline es legítima: outline existe para eso", () => {
    const con = fixture(SCREEN)
      .replace("maturity: handoff", "maturity: outline")
      .replace("blocking: false", "blocking: true");
    expect(judge(con, "screen").failures).toEqual([]);
  });

  it("una incógnita NO bloqueante no impide nada", () => {
    expect(judge(fixture(SCREEN), "screen").attainable).toBe("handoff");
  });
});

describe("el piso de outline es un inventario, no un permiso", () => {
  it("un flow sin trazabilidad no llega ni a outline", () => {
    const sin = fixture(FLOW)
      .replace(/trace:\n(?:\s{2}- .*\n|\s{4}.*\n)+/, "trace: []\n")
      .replace(/S046\/AC-01/g, "el requisito");
    const verdict = judge(sin, "flow");
    expect(verdict.failures.some((f) => f.message.includes("trace"))).toBe(true);
  });

  it("y una screen sin estados tampoco", () => {
    const document = validateDesignArtifact(fixture(SCREEN), "screen", "doc.md");
    if (!document.ok || document.value === null) throw new Error("el fixture no valida");
    const vacia = { ...(document.value as DesignArtifact), states: [] } as DesignArtifact;
    const split = splitDesignDocument(fixture(SCREEN));
    if (split === null) throw new Error("sin frontmatter");
    const verdict = checkMaturity(
      vacia,
      parseBody(split.body, split.bodyLine).sections,
      "screen",
      "doc.md",
    );
    expect(verdict.failures.some((f) => f.message.includes("inventario"))).toBe(true);
  });

  it("un flow sin actores no llega ni a outline", () => {
    const sin = fixture(FLOW).replace("actors: [operador]", "actors: []");
    expect(judge(sin, "flow").failures.some((f) => f.message.includes("actores"))).toBe(true);
  });
});

describe("un handoff de flow resuelve su grafo sin leer prosa (AC-SEM-02)", () => {
  it("nodos sin transiciones no alcanzan handoff", () => {
    const sin = fixture(FLOW).replace(
      /edges:\n(?:\s{2}- [\s\S]*?)(?=\ndependencies:)/,
      "edges: []",
    );
    const verdict = judge(sin, "flow");
    expect(verdict.attainable).toBe("outline");
    expect(verdict.failures.some((f) => f.action.includes("aristas"))).toBe(true);
  });

  it("y el mismo flow en outline es legítimo", () => {
    const sin = fixture(FLOW)
      .replace("maturity: handoff", "maturity: outline")
      .replace(/edges:\n(?:\s{2}- [\s\S]*?)(?=\ndependencies:)/, "edges: []");
    expect(judge(sin, "flow").failures).toEqual([]);
  });
});

describe("una imagen no es la semántica (AC-SEM-07)", () => {
  // Nota: F2 ya impide que el CUERPO cite una rendition que el frontmatter no
  // declara, y una screen no tiene dónde declararla. El guard es la segunda
  // línea, así que se prueba sobre las secciones, no sobre un documento entero.
  const sectionsOf = (accessibility: string) => {
    const split = splitDesignDocument(fixture(SCREEN));
    if (split === null) throw new Error("sin frontmatter");
    return parseBody(split.body, split.bodyLine).sections.map((s) =>
      s.key === "accessibility" ? { ...s, text: accessibility, prose: accessibility } : s,
    );
  };
  const artifactOf = (): DesignArtifact => {
    const document = validateDesignArtifact(fixture(SCREEN), "screen", "doc.md");
    if (!document.ok || document.value === null) throw new Error("el fixture no valida");
    return document.value;
  };

  it("una sección esencial que responde con una rendition se rechaza", () => {
    const verdict = checkMaturity(
      artifactOf(),
      sectionsOf("DES-001/VIS-001@r1"),
      "screen",
      "doc.md",
    );
    expect(verdict.failures[0]?.code).toBe("DESIGN_EVIDENCE_INSUFFICIENT");
    expect(verdict.failures[0]?.action).toContain("WCAG");
    expect(verdict.attainable).toBe("outline");
  });

  it("citar la rendition ADEMÁS de decir lo que exige es legítimo", () => {
    const verdict = checkMaturity(
      artifactOf(),
      sectionsOf("Foco visible en cada control. Ver DES-001/VIS-001@r1."),
      "screen",
      "doc.md",
    );
    expect(verdict.failures).toEqual([]);
  });

  it("y el gate registra las obligaciones que la implementación deberá probar", () => {
    const verdict = judge(fixture(SCREEN), "screen");
    expect(verdict.obligations.map((o) => o.key)).toContain("accessibility");
    for (const obligation of verdict.obligations) {
      expect(obligation.statement.length).toBeGreaterThan(0);
    }
  });

  it("no pide probar lo que el documento declaró NO aplicable", () => {
    // El fixture renuncia a `localization` con su razón.
    const verdict = judge(fixture(SCREEN), "screen");
    expect(verdict.obligations.map((o) => o.key)).not.toContain("localization");
  });

  it("y la obligación lleva la sección entera, no su primera oración", () => {
    const split = splitDesignDocument(fixture(SCREEN));
    if (split === null) throw new Error("sin frontmatter");
    const seccion = parseBody(split.body, split.bodyLine).sections.find(
      (s) => s.key === "accessibility",
    );
    const obligation = judge(fixture(SCREEN), "screen").obligations.find(
      (o) => o.key === "accessibility",
    );
    expect(obligation?.statement).toBe(seccion?.prose.replace(/\s+/g, " ").trim());
    // Y esa sección tiene más de una oración: recortarla tiraba lo comprobable.
    expect((seccion?.prose ?? "").split(".").length).toBeGreaterThan(2);
  });
});

describe("depender de un design system externo (AC-PKG-09)", () => {
  it("un handoff que apunta a rules de otro package sin fijarlo queda en outline", () => {
    const fuera = fixture(SCREEN).replaceAll("DES-001/RUL-001@r1", "DES-003/RUL-001@r1");
    const verdict = judge(fuera, "screen");
    expect(verdict.attainable).toBe("outline");
    expect(verdict.failures[0]?.code).toBe("DESIGN_EVIDENCE_INSUFFICIENT");
    expect(verdict.failures[0]?.action).toContain("DES-003");
  });

  it("fijando proveedor, revisión y digest sí alcanza handoff", () => {
    // El fixture ya fija DES-002: mover sus rules a ese proveedor es legítimo.
    const fijado = fixture(SCREEN).replaceAll("DES-001/RUL-001@r1", "DES-002/RUL-001@r1");
    expect(judge(fijado, "screen").attainable).toBe("handoff");
  });

  it("y los NODOS de un flow en otro package cuentan igual que sus rules", () => {
    const fuera = fixture(FLOW).replaceAll("DES-001/SCR-", "DES-003/SCR-");
    const verdict = judge(fuera, "flow");
    expect(verdict.attainable).toBe("outline");
    expect(verdict.failures[0]?.message).toContain("DES-003");
  });

  it("y el mismo documento en outline es legítimo", () => {
    const fuera = fixture(SCREEN)
      .replace("maturity: handoff", "maturity: outline")
      .replaceAll("DES-001/RUL-001@r1", "DES-002/RUL-001@r1");
    expect(judge(fuera, "screen").failures).toEqual([]);
  });
});

describe("gateDesignDocument: validar y juzgar en un solo paso", () => {
  it("un documento que ni siquiera valida no tiene madurez que juzgar", () => {
    const verdict = gateDesignDocument("no soy un documento", "screen", "roto.md");
    expect(verdict.attainable).toBe("outline");
    expect(verdict.failures.length).toBeGreaterThan(0);
    expect(verdict.obligations).toEqual([]);
  });

  it("y uno que valida devuelve el mismo veredicto que juzgarlo a mano", () => {
    const directo = gateDesignDocument(fixture(SCREEN), "screen", "doc.md");
    expect(directo.attainable).toBe(judge(fixture(SCREEN), "screen").attainable);
    expect(directo.obligations).toEqual(judge(fixture(SCREEN), "screen").obligations);
  });
});
