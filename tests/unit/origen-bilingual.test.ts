import { describe, expect, it } from "vitest";
import { type ResolvedOrigen, renderOrigenBlock } from "../../src/application/handoff.js";
import { parseObjetivo } from "../../src/application/parsers/objetivo.js";

const OBJECTIVE_EN = `# Objective — session050-dev-foo

## Tipo: feature

## Requirement
EN canonical session.

## Origin
Derivado de \`session049-design-foo\`.

Spec final estable.

Ver: [\`DELIVERY.md\`](../session049-design-foo/DELIVERY.md)
`;

const OBJETIVO_ES = `# Objetivo — session050-dev-foo

## Tipo
feature

## Requerimiento
ES legacy session.

## Origen
Derivado de \`session049-design-foo\`.

Spec final estable.
`;

describe("Origen/Origin bilingual reader (R3 reader gap fix)", () => {
  it("parseObjetivo reads ## Origin (EN canon)", () => {
    const data = parseObjetivo(OBJECTIVE_EN);
    expect(data.origen).toBe("Derivado de `session049-design-foo`.");
  });

  it("parseObjetivo reads ## Origen (ES legacy)", () => {
    const data = parseObjetivo(OBJETIVO_ES);
    expect(data.origen).toBe("Derivado de `session049-design-foo`.");
  });
});

describe("renderOrigenBlock — emits EN canon ## Origin (R3 fix)", () => {
  it("emits '## Origin' header (not '## Origen') in new templates", () => {
    const origen: ResolvedOrigen = {
      folder: "session049-design-foo",
      name: "session049-design-foo",
      deliverable_name: "DELIVERY.md",
      deliverable_rel: "../session049-design-foo/DELIVERY.md",
      deliverable_exists: true,
      summary: "Spec final estable.",
    };
    const block = renderOrigenBlock(origen);
    expect(block).toContain("## Origin");
    expect(block).not.toContain("## Origen");
    expect(block).toContain("Derivado de `session049-design-foo`.");
  });
});
