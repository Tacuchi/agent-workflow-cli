import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DesignArtifact } from "../../src/domain/design/artifact.js";
import { computeClosure, notReadyForHandoff } from "../../src/domain/design/closure.js";
import { validateDesignManifest } from "../../src/domain/design/manifest.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

/**
 * A package as they really are: many screens sketched, a few promoted.
 *
 * Ten screens in `outline`, three in `handoff`, one flow that touches only the
 * three — the exact shape the phase's validation asks for.
 */
function mixedPackage(): {
  manifest: DesignManifest;
  read: (path: string) => DesignArtifact | null;
} {
  const raw = JSON.parse(fixture("manifest-maximal.json")) as Record<string, unknown>;
  const catalog = raw.catalog as Record<string, Array<Record<string, unknown>>>;

  catalog.screens = [];
  for (let n = 1; n <= 13; n++) {
    const id = `SCR-${String(n).padStart(3, "0")}`;
    catalog.screens.push({
      id,
      revision: 1,
      path: `screens/${id}-r001-pantalla.md`,
      supersedes: null,
      maturity: n <= 3 ? "handoff" : "outline",
      states: ["default"],
    });
  }
  catalog.flows = [
    {
      id: "FLW-001",
      revision: 1,
      path: "flows/FLW-001-r001-recorrido.md",
      supersedes: null,
      maturity: "handoff",
    },
  ];
  raw.currentness = [];
  (raw.governance as { reviews: Array<Record<string, unknown>> }).reviews[0].target = "DES-001@r1";
  (raw.governance as { revocations: unknown[] }).revocations = [];

  const parsed = validateDesignManifest(raw);
  if (!parsed.ok || parsed.value === null) {
    throw new Error(`el fixture no valida: ${parsed.failures[0]?.message}`);
  }

  // El flow toca SOLO las tres promovidas, y una de ellas depende de una rule.
  const documents = new Map<string, DesignArtifact>();
  documents.set("flows/FLW-001-r001-recorrido.md", {
    kind: "flow",
    schema: "workline.ui-flow/v1",
    id: "DES-001/FLW-001",
    revision: 1,
    maturity: "handoff",
    supersedes: null,
    purpose: "recorrido",
    platform: "web",
    actors: ["operador"],
    entry: "DES-001/SCR-001@r1#default",
    nodes: [
      "DES-001/SCR-001@r1#default",
      "DES-001/SCR-002@r1#default",
      "DES-001/SCR-003@r1#default",
    ],
    edges: [],
    dependencies: [],
    trace: [],
    unknowns: [],
    external: [],
    not_applicable: {},
  });
  for (const n of [1, 2, 3]) {
    const id = `SCR-${String(n).padStart(3, "0")}`;
    documents.set(`screens/${id}-r001-pantalla.md`, {
      kind: "screen",
      schema: "workline.ui-screen/v1",
      id: `DES-001/${id}`,
      revision: 1,
      maturity: "handoff",
      supersedes: null,
      title: id,
      purpose: "pantalla",
      platform: "web",
      default_state: "default",
      states: [{ anchor: "default", purpose: "base" }],
      flow_refs: [],
      dependencies: {
        rules: n === 1 ? ["DES-001/RUL-001@r1"] : [],
        tokens: [],
        assets:
          n === 1
            ? ["sha256:5555555555555555555555555555555555555555555555555555555555555555"]
            : [],
      },
      trace: [],
      unknowns: [],
      external: [],
      not_applicable: {},
    });
  }
  return {
    manifest: parsed.value as DesignManifest,
    read: (path) => documents.get(path) ?? null,
  };
}

