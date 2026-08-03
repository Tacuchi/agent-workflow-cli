import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cutRenderBundle } from "../../src/application/design/design-bundle-service.js";
import type { AdapterProfile } from "../../src/domain/design/adapter.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";
import {
  canonicalRenderBundle,
  computeRenderBundleDigest,
  contentTypeOf,
  validateRenderBundle,
} from "../../src/domain/design/render-bundle.js";
import { MemFs } from "../helpers/mem-fs.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const WS = "/ws";
const PKG = "docs/designs/001-design-alta";

/**
 * A package whose SCR-001@r2 is the real fixture document, so the closure walks a
 * document that actually validates and the bundle seals the bytes of one.
 */
function workspace(): MemFs {
  const manifest = JSON.parse(fixture("manifest-maximal.json")) as DesignManifest;
  manifest.catalog.screens = [
    {
      id: "SCR-001",
      revision: 2,
      path: "screens/SCR-001-r002-formulario-alta.md",
      supersedes: null,
      maturity: "handoff",
      states: ["default", "error"],
    },
  ];
  manifest.catalog.flows = [];
  manifest.currentness = [];

  const fs = new MemFs();
  fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(manifest, null, 2));
  fs.file(
    `${WS}/${PKG}/screens/SCR-001-r002-formulario-alta.md`,
    fixture("SCR-001-r002-formulario-alta.md"),
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

/** A profile that hands over and records, and cannot do anything else. */
const PORTABLE: AdapterProfile = {
  id: "portable-html",
  title: "HTML portable",
  version: 1,
  capabilities: {
    handoff: true,
    record: true,
    snapshot: true,
    generate: false,
    push: false,
    pull: false,
    compare: false,
  },
  losses: [{ subject: "medium:motion", why: "una preview estática no representa animaciones" }],
  network: "never",
};

/** The tree as it stands, file by file — the evidence that reading changed nothing. */
async function snapshot(fs: MemFs, dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await fs.list(dir)) {
    if (entry.type === "dir") Object.assign(out, await snapshot(fs, entry.path));
    else out[entry.path] = await fs.readText(entry.path);
  }
  return out;
}

describe("F1 · el Render Context Bundle v1 es determinista", () => {
  // La prueba de fase, literal: dos cortes equivalentes, mismo manifest canónico
  // byte a byte. Las raíces van en orden distinto a propósito — una selección es
  // un conjunto, y si el orden en que se tipeó sobreviviera al digest, el mismo
  // pedido daría dos bundles.
  it("dos cortes del mismo baseline, selección y perfil producen el mismo manifest canónico", async () => {
    const roots = ["DES-001/SCR-001@r2#default", "DES-001/RUL-001@r1"];
    const first = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots,
      adapter: PORTABLE,
      generated: "2026-08-03",
    });
    const second = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots: [...roots].reverse(),
      adapter: PORTABLE,
      generated: "2026-08-04",
    });

    expect(first.ok, JSON.stringify("failures" in first ? first.failures : [])).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(canonicalRenderBundle(second.value)).toBe(canonicalRenderBundle(first.value));
    expect(second.value.digest).toBe(first.value.digest);
    // Y la fecha, que es lo único fuera del sello, sí difiere: si `generated`
    // entrara al digest este test pasaría por comparar dos cosas idénticas.
    expect(second.value.generated).not.toBe(first.value.generated);
  });

  it("generar un bundle no toca ningún archivo del package", async () => {
    const fs = workspace();
    const before = await snapshot(fs, `${WS}/${PKG}`);
    const cut = await cutRenderBundle(fs, WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-001@r2"],
      adapter: PORTABLE,
      generated: "2026-08-03",
    });
    expect(cut.ok).toBe(true);
    expect(await snapshot(fs, `${WS}/${PKG}`)).toEqual(before);
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("la clausura llega ordenada, con content type y digest por archivo", async () => {
    const cut = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-001@r2#default"],
      adapter: PORTABLE,
      generated: "2026-08-03",
    });
    if (!cut.ok) throw new Error(JSON.stringify(cut.failures));

    const refs = cut.value.closure.map((m) => m.ref);
    expect(refs).toEqual([...refs].sort());
    // La screen arrastra su rule, su token y su asset: eso es la clausura del 012
    // consumida, no recalculada.
    expect(refs).toContain("DES-001/SCR-001@r2");
    expect(refs).toContain("DES-001/RUL-001@r1");
    expect(refs).toContain("DES-001/TOK-001@r1");
    expect(cut.value.assets.map((a) => a.digest)).toEqual([`sha256:${"5".repeat(64)}`]);

    const screen = cut.value.closure.find((m) => m.ref === "DES-001/SCR-001@r2");
    expect(screen?.content_type).toBe("text/markdown");
    expect(screen?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(screen?.states).toEqual(["default"]);
  });

  it("las obligaciones de accesibilidad viajan atribuidas a la revisión que las enuncia", async () => {
    const cut = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-001@r2"],
      adapter: PORTABLE,
      generated: "2026-08-03",
    });
    if (!cut.ok) throw new Error(JSON.stringify(cut.failures));
    expect(cut.value.accessibility.length).toBeGreaterThan(0);
    expect(cut.value.accessibility.every((o) => o.ref === "DES-001/SCR-001@r2")).toBe(true);
  });

  // T1.4: lo no representable se enumera. Un perfil que no sabe hacer `pull` lo
  // dice en el reporte, en vez de que el consumidor lo descubra intentándolo.
  it("el reporte de pérdidas enumera lo que el perfil no puede representar", async () => {
    const cut = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-001@r2"],
      adapter: PORTABLE,
      generated: "2026-08-03",
    });
    if (!cut.ok) throw new Error(JSON.stringify(cut.failures));
    const subjects = cut.value.losses.map((l) => l.subject);
    expect(subjects).toContain("capability:pull");
    expect(subjects).toContain("capability:generate");
    expect(subjects).toContain("medium:motion");
    // Las declaradas no se pierden entre las derivadas.
    expect(cut.value.losses.find((l) => l.subject === "medium:motion")?.why).toMatch(/animaciones/);
  });

  it("una selección que no resuelve falla nombrando la referencia, no produce un bundle a medias", async () => {
    const cut = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-099@r1"],
      adapter: PORTABLE,
      generated: "2026-08-03",
    });
    expect(cut.ok).toBe(false);
    if (cut.ok) return;
    expect(cut.failures.some((f) => f.artifact.includes("SCR-099"))).toBe(true);
    expect(cut.failures.every((f) => f.action.length > 0)).toBe(true);
  });

  it("el data_classification por defecto es sintético, no real", async () => {
    const cut = await cutRenderBundle(workspace(), WS, {
      packageId: "DES-001",
      roots: ["DES-001/SCR-001@r2"],
      adapter: PORTABLE,
      generated: "2026-08-03",
    });
    if (!cut.ok) throw new Error(JSON.stringify(cut.failures));
    expect(cut.value.data_classification).toBe("synthetic");
  });
});

