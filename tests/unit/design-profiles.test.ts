import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cutRenderBundle } from "../../src/application/design/design-bundle-service.js";
import {
  CONFORMANCE_CAPABILITIES,
  OPTIONAL_CAPABILITIES,
  RENDER_CAPABILITIES,
  conformanceOf,
  findAdapter,
} from "../../src/domain/design/adapter.js";
import { planExternalSend } from "../../src/domain/design/external-send.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";
import {
  CLAUDE_ARTIFACT,
  CLAUDE_DESIGN,
  DESIGN_ADAPTERS,
  FIGMA,
  LOCATOR_REQUIREMENTS,
  PORTABLE_HTML,
  STITCH,
  checkProviderLocator,
} from "../../src/domain/design/profiles.js";
import {
  type RenditionProvider,
  type RenditionSource,
  computeSourceDigest,
} from "../../src/domain/design/rendition.js";
import { packageCandidate } from "../helpers/design-package.js";
import { MemFs } from "../helpers/mem-fs.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const WS = "/ws";
const PKG = "docs/designs/001-design-alta";
const SCREEN_PATH = "screens/SCR-001-r002-formulario-alta.md";

const digest = (text: string): string =>
  `sha256:${createHash("sha256").update(new TextEncoder().encode(text)).digest("hex")}`;

const SOURCES: RenditionSource[] = [
  { ref: "DES-001/SCR-001@r2", sha256: `sha256:${"6".repeat(64)}` },
];

const PREVIEW = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>\n';

/**
 * A package at r1 whose catalogued files are really on disk — and whose screen is
 * the real fixture document, because cutting a bundle PARSES what the closure
 * reaches: a placeholder body would fail to expand.
 */
function workspace(): MemFs {
  const manifest = JSON.parse(fixture("manifest-maximal.json")) as DesignManifest;
  const first = manifest.baselines[0];
  if (first === undefined) throw new Error("el fixture no trae baselines");
  manifest.baselines = [first];
  manifest.current_baseline = { revision: 1, path: first.path, digest: first.digest };
  manifest.governance.revocations = [];
  const review = manifest.governance.reviews[0];
  if (review !== undefined) review.target = "DES-001@r1";
  manifest.catalog.flows = [];
  manifest.catalog.screens = [
    {
      id: "SCR-001",
      revision: 2,
      path: SCREEN_PATH,
      supersedes: null,
      maturity: "handoff",
      states: ["default", "error"],
    },
  ];
  manifest.currentness = [];

  const fs = new MemFs();
  fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(manifest, null, 2));
  fs.file(`${WS}/${PKG}/${SCREEN_PATH}`, fixture("SCR-001-r002-formulario-alta.md"));
  for (const key of ["rules", "tokens", "renditions"] as const) {
    for (const entry of manifest.catalog[key]) {
      fs.file(`${WS}/${PKG}/${entry.path}`, `contenido de ${entry.path}\n`);
    }
  }
  for (const asset of manifest.catalog.assets) {
    fs.file(`${WS}/${PKG}/${asset.path}`, `contenido de ${asset.path}\n`);
  }
  return fs;
}

/** A rendition recorded against a provider, with its preview really digested. */
function recorded(id: string, provider: RenditionProvider | null): string {
  return `${JSON.stringify(
    {
      schema: "workline.design-rendition/v1",
      id: `DES-001/${id}`,
      revision: 1,
      supersedes: null,
      purpose: "Registro del resultado entregado por el bundle",
      medium: "static_image",
      fidelity: "medium",
      tool: provider?.name ?? "portable-html",
      format: "svg",
      context: {
        platform: "web",
        viewport: "1280x800",
        theme: "light",
        locale: "es-PE",
        variants: [],
      },
      sources: SOURCES,
      source_digest: computeSourceDigest(SOURCES),
      coverage: { criteria: ["S013/AC-REN-08"], states: ["default"] },
      files: [{ path: "preview.svg", sha256: digest(PREVIEW) }],
      provider,
      access: provider === null ? "local_only" : "team",
      interaction_evidence: null,
      data_classification: "synthetic",
    },
    null,
    2,
  )}\n`;
}

const FIGMA_PROVIDER: RenditionProvider = {
  name: "figma",
  locator: { file_key: "abc123DEF456", node_id: "12:345" },
  version: "2026-08-03T10:00:00Z",
  sync: "unknown",
};