describe("la clausura sale de las raíces exactas de una tarea", () => {
  it("un flow alcanza sus screens y sus dependencias, y nada más", () => {
    const { manifest, read } = mixedPackage();
    const closure = computeClosure(manifest, ["DES-001/FLW-001@r1"], read);

    expect(closure.failures).toEqual([]);
    expect(closure.members.map((m) => m.ref).sort()).toEqual([
      "DES-001/FLW-001@r1",
      "DES-001/RUL-001@r1",
      "DES-001/SCR-001@r1",
      "DES-001/SCR-002@r1",
      "DES-001/SCR-003@r1",
    ]);
    expect(closure.assets).toEqual([
      "sha256:5555555555555555555555555555555555555555555555555555555555555555",
    ]);
  });

  it("y las diez screens que nadie consume quedan intactas fuera de la clausura", () => {
    const { manifest, read } = mixedPackage();
    const closure = computeClosure(manifest, ["DES-001/FLW-001@r1"], read);
    const alcanzadas = new Set(closure.members.map((m) => m.ref));

    expect(manifest.catalog.screens.filter((s) => s.maturity === "outline")).toHaveLength(10);
    for (const screen of manifest.catalog.screens) {
      const ref = `DES-001/${screen.id}@r${screen.revision}`;
      // Exactamente las tres promovidas; ninguna de las diez en outline.
      expect(alcanzadas.has(ref)).toBe(screen.maturity === "handoff");
    }
  });

  it("una raíz anclada arrastra su estado, y dos caminos suman anchors", () => {
    const { manifest, read } = mixedPackage();
    const closure = computeClosure(
      manifest,
      ["DES-001/SCR-001@r1#default", "DES-001/SCR-001@r1#error"],
      read,
    );
    const screen = closure.members.find((m) => m.ref === "DES-001/SCR-001@r1");
    expect(screen?.states.sort()).toEqual(["default", "error"]);
  });

  it("cada miembro dice quién lo trajo; la raíz no viene de nadie", () => {
    const { manifest, read } = mixedPackage();
    const closure = computeClosure(manifest, ["DES-001/FLW-001@r1"], read);
    expect(closure.members.find((m) => m.ref === "DES-001/FLW-001@r1")?.via).toBe(null);
    expect(closure.members.find((m) => m.ref === "DES-001/SCR-001@r1")?.via).toBe(
      "DES-001/FLW-001@r1",
    );
  });
});

describe("la clausura falla cerrado", () => {
  it("una raíz de otro package no se resuelve por parecido", () => {
    const { manifest, read } = mixedPackage();
    const closure = computeClosure(manifest, ["DES-002/SCR-001@r1"], read);
    expect(closure.members).toEqual([]);
    expect(closure.failures[0]?.code).toBe("DESIGN_REFERENCE_MISSING");
  });

  it("una revisión que el catálogo no tiene no se sustituye por la vigente", () => {
    const { manifest, read } = mixedPackage();
    const closure = computeClosure(manifest, ["DES-001/SCR-001@r9"], read);
    expect(closure.members).toEqual([]);
    expect(closure.failures[0]?.action).toContain("no adivina la vigente");
  });

  it("un archivo que el catálogo promete y no está se nombra", () => {
    const { manifest } = mixedPackage();
    const closure = computeClosure(manifest, ["DES-001/FLW-001@r1"], () => null);
    expect(closure.failures[0]?.code).toBe("DESIGN_REFERENCE_FILE_MISSING");
    expect(closure.failures[0]?.artifact).toBe("flows/FLW-001-r001-recorrido.md");
  });

  it("un ciclo entre documentos termina", () => {
    const { manifest } = mixedPackage();
    const ciclo = (path: string): DesignArtifact | null => {
      const id = path.includes("SCR-001") ? "SCR-001" : "SCR-002";
      const otra = id === "SCR-001" ? "SCR-002" : "SCR-001";
      return {
        kind: "flow",
        schema: "workline.ui-flow/v1",
        id: "DES-001/FLW-001",
        revision: 1,
        maturity: "outline",
        supersedes: null,
        purpose: "ciclo",
        platform: "web",
        actors: [],
        entry: `DES-001/${otra}@r1`,
        nodes: [`DES-001/${otra}@r1`],
        edges: [],
        dependencies: [],
        trace: [],
        unknowns: [],
        external: [],
        not_applicable: {},
      };
    };
    const closure = computeClosure(manifest, ["DES-001/SCR-001@r1"], ciclo);
    expect(closure.members.map((m) => m.ref).sort()).toEqual([
      "DES-001/SCR-001@r1",
      "DES-001/SCR-002@r1",
    ]);
  });
});