describe("F1 · el bundle que vuelve de una herramienta se juzga entero", () => {
  const maximal = (): Record<string, unknown> =>
    JSON.parse(fixture("render-bundle-maximal.json")) as Record<string, unknown>;

  it("el fixture maximal valida y su sello coincide", () => {
    const result = validateRenderBundle(maximal(), "render-bundle.json");
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("un bundle recortado a mano se detecta por el digest", () => {
    const tampered = maximal();
    (tampered.closure as Array<Record<string, unknown>>).pop();
    const result = validateRenderBundle(tampered, "render-bundle.json");
    expect(result.ok).toBe(false);
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_DIGEST_MISMATCH");
  });

  // La frontera del determinismo, desde el otro lado: cambiar la fecha NO
  // invalida el sello, porque la fecha no es parte de lo que se seleccionó.
  it("cambiar 'generated' no invalida el sello", () => {
    const result = validateRenderBundle(
      { ...maximal(), generated: "2027-01-01" },
      "render-bundle.json",
    );
    expect(result.failures).toEqual([]);
  });

  it("un bundle con un path que se escapa del package se rechaza", () => {
    const escaping = maximal();
    const closure = escaping.closure as Array<Record<string, unknown>>;
    (closure[0] as Record<string, unknown>).path = "../../etc/passwd";
    const result = validateRenderBundle(escaping, "render-bundle.json");
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_PATH_UNSAFE");
  });

  it("un bundle que arrastra una credencial se rechaza antes de salir del workspace", () => {
    const leaking = maximal();
    leaking.losses = [{ subject: "auth", why: "figd_abcdefghijklmnopqrstuvwxyz012345678" }];
    const result = validateRenderBundle(leaking, "render-bundle.json");
    expect(result.failures.map((f) => f.code)).toContain("DESIGN_SECRET_PRESENT");
  });

  it("un digest recalculado sobre el mismo contenido es el mismo", () => {
    const bundle = validateRenderBundle(maximal(), "render-bundle.json").value;
    if (bundle === null) throw new Error("el fixture maximal no validó");
    expect(computeRenderBundleDigest(bundle)).toBe(bundle.digest);
  });
});

describe("F1 · el content type se declara, no se adivina", () => {
  it.each([
    ["screens/SCR-001-r001-x.md", "text/markdown"],
    ["tokens/TOK-001-r001-base.tokens.json", "application/json"],
    ["renditions/VIS-001-r001-x/preview.svg", "image/svg+xml"],
    ["renditions/VIS-001-r001-x/preview.pdf", "application/pdf"],
    ["assets/deadbeef-logo.bin", "application/octet-stream"],
  ])("%s → %s", (path, expected) => {
    expect(contentTypeOf(path)).toBe(expected);
  });
});
