import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseSpecDesignReferences,
  parseTaskDesignReferences,
} from "../../src/domain/design/reference.js";

const MAXIMAL = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/design/manifest-maximal.json", import.meta.url)),
    "utf8",
  ),
) as { baselines: Array<{ digest: string }> };

const DIGEST_R2 = MAXIMAL.baselines[1]?.digest as string;

/** A spec with a `## Design references` block, plus the sections around it. */
function spec(block: string): string {
  return [
    "# Spec 046 — nacimiento de familias",
    "",
    "## Requirement",
    "",
    "Una familia nace del uso.",
    "",
    "## Design references",
    "",
    block,
    "",
    "## Scope",
    "",
    "In: el alta.",
  ].join("\n");
}

const VALID_BLOCK = [
  "package: DES-001@r2",
  "baseline_hint: docs/designs/001-design-alta/baselines/DES-001-r002.json",
  `digest: ${DIGEST_R2}`,
].join("\n");

function parseSpec(block: string) {
  return parseSpecDesignReferences(spec(block), "docs/specs/046-spec.md");
}

describe("parseSpecDesignReferences — la referencia que publica una spec", () => {
  it("lee package, hint y digest", () => {
    const result = parseSpec(VALID_BLOCK);
    expect(result.failures).toEqual([]);
    expect(result.references).toHaveLength(1);
    const ref = result.references[0];
    expect(ref?.baseline).toEqual({ package: "DES-001", revision: 2 });
    expect(ref?.baseline_hint).toBe("docs/designs/001-design-alta/baselines/DES-001-r002.json");
    expect(ref?.digest).toBe(DIGEST_R2);
  });

  it("una spec sin la sección no tiene referencias, y eso no es un error", () => {
    const result = parseSpecDesignReferences(
      "# Spec\n\n## Requirement\n\nAlgo.",
      "docs/specs/x.md",
    );
    expect(result).toEqual({ references: [], failures: [] });
  });

  it("tolera la forma de lista y las comillas invertidas", () => {
    const result = parseSpec(
      [
        "- package: `DES-001@r2`",
        "- baseline_hint: `docs/designs/001-design-alta/baselines/DES-001-r002.json`",
        `- digest: \`${DIGEST_R2}\``,
      ].join("\n"),
    );
    expect(result.failures).toEqual([]);
    expect(result.references[0]?.baseline.revision).toBe(2);
  });

  it("lee varias referencias separadas por una línea en blanco", () => {
    const second = VALID_BLOCK.replace("DES-001@r2", "DES-002@r1").replace(
      "001-design-alta",
      "002-design-baja",
    );
    const result = parseSpec(`${VALID_BLOCK}\n\n${second}`);
    expect(result.references.map((r) => r.baseline.package)).toEqual(["DES-001", "DES-002"]);
  });
});

describe("parseSpecDesignReferences — una referencia publicada es exacta o no es", () => {
  it("rechaza 'latest' diciendo por qué", () => {
    const result = parseSpec(VALID_BLOCK.replace("DES-001@r2", "DES-001@latest"));
    const failure = result.failures[0];
    expect(failure?.code).toBe("DESIGN_REFERENCE_APPROXIMATE");
    expect(failure?.message).toContain("no fija ninguna revisión");
    expect(failure?.action).toContain("DES-001@r4");
    expect(result.references).toEqual([]);
  });

  it.each(["DES-001@head", "DES-001@current"])("rechaza el alias móvil %s", (alias) => {
    expect(parseSpec(VALID_BLOCK.replace("DES-001@r2", alias)).failures[0]?.code).toBe(
      "DESIGN_REFERENCE_APPROXIMATE",
    );
  });

  it("rechaza el package sin revisión", () => {
    const failure = parseSpec(VALID_BLOCK.replace("DES-001@r2", "DES-001")).failures[0];
    expect(failure?.message).toContain("no fija la revisión");
  });

  it("rechaza un path como identidad: el path es un hint", () => {
    const failure = parseSpec(VALID_BLOCK.replace("DES-001@r2", "docs/designs/001-design-alta"))
      .failures[0];
    expect(failure?.message).toContain("hint de ubicación");
  });

  it("rechaza el slug de la carpeta", () => {
    const failure = parseSpec(VALID_BLOCK.replace("DES-001@r2", "001-design-alta")).failures[0];
    expect(failure?.message).toContain("no deriva del slug");
  });

  it("rechaza una búsqueda por título", () => {
    const failure = parseSpec(VALID_BLOCK.replace("DES-001@r2", "Alta y baja de miembros"))
      .failures[0];
    expect(failure?.code).toBe("DESIGN_REFERENCE_APPROXIMATE");
    expect(failure?.action).toContain("DES-NNN@rN");
  });

  it("exige las tres partes", () => {
    for (const [field, block] of [
      ["baseline_hint", VALID_BLOCK.split("\n").filter((l) => !l.startsWith("baseline_hint"))],
      ["digest", VALID_BLOCK.split("\n").filter((l) => !l.startsWith("digest"))],
    ] as const) {
      const failure = parseSpec(block.join("\n")).failures[0];
      expect(failure?.code, field).toBe("DESIGN_REFERENCE_INCOMPLETE");
      expect(failure?.message, field).toContain(field);
    }
  });

  it("rechaza un digest que no es sha256", () => {
    const failure = parseSpec(VALID_BLOCK.replace(DIGEST_R2, "sha1:abc")).failures[0];
    expect(failure?.code).toBe("DESIGN_REFERENCE_INCOMPLETE");
  });

  it("rechaza un hint que sale del workspace", () => {
    const failure = parseSpec(
      VALID_BLOCK.replace("docs/designs/001-design-alta", "../otro/001-design-alta"),
    ).failures[0];
    expect(failure?.code).toBe("DESIGN_PATH_UNSAFE");
  });
});

