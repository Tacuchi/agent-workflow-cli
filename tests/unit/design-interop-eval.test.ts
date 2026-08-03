import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cutRenderBundle } from "../../src/application/design/design-bundle-service.js";
import { readDesignIndex } from "../../src/application/design/design-index-service.js";
import {
  type AdapterProfile,
  type AdapterRegistry,
  requireAdapter,
} from "../../src/domain/design/adapter.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";
import { FIGMA, PORTABLE_HTML } from "../../src/domain/design/profiles.js";
import { type RenderBundle, canonicalRenderBundle } from "../../src/domain/design/render-bundle.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The comparative eval (F8): does the SAME package survive being rendered through
 * two different profiles?
 *
 * The rubric is three questions, and the third is the one that is easy to get
 * wrong. Identity and traceability must be IDENTICAL across profiles — a bundle
 * that renames, renumbers or loses a revision on the way out has already broken the
 * contract. But the losses must DIFFER, and their difference is the expected
 * result: a profile that declares nothing lost is not a better profile, it is a
 * profile that stopped telling the truth. So the eval asserts that the two bundles
 * are identical once the profile facet is set aside, and that each one declares
 * what it cannot do.
 */

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const WS = "/ws";
const PKG = "docs/designs/001-design-alta";

/** The corpus: a simple screen, one with several states, and a flow with alternatives. */
const CORPUS: ReadonlyArray<{ name: string; roots: string[] }> = [
  { name: "screen simple", roots: ["DES-001/SCR-002@r1"] },
  {
    name: "screen con estados múltiples",
    roots: ["DES-001/SCR-001@r2#default", "DES-001/SCR-001@r2#error"],
  },
  { name: "flow con alternativas y errores", roots: ["DES-001/FLW-001@r2"] },
];

const CONFORMING: ReadonlyArray<AdapterProfile> = [PORTABLE_HTML, FIGMA];

function workspace(): MemFs {
  const manifest = JSON.parse(fixture("manifest-maximal.json")) as DesignManifest;
  manifest.catalog.flows = [
    {
      id: "FLW-001",
      revision: 2,
      path: "flows/FLW-001-r002-alta-miembro.md",
      supersedes: null,
      maturity: "handoff",
    },
  ];
  manifest.catalog.screens = [
    {
      id: "SCR-001",
      revision: 2,
      path: "screens/SCR-001-r002-formulario-alta.md",
      supersedes: null,
      maturity: "handoff",
      states: ["default", "error"],
    },
    {
      id: "SCR-002",
      revision: 1,
      path: "screens/SCR-002-r001-confirmacion.md",
      supersedes: null,
      maturity: "handoff",
      states: ["success"],
    },
  ];
  manifest.currentness = [];

  const fs = new MemFs();
  fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(manifest, null, 2));
  fs.file(
    `${WS}/${PKG}/flows/FLW-001-r002-alta-miembro.md`,
    fixture("FLW-001-r002-alta-miembro.md"),
  );
  fs.file(
    `${WS}/${PKG}/screens/SCR-001-r002-formulario-alta.md`,
    fixture("SCR-001-r002-formulario-alta.md"),
  );
  fs.file(
    `${WS}/${PKG}/screens/SCR-002-r001-confirmacion.md`,
    fixture("SCR-002-r001-confirmacion.md"),
  );
  fs.file(`${WS}/${PKG}/design-system/rules/RUL-001-r001-densidad.md`, "# densidad compacta\n");
  fs.file(`${WS}/${PKG}/tokens/TOK-001-r001-base.tokens.json`, '{"color":{}}\n');
  fs.file(
    `${WS}/${PKG}/renditions/VIS-001-r001-formulario-alta/rendition.json`,
    fixture("rendition-VIS-001-r001.json"),
  );
  fs.file(`${WS}/${PKG}/assets/${"5".repeat(64)}-logo.svg`, "<svg/>\n");
  return fs;
}

/** What the rubric measures, per corpus item and profile. */
interface Measurement {
  item: string;
  profile: string;
  /** Identity: the exact revisions handed over, and the bytes behind each. */
  identity: string[];
  /** Traceability: obligations attributed to the revision that states them. */
  obligations: string[];
  /** Meaning: the states each member was asked for. */
  states: string[];
  /** Declared losses — expected result, not defect. */
  losses: string[];
  /** The content with the profile facet set aside, for the cross-profile compare. */
  neutral: string;
}

async function measure(
  fs: MemFs,
  item: { name: string; roots: string[] },
  profile: AdapterProfile,
): Promise<Measurement> {
  const cut = await cutRenderBundle(fs, WS, {
    packageId: "DES-001",
    roots: item.roots,
    adapter: profile,
    ...(profile.network === "never" ? {} : { sendAuthorization: "eval: envío autorizado" }),
    generated: "2026-08-03",
  });
  if (!cut.ok) throw new Error(`${item.name} / ${profile.id}: ${JSON.stringify(cut.failures)}`);
  return {
    item: item.name,
    profile: profile.id,
    identity: cut.value.closure.map((m) => `${m.ref} ${m.sha256}`),
    obligations: cut.value.accessibility.map((o) => o.ref),
    states: cut.value.closure.map((m) => `${m.ref}: ${m.states.join("+") || "(toda la revisión)"}`),
    losses: cut.value.losses.map((l) => l.subject).sort(),
    neutral: neutralize(cut.value),
  };
}

/**
 * The bundle with everything profile-specific removed. What is left is what the
 * package MEANS, and it must not depend on who is going to draw it.
 */
