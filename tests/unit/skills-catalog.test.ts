import { describe, expect, it } from "vitest";
import {
  type SeedSkill,
  curationOf,
  isRecommendedEntry,
} from "../../src/application/self/skills-catalog.js";
import {
  CATALOG_RESERVES,
  RECOMMENDED_SKILLS,
  SKILL_CATALOG,
} from "../../src/cli/tui/data/recommended-skills.js";

// The curation of Spec 043 is DATA, and what is asserted here is the editorial
// decision it fixes — not a literal copy of the file: the four withdrawals, the
// seven addressable leaves, the two candidates, the two identity repairs and
// the honesty invariants (every entry says what it is for, every unusual
// verdict says why). A change of wording stays free; a change of decision does
// not.

const byName = new Map(SKILL_CATALOG.map((s) => [s.name, s]));
const CONTEXT_COLLECTION = "muratcankoylan/agent-skills-for-context-engineering";

/** The 24 rows the review inspected — the catalog keeps every one of them. */
const REVIEWED = [
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "mcp-builder",
  "webapp-testing",
  "diagnosing-bugs",
  "codebase-design",
  "domain-modeling",
  "writing-great-skills",
  "grill-me",
  "find-skills",
  "react-best-practices",
  "ponytail",
  "ponytail-review",
  "c4-architecture",
  "skill-judge",
  "spring-boot-testing",
  "postgresql-optimization",
  "prometheus",
  "condition-based-waiting",
  "context-engineering-collection",
  "checklist-discipline",
  "structurizr-c4",
];

const WITHDRAWN = [
  "ponytail",
  "grill-me",
  "checklist-discipline",
  "context-engineering-collection",
];

const PRIORITY_LEAVES = [
  "tool-design",
  "filesystem-context",
  "context-compression",
  "context-optimization",
  "context-degradation",
  "evaluation",
  "harness-engineering",
];

describe("curación del catálogo (Spec 043)", () => {
  it("conserva las 24 entradas revisadas, sin duplicar ningún nombre", () => {
    for (const name of REVIEWED) expect(byName.get(name), name).toBeDefined();
    expect(new Set(SKILL_CATALOG.map((s) => s.name)).size).toBe(SKILL_CATALOG.length);
  });

  it("retira exactamente cuatro entradas del conjunto habitual y les conserva el motivo", () => {
    const withdrawn = SKILL_CATALOG.filter((s) => s.disposition === "withdrawn");
    expect(withdrawn.map((s) => s.name).sort()).toEqual([...WITHDRAWN].sort());
    for (const entry of withdrawn) expect(entry.reason, entry.name).toBeTruthy();
  });

  it("la lista recomendada se deriva: excluye las retiradas y no es una segunda lista", () => {
    expect(RECOMMENDED_SKILLS.length).toBe(SKILL_CATALOG.length - WITHDRAWN.length);
    const recommended = new Set(RECOMMENDED_SKILLS.map((s) => s.name));
    for (const name of WITHDRAWN) expect(recommended.has(name), name).toBe(false);
    for (const entry of RECOMMENDED_SKILLS) expect(byName.get(entry.name)).toBe(entry);
  });

  it("las siete hojas prioritarias son direccionables por ruta y quedan condicionadas", () => {
    for (const name of PRIORITY_LEAVES) {
      const entry = byName.get(name);
      expect(entry?.source, name).toBe(CONTEXT_COLLECTION);
      expect(entry?.path, name).toBe(`skills/${name}`);
      expect(entry?.disposition, name).toBe("conditional");
    }
  });

  it("las dos candidatas declaran ruta anidada y la revisión inspeccionada", () => {
    for (const name of ["property-based-testing", "sharp-edges"]) {
      const entry = byName.get(name);
      expect(entry?.disposition, name).toBe("candidate");
      expect(entry?.source, name).toBe("trailofbits/skills");
      expect(entry?.path, name).toBe(`plugins/${name}/skills/${name}`);
      expect(entry?.reviewedRef, name).toBeTruthy();
      expect(entry?.knownLimits, name).toBeTruthy();
    }
  });

  it("React relaciona etiqueta e identidad invocable sin declararlas equivalentes", () => {
    const react = byName.get("react-best-practices");
    expect(react?.skillName).toBe("vercel-react-best-practices");
    expect(react?.skillName).not.toBe(react?.name);
    expect(react?.path).toBe("skills/react-best-practices");
    expect(react?.reason).toBeTruthy();
  });

  it("condition-based-waiting propone una fuente nueva sin cambiar la registrada", () => {
    const entry = byName.get("condition-based-waiting");
    expect(entry?.disposition).toBe("repair");
    expect(entry?.source).toBe("nickcrew/claude-ctx-plugin");
    expect(entry?.proposedSource).toBe("NickCrew/Claude-Cortex");
    expect(entry?.path).toBe("skills/condition-based-waiting");
    expect(entry?.reviewedRef).toBeTruthy();
  });

  it("cada entrada dice para qué sirve, y todo veredicto no habitual dice por qué", () => {
    for (const entry of SKILL_CATALOG) {
      expect(entry.description, entry.name).toBeTruthy();
      if (entry.disposition === "withdrawn") expect(entry.reason, entry.name).toBeTruthy();
      else expect(entry.useWhen, entry.name).toBeTruthy();
      if (entry.disposition === "candidate" || entry.disposition === "repair") {
        expect(entry.reason, entry.name).toBeTruthy();
      }
    }
  });
});

