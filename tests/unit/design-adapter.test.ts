import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AdapterProfile,
  type AdapterRegistry,
  CONFORMANCE_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
  RENDER_CAPABILITIES,
  conformanceOf,
  declaredLosses,
  degradationFailure,
  findAdapter,
  requireAdapter,
  resolveCapability,
} from "../../src/domain/design/adapter.js";
import { validateDesignArtifact } from "../../src/domain/design/artifact.js";
import { validateDesignManifest } from "../../src/domain/design/manifest.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

/** El adapter de la prueba de fase: declara SOLO `handoff + record`. */
const ONE_WAY: AdapterProfile = {
  id: "prueba-una-via",
  title: "Adapter de una sola vía",
  version: 1,
  capabilities: {
    handoff: true,
    record: true,
    snapshot: false,
    generate: false,
    push: false,
    pull: false,
    compare: false,
  },
  losses: [],
  network: "never",
};

const NOTHING: AdapterProfile = {
  ...ONE_WAY,
  id: "prueba-nada",
  capabilities: {
    handoff: false,
    record: false,
    snapshot: false,
    generate: false,
    push: false,
    pull: false,
    compare: false,
  },
};

describe("F2 · un renderer o adapter declara lo que sabe hacer", () => {
  it("la matriz nombra las siete capacidades: tres de conformidad y cuatro opcionales", () => {
    expect([...CONFORMANCE_CAPABILITIES, ...OPTIONAL_CAPABILITIES].sort()).toEqual(
      [...RENDER_CAPABILITIES].sort(),
    );
    // Y la matriz de un perfil las responde TODAS: el tipo es lo que impide que
    // una capacidad quede sin declarar, así que un perfil no puede omitir una.
    expect(Object.keys(ONE_WAY.capabilities).sort()).toEqual([...RENDER_CAPABILITIES].sort());
  });

  // La prueba de fase, literal: un adapter que declara solo `handoff + record` y
  // al que se le pide `pull`.
  it("pedirle 'pull' a un adapter que declara 'handoff + record' devuelve una degradación explícita", () => {
    const resolution = resolveCapability(ONE_WAY, "pull");
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;

    const { degradation } = resolution;
    expect(degradation.capability).toBe("pull");
    expect(degradation.adapter).toBe("prueba-una-via");
    expect(degradation.message).toContain("no declara 'pull'");
    // No es un fallo mudo: nombra qué falta Y qué alternativa declarada existe.
    expect(degradation.alternative).toBe("record");
    expect(degradation.action).toContain("record");
  });

  it("una capacidad declarada se ejerce, sin degradación de por medio", () => {
    for (const capability of ["handoff", "record"] as const) {
      const resolution = resolveCapability(ONE_WAY, capability);
      expect(resolution.ok, capability).toBe(true);
    }
  });

  it("un adapter que no declara nada no inventa una alternativa", () => {
    const resolution = resolveCapability(NOTHING, "snapshot");
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.degradation.alternative).toBeNull();
    expect(resolution.degradation.action).toContain("handoff neutral local");
  });

  it("la degradación se puede convertir en fallo cuando quien llama no puede seguir", () => {
    const resolution = resolveCapability(ONE_WAY, "compare");
    if (resolution.ok) throw new Error("compare no está declarado");
    const failure = degradationFailure(resolution.degradation, "render-bundle.json");
    expect(failure.code).toBe("DESIGN_CAPABILITY_UNDECLARED");
    expect(failure.artifact).toBe("render-bundle.json");
    expect(failure.action.length).toBeGreaterThan(0);
  });

  it("un adapter de una sola vía sigue siendo válido: declara su conformidad parcial", () => {
    expect(conformanceOf(ONE_WAY)).toEqual(["handoff", "record"]);
  });

  it("las capacidades no declaradas entran al reporte de pérdidas del bundle", () => {
    const losses = declaredLosses(ONE_WAY);
    const subjects = losses.map((l) => l.subject);
    expect(subjects).toEqual([
      "capability:snapshot",
      "capability:generate",
      "capability:push",
      "capability:pull",
      "capability:compare",
    ]);
    expect(losses.every((l) => l.why.length > 0)).toBe(true);
  });
});

describe("F2 · el core del package no depende de cuenta, API ni proveedor", () => {
  const EMPTY: AdapterRegistry = {};

  it("un registro vacío no resuelve nada y lo dice sin adivinar", () => {
    expect(findAdapter("figma", EMPTY)).toBeNull();
    const required = requireAdapter("figma", EMPTY, "render-bundle.json");
    expect(required.ok).toBe(false);
    if (required.ok) return;
    expect(required.failure.code).toBe("DESIGN_ADAPTER_UNKNOWN");
    expect(required.failure.action).toContain("no necesita ninguno");
  });

  it("con un registro poblado, un id desconocido lista los que sí existen", () => {
    const registry: AdapterRegistry = { "prueba-una-via": ONE_WAY };
    const required = requireAdapter("figma-api", registry, "render-bundle.json");
    if (required.ok) return;
    expect(required.failure.action).toContain("prueba-una-via");
  });

  // T2.3: la ausencia TOTAL de adapters no impide validar ni leer. Se prueba
  // ejerciendo las dos operaciones locales sin registro alguno de por medio.
  it("validar y leer el package funcionan sin ningún adapter registrado", () => {
    const manifest = validateDesignManifest(
      JSON.parse(fixture("manifest-maximal.json")),
      "design-manifest.json",
    );
    expect(manifest.ok).toBe(true);

    const screen = validateDesignArtifact(
      fixture("SCR-001-r002-formulario-alta.md"),
      "screen",
      "screens/SCR-001-r002-formulario-alta.md",
    );
    expect(screen.failures).toEqual([]);
    expect(screen.value?.id).toBe("DES-001/SCR-001");
    expect(Object.keys(EMPTY)).toEqual([]);
  });
});
