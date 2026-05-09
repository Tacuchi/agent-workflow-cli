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