describe("implementar contra un outline falla cerrado", () => {
  it("nombra exactamente los miembros que todavía no son handoff", () => {
    const { manifest, read } = mixedPackage();
    const closure = computeClosure(manifest, ["DES-001/SCR-009@r1"], read);
    const pendientes = notReadyForHandoff(manifest, closure);
    expect(pendientes.map((m) => m.ref)).toEqual(["DES-001/SCR-009@r1"]);
  });

  it("y no reporta nada cuando la clausura entera está promovida", () => {
    const { manifest, read } = mixedPackage();
    const closure = computeClosure(manifest, ["DES-001/FLW-001@r1"], read);
    expect(notReadyForHandoff(manifest, closure)).toEqual([]);
  });
});

describe("la clausura no camina la arista inversa", () => {
  /** Screens that DECLARE which flows visit them — la forma real de un package. */
  function conPertenencia() {
    const base = mixedPackage();
    const manifest = base.manifest;
    manifest.catalog.flows.push({
      id: "FLW-002",
      revision: 1,
      path: "flows/FLW-002-r001-otro.md",
      supersedes: null,
      maturity: "outline",
    });
    const read = (path: string): DesignArtifact | null => {
      const document = base.read(path);
      if (document === null || document.kind !== "screen") return document;
      // SCR-002 pertenece además a un flow que la tarea NO consume.
      return document.id.endsWith("SCR-002")
        ? { ...document, flow_refs: ["DES-001/FLW-002@r1"] }
        : document;
    };
    return { manifest, read };
  }

  it("pertenecer a un flow no arrastra ese flow ni lo que ese flow toca", () => {
    const { manifest, read } = conPertenencia();
    const closure = computeClosure(manifest, ["DES-001/FLW-001@r1"], read);
    expect(closure.members.map((m) => m.ref)).not.toContain("DES-001/FLW-002@r1");
    expect(notReadyForHandoff(manifest, closure)).toEqual([]);
  });
});

describe("alcanzar dos veces solo puede AMPLIAR", () => {
  it("la revisión entera no se estrecha por un anchor posterior", () => {
    const { manifest, read } = mixedPackage();
    const entera = computeClosure(
      manifest,
      ["DES-001/SCR-001@r1", "DES-001/SCR-001@r1#error"],
      read,
    );
    expect(entera.members.find((m) => m.ref === "DES-001/SCR-001@r1")?.states).toEqual([]);
  });

  it("y en el orden inverso tampoco", () => {
    const { manifest, read } = mixedPackage();
    const entera = computeClosure(
      manifest,
      ["DES-001/SCR-001@r1#error", "DES-001/SCR-001@r1"],
      read,
    );
    expect(entera.members.find((m) => m.ref === "DES-001/SCR-001@r1")?.states).toEqual([]);
  });
});

describe("un asset alcanzado es un asset custodiado", () => {
  it("un digest que el package no tiene se reporta, no se afirma", () => {
    const base = mixedPackage();
    const read = (path: string): DesignArtifact | null => {
      const document = base.read(path);
      if (document === null || document.kind !== "screen") return document;
      return {
        ...document,
        dependencies: { ...document.dependencies, assets: [`sha256:${"f".repeat(64)}`] },
      };
    };
    const closure = computeClosure(base.manifest, ["DES-001/SCR-001@r1"], read);
    expect(closure.assets).toEqual([]);
    expect(closure.failures[0]?.message).toContain("no custodia el asset");
  });
});