describe("F6 · la conformidad v1 son dos perfiles utilizables y cinco destinos declarados", () => {
  it("los perfiles conformantes declaran handoff y record, y ninguno implementa las cuatro opcionales", () => {
    for (const profile of Object.values(DESIGN_ADAPTERS)) {
      expect(conformanceOf(profile)).toContain("handoff");
      expect(conformanceOf(profile)).toContain("record");
      for (const optional of OPTIONAL_CAPABILITIES) {
        expect(profile.capabilities[optional], `${profile.id}.${optional}`).toBe(false);
      }
      // Completa por construcción: la matriz responde por las siete.
      expect(Object.keys(profile.capabilities).sort()).toEqual([...RENDER_CAPABILITIES].sort());
    }
  });

  it("los dos que conservan una copia local son el portable y el artifact", () => {
    const snapshotting = Object.values(DESIGN_ADAPTERS)
      .filter((p) => p.capabilities.snapshot)
      .map((p) => p.id)
      .sort();
    expect(snapshotting).toEqual(["claude-artifact", "portable-html"]);
  });

  it("Figma no exige red para ser conformante: entrega y registra", () => {
    expect(conformanceOf(FIGMA)).toEqual(["handoff", "record"]);
    expect(CONFORMANCE_CAPABILITIES.filter((c) => FIGMA.capabilities[c])).toEqual([
      "handoff",
      "record",
    ]);
    expect(findAdapter("figma", DESIGN_ADAPTERS)).toBe(FIGMA);
  });

  it("cada destino que la spec nombra tiene su perfil y su requisito de locator", () => {
    for (const profile of [FIGMA, STITCH, CLAUDE_DESIGN, CLAUDE_ARTIFACT]) {
      expect(LOCATOR_REQUIREMENTS[profile.id], profile.id).toBeDefined();
    }
    expect(PORTABLE_HTML.network).toBe("never");
  });
});