describe("parseTaskDesignReferences — lo que una tarea de plan fija", () => {
  it("lee la forma de dos partes con y sin anchor", () => {
    const result = parseTaskDesignReferences(
      "- [ ] T2.1 — Implementar DES-001@r2 / SCR-002@r2#empty y DES-001@r2 / FLW-001@r3.",
      "docs/plans/012-plan.md",
    );
    expect(result.failures).toEqual([]);
    expect(result.references).toHaveLength(2);
    expect(result.references[0]?.artifact).toEqual({
      package: "DES-001",
      artifact: "SCR-002",
      revision: 2,
      state: "empty",
    });
    expect(result.references[1]?.artifact.state).toBeUndefined();
  });

  it("deduplica la misma referencia citada dos veces", () => {
    const result = parseTaskDesignReferences(
      "DES-001@r2 / SCR-002@r2#empty y otra vez DES-001@r2 / SCR-002@r2#empty",
      "docs/plans/012-plan.md",
    );
    expect(result.references).toHaveLength(1);
  });

  it("una mención informal no es una referencia", () => {
    const result = parseTaskDesignReferences(
      "Implementar la pantalla de alta (la SCR-002, revisión 2).",
      "docs/plans/012-plan.md",
    );
    expect(result.references).toEqual([]);
  });

  it("reporta el package citado sin fijar", () => {
    const result = parseTaskDesignReferences(
      "- [ ] T1.1 — Tomar el diseño de DES-001 y construirlo.",
      "docs/plans/012-plan.md",
    );
    expect(result.failures[0]?.code).toBe("DESIGN_REFERENCE_APPROXIMATE");
    expect(result.failures[0]?.message).toContain("no fija la revisión");
  });

  it("no reporta como suelto el package que SÍ está fijado", () => {
    const result = parseTaskDesignReferences(
      "- [ ] T1.1 — Implementar DES-001@r2 / SCR-002@r2#empty.",
      "docs/plans/012-plan.md",
    );
    expect(result.failures).toEqual([]);
  });
});

describe("la sección existe: silencio y falso positivo", () => {
  it("una sección con contenido y sin referencia legible se REPORTA", () => {
    const result = parseSpec("Todavía no hay diseño para este requisito.");
    expect(result.references).toEqual([]);
    expect(result.failures[0]?.code).toBe("DESIGN_REFERENCE_INCOMPLETE");
    expect(result.failures[0]?.action).toContain("o quitá la sección");
  });

  it("una sección vacía no inventa un fallo", () => {
    expect(parseSpec("")).toEqual({ references: [], failures: [] });
  });

  it("la prosa antes de la primera referencia no se lee como una referencia a medias", () => {
    const conProsa = ["nota: el diseño del alta vive en su propio dossier.", "", VALID_BLOCK].join(
      "\n",
    );
    const result = parseSpec(conProsa);
    expect(result.failures).toEqual([]);
    expect(result.references).toHaveLength(1);
  });
});
