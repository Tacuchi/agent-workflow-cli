import { describe, expect, it } from "vitest";
import { getObjetivoTemplate, renderTemplate } from "../../src/application/templates/objetivo.js";

describe("getObjetivoTemplate", () => {
  it("returns DEV template with EN headings for flow=dev", () => {
    const tpl = getObjetivoTemplate("dev");
    expect(tpl).toContain("# Objective — {folder}");
    expect(tpl).toContain("## Requirement");
    expect(tpl).toContain("## Context");
    expect(tpl).toContain("## Acceptance criteria");
    expect(tpl).toContain("## Topics");
    expect(tpl).not.toContain("Requerimiento");
    expect(tpl).not.toContain("Contexto");
  });

  it("returns DESIGN template with EN headings (Type/Brief)", () => {
    const tpl = getObjetivoTemplate("design");
    expect(tpl).toContain("## Type");
    expect(tpl).toContain("## Brief");
    expect(tpl).toContain("## Acceptance criteria");
    expect(tpl).not.toContain("## Tipo");
  });

  it("returns ANALYZE template with EN headings (Modality/Question/Success criteria)", () => {
    const tpl = getObjetivoTemplate("analyze");
    expect(tpl).toContain("## Modality");
    expect(tpl).toContain("## Question");
    expect(tpl).toContain("## Success criteria");
    expect(tpl).not.toContain("Modalidad");
    expect(tpl).not.toContain("Pregunta");
  });

  it("falls back to DEFAULT template for unknown flow", () => {
    const tpl = getObjetivoTemplate("unknown");
    expect(tpl).toContain("# Objective — {folder}");
    expect(tpl).toContain("## Requirement");
    expect(tpl).toContain("## Acceptance criteria");
    expect(tpl).not.toContain("## Topics");
  });

  it("falls back to DEFAULT for null/undefined", () => {
    const tpl = getObjetivoTemplate(null);
    expect(tpl).toContain("# Objective —");
    expect(getObjetivoTemplate(undefined)).toBe(tpl);
  });
});

describe("renderTemplate", () => {
  it("substitutes {folder}, {origen_block}, {objetivo} in DEV template", () => {
    const tpl = getObjetivoTemplate("dev");
    const rendered = renderTemplate(tpl, {
      folder: "session042-dev-foo",
      origen_block: "",
      objetivo: "Build the thing.",
    });
    expect(rendered).toContain("# Objective — session042-dev-foo");
    expect(rendered).toContain("Build the thing.");
    expect(rendered).not.toContain("{folder}");
    expect(rendered).not.toContain("{objetivo}");
  });

  it("substitutes {modalidad} in ANALYZE template", () => {
    const tpl = getObjetivoTemplate("analyze");
    const rendered = renderTemplate(tpl, {
      folder: "session043-analyze-bar",
      origen_block: "",
      objetivo: "What broke?",
      modalidad: "incident",
    });
    expect(rendered).toContain("## Modality\nincident");
    expect(rendered).toContain("## Question\nWhat broke?");
  });

  it("substitutes {tipo} in DESIGN template", () => {
    const tpl = getObjetivoTemplate("design");
    const rendered = renderTemplate(tpl, {
      folder: "session044-design-baz",
      origen_block: "",
      objetivo: "Mockup the dashboard.",
      tipo: "system",
    });
    expect(rendered).toContain("## Type\nsystem");
    expect(rendered).toContain("## Brief\nMockup the dashboard.");
  });

  it("leaves unrecognized placeholders intact", () => {
    const result = renderTemplate("Hello {name}, missing {unknown}", { name: "world" });
    expect(result).toBe("Hello world, missing {unknown}");
  });

  it("substitutes empty origen_block as empty string (no leftover braces)", () => {
    const tpl = getObjetivoTemplate("dev");
    const rendered = renderTemplate(tpl, {
      folder: "x",
      origen_block: "",
      objetivo: "y",
    });
    expect(rendered).not.toContain("{origen_block}");
  });
});
