import { describe, expect, it } from "vitest";
import {
  type DesignDocKind,
  ESSENTIAL_HEADINGS,
  FLOW_HEADINGS,
  HEADINGS,
  SCREEN_HEADINGS,
  bodyReferences,
  checkHeadings,
  conditionalKeys,
  headingKey,
  parseBody,
} from "../../src/domain/design/artifact-body.js";
import { Reader } from "../../src/domain/design/validation.js";

/** Body with every heading of `kind`, each carrying one line of text. */
function fullBody(kind: DesignDocKind, override: Record<string, string> = {}): string {
  return HEADINGS[kind]
    .map((h) => `## ${h}\n\n${override[h] ?? `Contenido de ${h}.`}`)
    .join("\n\n");
}

function check(body: string, kind: DesignDocKind): Array<{ code: string; action: string }> {
  const r = new Reader({});
  checkHeadings(r, parseBody(body, 1), kind, "flows/FLW-001-r001-x.md");
  return r.failures.map((f) => ({ code: f.code, action: f.action }));
}

function codes(body: string, kind: DesignDocKind): string[] {
  return check(body, kind).map((f) => f.code);
}

describe("el contrato de headings sale de la spec, no de una lista paralela", () => {
  it("flow v1 tiene 6 secciones y screen v1 tiene 11", () => {
    expect(FLOW_HEADINGS).toHaveLength(6);
    expect(SCREEN_HEADINGS).toHaveLength(11);
  });

  // La spec enumera las claves condicionales por su nombre exacto. Derivarlas del
  // heading tiene que dar EXACTAMENTE esa lista, o hay dos fuentes de verdad.
  it("las claves condicionales derivadas coinciden con las que enumera la spec", () => {
    expect(conditionalKeys("flow")).toEqual([
      "preconditions_and_entry",
      "alternatives_and_recovery",
      "permissions_and_privacy",
    ]);
    expect(conditionalKeys("screen")).toEqual([
      "components_and_design_system_deltas",
      "data_permissions_and_validation",
      "responsive_and_adaptation",
      "localization",
      "edge_cases_and_degradation",
    ]);
  });

  it("esencial + condicional cubre todas las secciones, sin superposición", () => {
    for (const kind of ["flow", "screen"] as const) {
      const essential = ESSENTIAL_HEADINGS[kind].length;
      expect(essential + conditionalKeys(kind).length).toBe(HEADINGS[kind].length);
    }
  });

  it("la clave normaliza comas y guiones", () => {
    expect(headingKey("Data, permissions and validation")).toBe("data_permissions_and_validation");
    expect(headingKey("Components and design-system deltas")).toBe(
      "components_and_design_system_deltas",
    );
  });
});

describe("checkHeadings — el cuerpo completo pasa", () => {
  it("acepta un flow y una screen con todas sus secciones", () => {
    expect(codes(fullBody("flow"), "flow")).toEqual([]);
    expect(codes(fullBody("screen"), "screen")).toEqual([]);
  });

  it("no confunde un '## …' dentro de un bloque de código con una sección", () => {
    const body = `${fullBody("flow")}\n\n\`\`\`md\n## Main journey\n\`\`\`\n`;
    expect(codes(body, "flow")).toEqual([]);
  });
});

describe("checkHeadings — la batería del plan", () => {
  it("heading omitido", () => {
    const body = fullBody("flow").replace(/## Traceability\n\nContenido de Traceability\./, "");
    const failures = check(body, "flow");
    expect(failures.map((f) => f.code)).toContain("DESIGN_HEADING_MISSING");
    expect(failures.find((f) => f.code === "DESIGN_HEADING_MISSING")?.action).toContain(
      "omitirla no la vuelve no aplicable",
    );
  });

  it("heading duplicado", () => {
    const body = `${fullBody("flow")}\n\n## Main journey\n\nOtra vez.`;
    expect(codes(body, "flow")).toContain("DESIGN_HEADING_DUPLICATE");
  });

  it("heading fuera de orden", () => {
    const reordered = [...FLOW_HEADINGS];
    [reordered[1], reordered[2]] = [reordered[2] as string, reordered[1] as string];
    const body = reordered.map((h) => `## ${h}\n\nContenido de ${h}.`).join("\n\n");
    const failures = check(body, "flow");
    expect(failures.map((f) => f.code)).toEqual(["DESIGN_HEADING_ORDER"]);
    expect(failures[0]?.action).toContain("Goal and outcome");
  });

  it("heading que el contrato no declara", () => {
    const body = `${fullBody("flow")}\n\n## Notas sueltas\n\nAlgo.`;
    expect(codes(body, "flow")).toContain("DESIGN_HEADING_UNKNOWN");
  });

  it("sección vacía", () => {
    const body = fullBody("flow", { "Permissions and privacy": "" });
    expect(codes(body, "flow")).toContain("DESIGN_SECTION_EMPTY");
  });
});

describe("checkHeadings — 'N/A' nunca satisface el contrato", () => {
  it.each(["N/A", "n/a", "NA", "TBD", "—", "-", "?", "pendiente"])(
    "rechaza '%s' como contenido de una sección",
    (placeholder) => {
      const body = fullBody("flow", { "Permissions and privacy": placeholder });
      expect(codes(body, "flow")).toContain("DESIGN_SECTION_PLACEHOLDER");
    },
  );

  it("en una sección ESENCIAL, el diagnóstico niega la no-aplicabilidad", () => {
    const body = fullBody("flow", { "Main journey": "N/A" });
    const failure = check(body, "flow").find((f) => f.code === "DESIGN_SECTION_PLACEHOLDER");
    expect(failure?.action).toContain("esencial");
    expect(failure?.action).not.toContain("not_applicable");
  });

  it("en una sección CONDICIONAL, el diagnóstico enseña la clave exacta a usar", () => {
    const body = fullBody("screen", { Localization: "N/A" });
    const failure = check(body, "screen").find((f) => f.code === "DESIGN_SECTION_PLACEHOLDER");
    expect(failure?.action).toContain("not_applicable.localization");
  });

  it("una afirmación real NO es un placeholder", () => {
    // "Ninguno" dice algo sobre el diseño; "N/A" se niega a decirlo.
    const body = fullBody("flow", { "Permissions and privacy": "Ninguno: el flow es público." });
    expect(codes(body, "flow")).toEqual([]);
  });
});

describe("bodyReferences — solo la forma canónica, nunca la prosa", () => {
  it("extrae las referencias exactas y las deduplica en orden", () => {
    const body = fullBody("flow", {
      "Main journey":
        "Arranca en DES-001/SCR-001@r2#default y termina en DES-001/SCR-002@r1#success.",
      Traceability: "Vuelve a DES-001/SCR-001@r2#default.",
    });
    expect(bodyReferences(parseBody(body, 1))).toEqual([
      "DES-001/SCR-001@r2#default",
      "DES-001/SCR-002@r1#success",
    ]);
  });

  it("ignora menciones informales: una referencia se escribe entera o no existe", () => {
    const body = fullBody("flow", {
      "Main journey": "Usa la pantalla de alta (SCR-001), revisión 2, estado default.",
    });
    expect(bodyReferences(parseBody(body, 1))).toEqual([]);
  });
});
