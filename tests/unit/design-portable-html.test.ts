import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cutRenderBundle } from "../../src/application/design/design-bundle-service.js";
import { readDesignIndex } from "../../src/application/design/design-index-service.js";
import { publishDesignRevision } from "../../src/application/design/design-publish-service.js";
import { type AdapterRegistry, requireAdapter } from "../../src/domain/design/adapter.js";
import { type ScreenArtifact, validateDesignArtifact } from "../../src/domain/design/artifact.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";
import { checkOfflineHtml } from "../../src/domain/design/offline.js";
import { PORTABLE_HTML } from "../../src/domain/design/profiles.js";
import {
  type RenditionSource,
  computeSourceDigest,
  validateDesignRendition,
} from "../../src/domain/design/rendition.js";
import { crossVisualEvidence } from "../../src/domain/design/visual-evidence.js";
import { MemFs } from "../helpers/mem-fs.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const WS = "/ws";
const PKG = "docs/designs/001-design-alta";

const digest = (text: string): string =>
  `sha256:${createHash("sha256").update(new TextEncoder().encode(text)).digest("hex")}`;

const SOURCES: RenditionSource[] = [
  { ref: "DES-001/SCR-001@r2", sha256: `sha256:${"6".repeat(64)}` },
];

/** A self-sufficient export: everything it shows travels inside it. */
const OFFLINE_HTML = `<!doctype html>
<style>body{font-family:system-ui}.card{background:#fff}</style>
<div class="card"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>
<img alt="logo" src="logo.svg"><img alt="inline" src="data:image/gif;base64,R0lGOD"></div>
<a href="#detalle">detalle</a>
`;

/** One rendition document, with its files' digests really computed. */
function rendition(
  overrides: Record<string, unknown> = {},
  files: Array<[string, string]> = [],
): string {
  const doc: Record<string, unknown> = {
    schema: "workline.design-rendition/v1",
    id: "DES-001/VIS-002",
    revision: 1,
    supersedes: null,
    purpose: "Export portable del formulario de alta",
    medium: "interactive_html",
    fidelity: "medium",
    tool: "portable-html",
    format: "html",
    context: {
      platform: "web",
      viewport: "1280x800",
      theme: "light",
      locale: "es-PE",
      variants: [],
    },
    sources: SOURCES,
    source_digest: computeSourceDigest(SOURCES),
    coverage: { criteria: ["S013/AC-REN-07"], states: ["default"] },
    files: files.map(([path, content]) => ({ path, sha256: digest(content) })),
    provider: null,
    access: "local_only",
    interaction_evidence: null,
    data_classification: "synthetic",
    ...overrides,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** A package at r1 whose catalogued files are really on disk. */
function workspace(): MemFs {
  const manifest = JSON.parse(fixture("manifest-maximal.json")) as DesignManifest;
  const first = manifest.baselines[0];
  if (first === undefined) throw new Error("el fixture no trae baselines");
  manifest.baselines = [first];
  manifest.current_baseline = { revision: 1, path: first.path, digest: first.digest };
  manifest.governance.revocations = [];
  const review = manifest.governance.reviews[0];
  if (review !== undefined) review.target = "DES-001@r1";
  manifest.currentness = [];

  const fs = new MemFs();
  fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(manifest, null, 2));
  for (const key of ["flows", "screens", "rules", "tokens", "renditions"] as const) {
    for (const entry of manifest.catalog[key]) {
      fs.file(`${WS}/${PKG}/${entry.path}`, `contenido de ${entry.path}\n`);
    }
  }
  for (const asset of manifest.catalog.assets) {
    fs.file(`${WS}/${PKG}/${asset.path}`, `contenido de ${asset.path}\n`);
  }
  return fs;
}

const EXPORT_DIR = "renditions/VIS-002-r001-export-portable";

/** Publish one rendition plus its companion files over r1. */
async function publish(
  fs: MemFs,
  files: Array<{ path: string; content: string }>,
  dataAuthorization?: string,
): ReturnType<typeof publishDesignRevision> {
  return publishDesignRevision(fs, WS, {
    packageId: "DES-001",
    files,
    published: "2026-08-03",
    expectedBase: "DES-001@r1",
    ...(dataAuthorization === undefined ? {} : { dataAuthorization }),
  });
}

describe("F5 · la garantía offline es un error de validación, no una advertencia", () => {
  it("un export que no sale del package pasa", () => {
    expect(checkOfflineHtml(OFFLINE_HTML, "preview.html")).toEqual([]);
  });

  // El xmlns de un SVG inline es un IDENTIFICADOR de namespace: nadie lo resuelve
  // por red. Tratarlo como recurso remoto rechazaría justo el formato que la
  // preview estática recomienda.
  it("el xmlns de un SVG inline no es un recurso remoto", () => {
    const html =
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"/>';
    expect(checkOfflineHtml(html, "preview.html")).toEqual([]);
  });

  it.each([
    ['<script src="https://cdn.example.com/app.js"></script>', "un script remoto"],
    ['<link rel="stylesheet" href="https://cdn.example.com/a.css">', "una hoja de estilos remota"],
    ['<img src="http://example.com/logo.png">', "una imagen remota"],
    ["<style>@import url(https://fonts.example.com/f.css);</style>", "una fuente remota"],
    ['<style>@font-face{src:url("//fonts.example.com/f.woff2")}</style>', "una URL sin esquema"],
    ['<iframe src="https://example.com/proto"></iframe>', "un iframe remoto"],
    ["<script>fetch('/api/miembros')</script>", "una llamada en tiempo de visualización"],
    ["<script>new WebSocket('wss://example.com')</script>", "un socket"],
  ])("%s se rechaza (%s)", (html) => {
    const failures = checkOfflineHtml(html, "preview.html");
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.code === "DESIGN_REMOTE_RESOURCE")).toBe(true);
    expect(failures.every((f) => f.action.length > 0)).toBe(true);
  });

  it("nombra el recurso ofensor para que se pueda buscar en el archivo", () => {
    const failures = checkOfflineHtml('<img src="https://example.com/a.png">', "preview.html");
    expect(failures[0]?.message).toContain("https://example.com/a.png");
  });
});