describe("F6 · un locator localiza, y un proveedor sin versión estable lo declara", () => {
  it("una rendition puramente local no necesita locator", () => {
    expect(checkProviderLocator(null, "rendition.json")).toEqual([]);
  });

  it("el locator mínimo de Figma es file_key y node_id", () => {
    expect(checkProviderLocator(FIGMA_PROVIDER, "rendition.json")).toEqual([]);
    const missing = checkProviderLocator(
      { ...FIGMA_PROVIDER, locator: { file_key: "abc123DEF456" } },
      "rendition.json",
    );
    expect(missing.map((f) => f.code)).toEqual(["DESIGN_LOCATOR_INCOMPLETE"]);
    expect(missing[0]?.message).toContain("node_id");
  });

  it("Stitch localiza por proyecto y screen", () => {
    const ok = checkProviderLocator(
      {
        name: "stitch",
        locator: { project_id: "p-1", screen_id: "s-9" },
        version: "2026-08-03T10:00:00Z",
        sync: "unknown",
      },
      "rendition.json",
    );
    expect(ok).toEqual([]);
  });

  // T6.3: la ausencia de versión estable es una propiedad DE LA HERRAMIENTA. Claude
  // Design no expone una, así que null es la respuesta honesta y lo verificable es
  // el snapshot local con su source_digest; Figma sí expone una y omitirla se rechaza.
  it("un proveedor sin versión estable admite version null; uno que la expone, no", () => {
    expect(
      checkProviderLocator(
        {
          name: "claude-design",
          // «Proyecto o URL MÁS locator del handoff/export»: las dos mitades.
          locator: { url: "https://claude.ai/design/x", export: "handoff-2026-08-03" },
          version: null,
          sync: "unknown",
        },
        "rendition.json",
      ),
    ).toEqual([]);
    const figmaWithoutVersion = checkProviderLocator(
      { ...FIGMA_PROVIDER, version: null },
      "rendition.json",
    );
    expect(figmaWithoutVersion.map((f) => f.code)).toEqual(["DESIGN_LOCATOR_INCOMPLETE"]);
    expect(figmaWithoutVersion[0]?.message).toContain("versión estable");
  });

  it("un proveedor que este Workline no conoce no recibe un requisito inventado", () => {
    expect(
      checkProviderLocator(
        { name: "una-herramienta-nueva", locator: { id: "x" }, version: null, sync: "unknown" },
        "rendition.json",
      ),
    ).toEqual([]);
  });

  it("una rendition con un locator incompleto no se publica", async () => {
    const result = await packageCandidate(workspace(), WS, {
      packagePath: PKG,
      files: [
        {
          path: "renditions/VIS-002-r001-figma/rendition.json",
          content: recorded("VIS-002", { ...FIGMA_PROVIDER, locator: { node_id: "12:345" } }),
        },
        { path: "renditions/VIS-002-r001-figma/preview.svg", content: PREVIEW },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_LOCATOR_INCOMPLETE");
  });
});

describe("F6 · el mismo bundle entregado a los dos perfiles queda como renditions de la misma revisión", () => {
  it("dos salidas, dos renditions, una sola revisión fuente", async () => {
    const fs = workspace();
    const roots = ["DES-001/SCR-001@r2"];
    const forFigma = await cutRenderBundle(fs, WS, {
      packageId: "DES-001",
      roots,
      adapter: FIGMA,
      sendAuthorization: "el equipo autorizó preparar el archivo en Figma",
      generated: "2026-08-03",
    });
    const forPortable = await cutRenderBundle(fs, WS, {
      packageId: "DES-001",
      roots,
      adapter: PORTABLE_HTML,
      generated: "2026-08-03",
    });
    if (!forFigma.ok) throw new Error(JSON.stringify(forFigma.failures));
    if (!forPortable.ok) throw new Error(JSON.stringify(forPortable.failures));

    // Mismo baseline y misma clausura: lo que cambia es el perfil y sus pérdidas.
    expect(forFigma.value.baseline_digest).toBe(forPortable.value.baseline_digest);
    expect(forFigma.value.closure.map((m) => m.ref)).toEqual(
      forPortable.value.closure.map((m) => m.ref),
    );
    expect(forFigma.value.digest).not.toBe(forPortable.value.digest);

    const result = await packageCandidate(fs, WS, {
      packagePath: PKG,
      files: [
        {
          path: "renditions/VIS-002-r001-figma/rendition.json",
          content: recorded("VIS-002", FIGMA_PROVIDER),
        },
        { path: "renditions/VIS-002-r001-figma/preview.svg", content: PREVIEW },
        {
          path: "renditions/VIS-003-r001-portable/rendition.json",
          content: recorded("VIS-003", null),
        },
        { path: "renditions/VIS-003-r001-portable/preview.svg", content: PREVIEW },
      ],
    });
    if (!result.ok) throw new Error(JSON.stringify(result.failures));

    const ids = result.value.manifest.catalog.renditions.map((e) => e.id);
    expect(ids).toContain("VIS-002");
    expect(ids).toContain("VIS-003");
    // Y las dos declaran la MISMA revisión fuente: es lo que las hace dos vistas de
    // un diseño en vez de dos diseños.
    const both = [recorded("VIS-002", FIGMA_PROVIDER), recorded("VIS-003", null)].map(
      (doc) => (JSON.parse(doc) as { source_digest: string }).source_digest,
    );
    expect(both[0]).toBe(both[1]);
  });
});

describe("F6 · ningún envío externo ocurre sin autorización visible", () => {
  it("un intento sin autorización no envía y explica qué falta y qué se enviaría", async () => {
    const cut = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-001@r2"],
      adapter: FIGMA,
      generated: "2026-08-03",
    });
    if (!cut.ok) throw new Error(JSON.stringify(cut.failures));

    const preflight = cut.preflight;
    if (preflight === null) throw new Error("un perfil opt_in tiene que traer preflight");
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;

    expect(preflight.failure.code).toBe("DESIGN_SEND_UNAUTHORIZED");
    // Lo que se autorizaría, enumerado: sin esto la autorización es abstracta.
    expect(preflight.plan.would_send.documents.length).toBeGreaterThan(0);
    expect(preflight.plan.would_send.data_classification).toBe("synthetic");
    expect(preflight.failure.message).toContain("revisión(es)");
    // Y el handoff neutral local sigue disponible: el bundle se entregó igual.
    expect(cut.value.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(preflight.plan.local_handoff).toContain("disponible localmente");
  });

  it("con la autorización declarada el plan queda en verde", async () => {
    const cut = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-001@r2"],
      adapter: FIGMA,
      sendAuthorization: "el equipo autorizó preparar el archivo en Figma",
      generated: "2026-08-03",
    });
    if (!cut.ok) throw new Error(JSON.stringify(cut.failures));
    expect(cut.preflight?.ok).toBe(true);
  });

  it("un perfil que nunca alcanza a un tercero no pide autorización ni trae preflight", async () => {
    const cut = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-001@r2"],
      adapter: PORTABLE_HTML,
      generated: "2026-08-03",
    });
    if (!cut.ok) throw new Error(JSON.stringify(cut.failures));
    expect(cut.preflight).toBeNull();
  });

  // La capacidad se resuelve ANTES de la autorización: mandar a alguien a pedir
  // permiso para una operación que el perfil no soporta es un callejón.
  it("pedir una capacidad no declarada degrada aunque el envío esté autorizado", async () => {
    const cut = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-001@r2"],
      adapter: FIGMA,
      generated: "2026-08-03",
    });
    if (!cut.ok) throw new Error(JSON.stringify(cut.failures));

    const outcome = planExternalSend({
      adapter: FIGMA,
      bundle: cut.value,
      capability: "pull",
      authorization: "autorizado",
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("DESIGN_CAPABILITY_UNDECLARED");
    expect(outcome.failure.action).toContain("record");
    expect(outcome.plan.would_send.package).toBe("DES-001");
  });
});

describe("F6 · un locator nunca suplanta la identidad canónica", () => {
  it("dos renditions con el mismo locator siguen siendo dos identidades distintas", () => {
    const one = JSON.parse(recorded("VIS-002", FIGMA_PROVIDER)) as Record<string, unknown>;
    const other = JSON.parse(recorded("VIS-003", FIGMA_PROVIDER)) as Record<string, unknown>;
    expect(one.provider).toEqual(other.provider);
    expect(one.id).not.toBe(other.id);
    // La obsolescencia se sigue derivando del digest de las fuentes, no del locator.
    expect(one.source_digest).toBe(computeSourceDigest(SOURCES));
  });
});
