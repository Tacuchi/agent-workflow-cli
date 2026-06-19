import { describe, expect, it } from "vitest";
import {
  bilingualAliases,
  parseMdSectionBilingual,
  parseMdValueBilingual,
} from "../../src/application/markdown.js";

describe("bilingualAliases", () => {
  it("maps Spanish keyword to its full alias group", () => {
    expect(bilingualAliases("Próximo paso")).toEqual(["Próximo paso", "Proximo paso", "Next step"]);
  });

  it("maps English keyword to the same alias group", () => {
    expect(bilingualAliases("Next step")).toEqual(["Próximo paso", "Proximo paso", "Next step"]);
  });

  it("normalizes case and accents on lookup", () => {
    expect(bilingualAliases("PROXIMO PASO")).toEqual(["Próximo paso", "Proximo paso", "Next step"]);
    expect(bilingualAliases("CURRENT phase")).toEqual(["Fase actual", "Current phase"]);
  });

  it("returns the original key as a single-element array when keyword is unregistered", () => {
    expect(bilingualAliases("Custom heading")).toEqual(["Custom heading"]);
  });

  it("covers analyze-investigate skill template headings", () => {
    expect(bilingualAliases("Pregunta original")).toContain("Original question");
    expect(bilingualAliases("Original question")).toContain("Pregunta original");
    expect(bilingualAliases("Fuentes consultadas")).toContain("Sources consulted");
    expect(bilingualAliases("Raw finding")).toContain("Hallazgo crudo");
  });

  it("covers analyze-synthesize TASKS+FINDINGS template headings", () => {
    expect(bilingualAliases("Plan summary")).toContain("Resumen del plan");
    expect(bilingualAliases("Tareas")).toContain("Tasks");
    expect(bilingualAliases("Patterns identified")).toContain("Patrones identificados");
    expect(bilingualAliases("Falsos positivos descartados")).toContain("False positives discarded");
    expect(bilingualAliases("Model decision")).toContain("Decisión de modelo");
  });

  it("covers analyze-conclude CONCLUSIONS template headings", () => {
    expect(bilingualAliases("Resumen")).toContain("Summary");
    expect(bilingualAliases("Conclusiones")).toContain("Conclusions");
    expect(bilingualAliases("Recommendations")).toContain("Recomendaciones");
    expect(bilingualAliases("Trazabilidad")).toContain("Traceability");
    expect(bilingualAliases("Open (gaps)")).toContain("Abierto (gaps)");
  });

  it("covers design-deliver DELIVERY template headings", () => {
    expect(bilingualAliases("Componentes")).toContain("Components");
    expect(bilingualAliases("Flows / interactions")).toContain("Flujos / interacciones");
    expect(bilingualAliases("UX decisions")).toContain("Decisiones UX");
    expect(bilingualAliases("Validation criteria")).toContain("Criterios de validación");
  });

  it("covers design-discover DISCOVERY headings", () => {
    expect(bilingualAliases("Usuarios")).toContain("Users");
    expect(bilingualAliases("Applicable design system")).toContain("Design system aplicable");
    expect(bilingualAliases("Hallazgos clave")).toContain("Key findings");
  });

  it("covers design-develop PROBLEM/IDEAS headings", () => {
    expect(bilingualAliases("Restricciones clave")).toContain("Key constraints");
    expect(bilingualAliases("Métricas de éxito")).toContain("Success metrics");
    expect(bilingualAliases("Variante")).toContain("Variant");
    expect(bilingualAliases("Initial recommendation")).toContain("Recomendación inicial");
  });
});

describe("parseMdValueBilingual", () => {
  it("finds value when the document uses the Spanish key but caller asks in English", () => {
    const text = "- Fase actual: planning\n";
    expect(parseMdValueBilingual(text, "Current phase")).toBe("planning");
  });

  it("finds value when the document uses the English key but caller asks in Spanish", () => {
    const text = "- Current phase: validation\n";
    expect(parseMdValueBilingual(text, "Fase actual")).toBe("validation");
  });

  it("returns undefined when neither variant is present", () => {
    const text = "- Some unrelated key: foo\n";
    expect(parseMdValueBilingual(text, "Fase actual")).toBeUndefined();
  });

  it("falls back to original key for unregistered keywords", () => {
    const text = "- Custom: bar\n";
    expect(parseMdValueBilingual(text, "Custom")).toBe("bar");
  });
});

describe("parseMdSectionBilingual", () => {
  it("captures section body when document uses unaccented Spanish heading", () => {
    const text = "## Proximo paso\nHacer X.\n";
    expect(parseMdSectionBilingual(text, "Próximo paso")).toBe("Hacer X.");
  });

  it("captures section body when caller asks with English heading", () => {
    const text = "## Próximo paso\nHacer Y.\n";
    expect(parseMdSectionBilingual(text, "Next step")).toBe("Hacer Y.");
  });

  it("captures English-headed section when caller asks with Spanish heading", () => {
    const text = "## Next step\nDo Z.\n";
    expect(parseMdSectionBilingual(text, "Próximo paso")).toBe("Do Z.");
  });

  it("captures Decisiones recientes / Recent decisions interchangeably", () => {
    const esText = "## Decisiones recientes\n- DEC-001: foo\n";
    expect(parseMdSectionBilingual(esText, "Recent decisions")).toBe("- DEC-001: foo");

    const enText = "## Recent decisions\n- DEC-002: bar\n";
    expect(parseMdSectionBilingual(enText, "Decisiones recientes")).toBe("- DEC-002: bar");
  });

  it("returns undefined when the heading is missing in any variant", () => {
    const text = "## Some other heading\nText.\n";
    expect(parseMdSectionBilingual(text, "Próximo paso")).toBeUndefined();
  });
});