function neutralize(bundle: RenderBundle): string {
  return canonicalRenderBundle({
    ...bundle,
    adapter: { profile: "(perfil)", version: 0 },
    losses: [],
  });
}

async function runEval(fs: MemFs): Promise<Measurement[]> {
  const out: Measurement[] = [];
  for (const item of CORPUS) {
    for (const profile of CONFORMING) out.push(await measure(fs, item, profile));
  }
  return out;
}

describe("F8 · un mismo package conserva identidad, trazabilidad y significado en los dos perfiles", () => {
  it("el corpus cubre una screen simple, una con estados múltiples y un flow con alternativas", async () => {
    const fs = workspace();
    const results = await runEval(fs);
    expect(results).toHaveLength(CORPUS.length * CONFORMING.length);

    // El flow arrastra sus dos screens: si el corpus no cubriera un recorrido con
    // alternativas, esto sería una clausura de una sola pantalla.
    const flow = results.find((r) => r.item === "flow con alternativas y errores");
    const refs = (flow?.identity ?? []).map((line) => line.split(" ")[0]);
    expect(refs).toContain("DES-001/FLW-001@r2");
    expect(refs).toContain("DES-001/SCR-001@r2");
    expect(refs).toContain("DES-001/SCR-002@r1");
  });

  it.each(CORPUS.map((c) => [c.name] as const))(
    "%s — identidad, trazabilidad y significado idénticos entre perfiles",
    async (name) => {
      const fs = workspace();
      const results = (await runEval(fs)).filter((r) => r.item === name);
      const [first, ...rest] = results;
      if (first === undefined) throw new Error("la eval no midió nada");

      for (const other of rest) {
        expect(other.identity, `identidad ${other.profile}`).toEqual(first.identity);
        expect(other.obligations, `trazabilidad ${other.profile}`).toEqual(first.obligations);
        expect(other.states, `significado ${other.profile}`).toEqual(first.states);
        // Lo único que difiere es el perfil y sus pérdidas.
        expect(other.neutral, `contenido neutral ${other.profile}`).toEqual(first.neutral);
        expect(other.losses).not.toEqual(first.losses);
      }
      // Y las obligaciones se atribuyen a revisiones que el bundle entregó.
      const refs = new Set(first.identity.map((line) => line.split(" ")[0]));
      for (const owner of first.obligations) expect(refs.has(owner)).toBe(true);
    },
  );

  it("las pérdidas declaradas son parte del resultado esperado, no un defecto", async () => {
    const fs = workspace();
    const results = await runEval(fs);
    for (const measurement of results) {
      expect(measurement.losses.length, measurement.profile).toBeGreaterThan(0);
      // Cada capacidad no declarada aparece como pérdida: es lo que hace que un
      // consumidor sepa qué NO va a poder hacer antes de intentarlo.
      expect(measurement.losses).toContain("capability:pull");
      expect(measurement.losses).toContain("capability:generate");
    }
    const figma = results.find((r) => r.profile === "figma");
    const portable = results.find((r) => r.profile === "portable-html");
    // Y la diferencia entre perfiles es informativa: el portable conserva copia
    // local, así que `snapshot` no está entre sus pérdidas y en Figma sí.
    expect(figma?.losses).toContain("capability:snapshot");
    expect(portable?.losses).not.toContain("capability:snapshot");
  });

  it("el resultado es reproducible: dos corridas miden lo mismo", async () => {
    const first = await runEval(workspace());
    const second = await runEval(workspace());
    expect(second).toEqual(first);
  });
});

describe("F8 · el core sigue funcionando con los proveedores indisponibles", () => {
  it("validar, leer y hacer handoff neutral no necesitan ningún adapter registrado", async () => {
    const fs = workspace();
    const empty: AdapterRegistry = {};

    // Leer y validar: el índice resuelve el package entero sin consultar a nadie.
    const index = await readDesignIndex(fs, WS);
    const found = index.packages.find((p) => p.id === "DES-001");
    expect(found?.ok, JSON.stringify(found?.failures ?? [])).toBe(true);

    // Handoff neutral: el perfil local no alcanza a ningún tercero y no trae preflight.
    const cut = await cutRenderBundle(fs, WS, {
      packageId: "DES-001",
      roots: ["DES-001/FLW-001@r2"],
      adapter: PORTABLE_HTML,
      generated: "2026-08-03",
    });
    if (!cut.ok) throw new Error(JSON.stringify(cut.failures));
    expect(cut.preflight).toBeNull();
    expect(cut.value.closure.length).toBeGreaterThan(2);

    // Y pedir un perfil que no está registrado dice que el camino local no lo necesita.
    const required = requireAdapter("figma", empty, "render-bundle.json");
    expect(required.ok).toBe(false);
    if (!required.ok) {
      expect(required.failure.code).toBe("DESIGN_ADAPTER_UNKNOWN");
      expect(required.failure.action).toContain("no necesita ninguno");
    }
  });

  it("y el registro de perfiles no es una dependencia del core: quitarlos no cambia el bundle", async () => {
    const fs = workspace();
    const withRegistry = await cutRenderBundle(fs, WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-002@r1"],
      adapter: PORTABLE_HTML,
      generated: "2026-08-03",
    });
    // El mismo perfil pasado a mano, sin pasar por el registro: el bundle es idéntico
    // porque el core depende del PERFIL, no de que exista un catálogo de perfiles.
    const inline = await cutRenderBundle(fs, WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-002@r1"],
      adapter: { ...PORTABLE_HTML },
      generated: "2026-08-03",
    });
    if (!withRegistry.ok || !inline.ok) throw new Error("el corte falló");
    expect(inline.value.digest).toBe(withRegistry.value.digest);
  });
});