describe("F5 · el export portable vive dentro del package y queda sellado por su rendition", () => {
  it("publica la rendition html y su preview local", async () => {
    const fs = workspace();
    const result = await publish(fs, [
      {
        path: `${EXPORT_DIR}/rendition.json`,
        content: rendition({}, [["preview.html", OFFLINE_HTML]]),
      },
      { path: `${EXPORT_DIR}/preview.html`, content: OFFLINE_HTML },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.failures));

    expect(result.value.written).toContain(`${PKG}/${EXPORT_DIR}/preview.html`);
    // La preview NO se cataloga: su autoridad es el documento de la rendition, y un
    // baseline solo puede sellar paths que el catálogo nombra.
    const manifest = JSON.parse(
      await fs.readText(`${WS}/${PKG}/design-manifest.json`),
    ) as DesignManifest;
    expect(manifest.catalog.renditions.map((e) => e.path)).toContain(
      `${EXPORT_DIR}/rendition.json`,
    );
    expect(JSON.stringify(manifest.catalog)).not.toContain("preview.html");
  });

  it("un export con un recurso remoto no se publica", async () => {
    const remote = OFFLINE_HTML.replace('src="logo.svg"', 'src="https://cdn.example.com/logo.svg"');
    const result = await publish(workspace(), [
      { path: `${EXPORT_DIR}/rendition.json`, content: rendition({}, [["preview.html", remote]]) },
      { path: `${EXPORT_DIR}/preview.html`, content: remote },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_REMOTE_RESOURCE");
  });

  it("una rendition que declara un archivo que no está no se publica", async () => {
    const result = await publish(workspace(), [
      {
        path: `${EXPORT_DIR}/rendition.json`,
        content: rendition({}, [["preview.html", OFFLINE_HTML]]),
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_EVIDENCE_INSUFFICIENT");
  });

  // El eslabón que hace que el sello llegue hasta la preview: el baseline sella el
  // rendition.json, y el rendition.json sella los bytes del archivo.
  it("una preview que no son los bytes que su rendition declara no se publica", async () => {
    const result = await publish(workspace(), [
      {
        path: `${EXPORT_DIR}/rendition.json`,
        content: rendition({}, [["preview.html", OFFLINE_HTML]]),
      },
      { path: `${EXPORT_DIR}/preview.html`, content: `${OFFLINE_HTML}<!-- editado después -->` },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_DIGEST_MISMATCH");
  });

  // Un storyboard guarda sus cuadros en una subcarpeta propia. Pertenecen porque su
  // rendition los DECLARA, no porque compartan carpeta con el rendition.json.
  it("un archivo declarado en una subcarpeta de la rendition sí se publica", async () => {
    const frame = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>\n';
    const result = await publish(workspace(), [
      {
        path: `${EXPORT_DIR}/rendition.json`,
        content: rendition({}, [
          ["preview.html", OFFLINE_HTML],
          ["frames/paso-1.svg", frame],
        ]),
      },
      { path: `${EXPORT_DIR}/preview.html`, content: OFFLINE_HTML },
      { path: `${EXPORT_DIR}/frames/paso-1.svg`, content: frame },
    ]);
    expect(result.ok, JSON.stringify("failures" in result ? result.failures : [])).toBe(true);
  });

  it("un archivo suelto dentro de renditions/ que ninguna rendition declara no se publica", async () => {
    const result = await publish(workspace(), [
      {
        path: `${EXPORT_DIR}/rendition.json`,
        content: rendition({}, [["preview.html", OFFLINE_HTML]]),
      },
      { path: `${EXPORT_DIR}/preview.html`, content: OFFLINE_HTML },
      { path: `${EXPORT_DIR}/notas.txt`, content: "una nota que nadie sella\n" },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.some((f) => f.artifact.endsWith("notas.txt"))).toBe(true);
  });
});

describe("F5 · los datos sintéticos son el default y el material real se autoriza", () => {
  it("una rendition que declara material real sin autorización no se publica", async () => {
    const doc = rendition({ data_classification: "real" }, [["preview.html", OFFLINE_HTML]]);
    const result = await publish(workspace(), [
      { path: `${EXPORT_DIR}/rendition.json`, content: doc },
      { path: `${EXPORT_DIR}/preview.html`, content: OFFLINE_HTML },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_DATA_UNAUTHORIZED");
  });

  it("con la autorización declarada, sí", async () => {
    const doc = rendition({ data_classification: "real" }, [["preview.html", OFFLINE_HTML]]);
    const result = await publish(
      workspace(),
      [
        { path: `${EXPORT_DIR}/rendition.json`, content: doc },
        { path: `${EXPORT_DIR}/preview.html`, content: OFFLINE_HTML },
      ],
      "la familia autorizó el padrón real para la revisión de accesibilidad",
    );
    expect(result.ok, JSON.stringify("failures" in result ? result.failures : [])).toBe(true);
  });

  it("un bundle de material real sin autorización no llega a leer el package", async () => {
    const fs = workspace();
    const cut = await cutRenderBundle(fs, WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-001@r1"],
      adapter: PORTABLE_HTML,
      dataClassification: "real",
      generated: "2026-08-03",
    });
    expect(cut.ok).toBe(false);
    if (cut.ok) return;
    expect(cut.failures.map((f) => f.code)).toEqual(["DESIGN_DATA_UNAUTHORIZED"]);
    // Y no baja la clasificación para que la operación pase: eso sería peor que
    // negarse, porque el material seguiría siendo real y nadie lo sabría.
    expect(cut.failures[0]?.action).toContain("sintéticos");
  });
});

describe("F5 · el camino local funciona sin proveedor, cuenta ni red", () => {
  it("leer, validar y publicar el package no necesita ningún adapter registrado", async () => {
    const empty: AdapterRegistry = {};
    const required = requireAdapter("figma", empty, "render-bundle.json");
    expect(required.ok).toBe(false);
    if (!required.ok) expect(required.failure.action).toContain("no necesita ninguno");

    const fs = workspace();
    const index = await readDesignIndex(fs, WS);
    expect(index.packages.map((p) => p.id)).toContain("DES-001");
    expect(index.packages.every((p) => p.ok)).toBe(true);

    const result = await publish(fs, [
      {
        path: `${EXPORT_DIR}/rendition.json`,
        content: rendition({}, [["preview.html", OFFLINE_HTML]]),
      },
      { path: `${EXPORT_DIR}/preview.html`, content: OFFLINE_HTML },
    ]);
    expect(result.ok).toBe(true);
  });

  // T5.5: el link se cae, la evidencia no. Una rendition de acceso privado y con
  // el proveedor divergido sigue siendo válida y sigue conservando su archivo.
  it("un link privado o divergido no borra la preview local ni impide leer el package", async () => {
    const doc = rendition(
      {
        provider: {
          name: "figma",
          locator: { file_key: "abc123DEF456", node_id: "12:345" },
          version: "2026-01-01T00:00:00Z",
          sync: "diverged",
        },
        access: "private",
      },
      [["preview.html", OFFLINE_HTML]],
    );
    const validation = validateDesignRendition(JSON.parse(doc), `${EXPORT_DIR}/rendition.json`);
    expect(validation.failures).toEqual([]);
    expect(validation.value?.files.map((f) => f.path)).toEqual(["preview.html"]);

    const fs = workspace();
    const result = await publish(fs, [
      { path: `${EXPORT_DIR}/rendition.json`, content: doc },
      { path: `${EXPORT_DIR}/preview.html`, content: OFFLINE_HTML },
    ]);
    expect(result.ok, JSON.stringify("failures" in result ? result.failures : [])).toBe(true);
    expect(await fs.readText(`${WS}/${PKG}/${EXPORT_DIR}/preview.html`)).toBe(OFFLINE_HTML);
  });

  it("el perfil portable declara sus tres capacidades y ninguna más", () => {
    expect(PORTABLE_HTML.capabilities).toEqual({
      handoff: true,
      record: true,
      snapshot: true,
      generate: false,
      push: false,
      pull: false,
      compare: false,
    });
    expect(PORTABLE_HTML.network).toBe("never");
  });
});

describe("F5 · el HTML es intercambio, no fuente semántica", () => {
  // T5.2: un HTML interactivo aporta interacción y NO reemplaza la preview estática
  // que el gate exige. Una screen puramente estática no necesita ninguno.
  it("un export html no alcanza para la preview estática del estado base", () => {
    const parsed = validateDesignArtifact(
      fixture("SCR-001-r002-formulario-alta.md"),
      "screen",
      "screens/SCR-001-r002-formulario-alta.md",
    );
    if (!parsed.ok || parsed.value === null) throw new Error("el fixture de screen no validó");
    const screen = parsed.value as ScreenArtifact;

    const html = validateDesignRendition(
      JSON.parse(
        rendition(
          {
            id: "DES-001/VIS-001",
            coverage: { criteria: ["S046/AC-02"], states: ["default", "error"] },
          },
          [["preview.html", OFFLINE_HTML]],
        ),
      ),
      "renditions/VIS-001-r001-formulario-alta/rendition.json",
    ).value;
    if (html === null) throw new Error("la rendition html no validó");

    const failures = crossVisualEvidence(
      [
        {
          id: "VIS-001",
          revision: 1,
          path: "renditions/VIS-001-r001-formulario-alta/rendition.json",
          supersedes: null,
        },
      ],
      screen,
      "screens/SCR-001-r002-formulario-alta.md",
      () => html,
    );
    expect(failures.map((f) => f.code)).toContain("DESIGN_VISUAL_EVIDENCE_REQUIRED");
    expect(failures.some((f) => f.message.includes("preview estática"))).toBe(true);
  });
});