describe("alta de anydoc y archify (Spec 044)", () => {
  it("las dos pertenecen al set habitual con procedencia, condición, límites y revisión inspeccionada", () => {
    for (const name of ["anydoc", "archify"]) {
      const entry = byName.get(name);
      expect(entry, name).toBeDefined();
      expect(
        RECOMMENDED_SKILLS.some((s) => s.name === name),
        name,
      ).toBe(true);
      expect(entry?.disposition ?? "keep", name).toBe("keep");
      expect(entry?.source, name).toBeTruthy();
      expect(entry?.useWhen, name).toBeTruthy();
      expect(entry?.knownLimits, name).toBeTruthy();
      expect(entry?.reviewedRef, name).toBeTruthy();
    }
    expect(byName.get("anydoc")?.source).toBe("firecrawl/anydoc");
    expect(byName.get("archify")?.source).toBe("tt-a1i/archify");
  });

  it("cada una es invocable con su identidad real aunque no viva en la raíz de su repositorio", () => {
    const anydoc = byName.get("anydoc");
    // La etiqueta del catálogo y la identidad invocable NO coinciden: quien
    // instala tiene que recibir la segunda, no la primera.
    expect(anydoc?.skillName).toBe("convert-documents-to-markdown");
    expect(anydoc?.skillName).not.toBe(anydoc?.name);
    expect(anydoc?.path).toBe("skills/convert-documents-to-markdown");

    const archify = byName.get("archify");
    expect(archify?.path).toBe("archify");
    // Acá la etiqueta ya ES la identidad: declarar un skillName igual al nombre
    // sería afirmar una diferencia que no existe.
    expect(archify?.skillName).toBeUndefined();
  });

  it("el «cuándo usarla» de las cuatro que comparten terreno se lee como cuatro condiciones distintas", () => {
    const useWhen = (name: string): string => {
      const value = byName.get(name)?.useWhen;
      expect(value, name).toBeTruthy();
      return value as string;
    };
    // Los tres de arquitectura se nombran entre sí, cada uno por su entrega.
    expect(useWhen("archify")).toContain("browser");
    expect(useWhen("archify")).toContain("structurizr-c4");
    expect(useWhen("archify")).toContain("c4-architecture");
    expect(useWhen("structurizr-c4")).toContain("archify");
    expect(useWhen("c4-architecture")).toContain("archify");
    expect(useWhen("c4-architecture")).toContain("Mermaid");
    // Y las cuatro condiciones no se repiten entre sí.
    const conditions = ["archify", "structurizr-c4", "c4-architecture", "anydoc"].map(useWhen);
    expect(new Set(conditions).size).toBe(4);
  });

  it("anydoc queda separada de las skills de documento que ya estaban recomendadas", () => {
    // La dirección es lo que las distingue: anydoc trae un documento ajeno HACIA
    // Markdown; las de anthropics PRODUCEN el .pdf/.docx/.xlsx que alguien pidió.
    expect(byName.get("anydoc")?.useWhen).toContain("Markdown");
    for (const name of ["pdf", "docx", "xlsx", "pptx"]) {
      expect(byName.get(name)?.useWhen, name).toContain("anydoc");
    }
  });
});

describe("reservas del catálogo", () => {
  it("documenta las alternativas sin ofrecerlas como recomendación", () => {
    for (const reserve of CATALOG_RESERVES) {
      expect(reserve.reason, reserve.name).toBeTruthy();
      expect(byName.has(reserve.name), reserve.name).toBe(false);
    }
    const onRequest = CATALOG_RESERVES.filter((r) => r.availability === "on-request");
    expect(onRequest.map((r) => r.name).sort()).toEqual([
      "cli-creator",
      "differential-review",
      "grilling",
    ]);
  });

  it("la revisión de vitest queda identificada como incompatible con este stack", () => {
    const vitest = CATALOG_RESERVES.find((r) => r.name === "vitest");
    expect(vitest?.availability).toBe("incompatible");
    expect(vitest?.reason).toMatch(/5\.x/);
  });

  it("los cinco ejemplos y la plantilla de la colección no son skills operativas", () => {
    const notOperational = CATALOG_RESERVES.filter((r) => r.availability === "not-operational");
    expect(notOperational.map((r) => r.name).sort()).toEqual([
      "book-sft-pipeline",
      "comprehensive-research-agent",
      "digital-brain",
      "reasoning-trace-optimizer",
      "skill-template",
    ]);
    for (const leaf of notOperational) expect(leaf.source).toBe(CONTEXT_COLLECTION);
  });
});

describe("contrato de curación", () => {
  const legacy: SeedSkill = { name: "x", source: "a/b", description: "d" };

  it("una fila legacy sin disposición se lee como 'keep' y sigue recomendada", () => {
    expect(curationOf(legacy)).toEqual({ disposition: "keep" });
    expect(isRecommendedEntry(legacy)).toBe(true);
  });

  it("un nombre que el catálogo no conoce no toma prestado ningún veredicto", () => {
    expect(curationOf(undefined)).toBeUndefined();
  });

  it("una entrada retirada deja de estar recomendada conservando sus metadatos", () => {
    const withdrawn: SeedSkill = { ...legacy, disposition: "withdrawn", reason: "por qué" };
    expect(isRecommendedEntry(withdrawn)).toBe(false);
    expect(curationOf(withdrawn)).toEqual({ disposition: "withdrawn", reason: "por qué" });
  });
});
