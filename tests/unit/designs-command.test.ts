import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { designsCommand } from "../../src/cli/commands/designs.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

const MANIFEST = readFileSync(
  fileURLToPath(new URL("../fixtures/design/manifest-maximal.json", import.meta.url)),
  "utf8",
);

const WS = "/ws";

function context(fs: MemFs): CliContext {
  const env = new FakeEnv("/home/u", WS);
  return { fs, env, paths: new PathsService("workflow", "/home/u", WS) } as unknown as CliContext;
}

function workspace(folder = "001-design-alta"): MemFs {
  return new MemFs().file(`${WS}/docs/designs/${folder}/design-manifest.json`, MANIFEST);
}

async function run(fs: MemFs, argv: string[]) {
  return designsCommand.execute(parseArgv(["designs", ...argv]), context(fs));
}

describe("aw designs — el listado", () => {
  it("proyecta el manifest afuera: un catálogo no es un listado", async () => {
    const result = await run(workspace(), []);
    const data = result.data as { packages: Array<{ id: string; manifest: unknown }> };
    expect(result.ok).toBe(true);
    expect(data.packages).toHaveLength(1);
    expect(data.packages[0]?.id).toBe("DES-001");
    expect(data.packages[0]?.manifest).toBeNull();
  });

  it("la proyección humana muestra identidad, baseline y ubicación actual", async () => {
    const result = await run(workspace("042-design-altas-y-bajas"), []);
    const text = designsCommand.renderHuman?.(result, { detail: false }) ?? "";
    expect(text).toContain("DES-001");
    expect(text).toContain("@r2");
    expect(text).toContain("docs/designs/042-design-altas-y-bajas");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("un workspace sin packages lo dice, no devuelve vacío", async () => {
    const text =
      designsCommand.renderHuman?.(await run(new MemFs({ lenient: true }), []), {
        detail: false,
      }) ?? "";
    expect(text).toContain("Sin packages de diseño");
  });

  it("solo con --detail se imprime el diagnóstico de un package roto", async () => {
    const fs = new MemFs().file(
      `${WS}/docs/designs/003-design-roto/design-manifest.json`,
      "{ roto",
    );
    const result = await run(fs, []);
    const compacto = designsCommand.renderHuman?.(result, { detail: false }) ?? "";
    const detallado = designsCommand.renderHuman?.(result, { detail: true }) ?? "";
    expect(compacto).toContain("1 package(s) sin validar");
    expect(compacto).not.toContain("DESIGN_MANIFEST_UNREADABLE");
    expect(detallado).toContain("no se pudo leer el manifest");
    expect(detallado).not.toContain("corré con --detail");
  });
});

describe("aw designs --id — resolver por identidad", () => {
  it("resuelve el package aunque la carpeta se haya renombrado, y conserva el manifest", async () => {
    const result = await run(workspace("042-design-altas-y-bajas"), ["--id", "DES-001"]);
    const data = result.data as { package: { path: string; manifest: unknown } };
    expect(result.ok).toBe(true);
    expect(data.package.path).toBe("docs/designs/042-design-altas-y-bajas");
    expect(data.package.manifest).not.toBeNull();
  });

  it("una identidad inexistente falla con acción correctiva", async () => {
    const result = await run(workspace(), ["--id", "DES-999"]);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("DESIGN_PACKAGE_NOT_FOUND");
    expect((result.data as { action: string }).action).toContain("aw designs");
  });
});

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const PKG = "docs/designs/001-design-alta";

/** A whole package: manifest, and the current revisions passing their own gate. */
function healthy(): MemFs {
  return (
    new MemFs()
      .file(`${WS}/${PKG}/design-manifest.json`, MANIFEST)
      // La revisión SUPERADA es ilegible a propósito: el gate mira el estado
      // actual del catálogo, no la historia ya sellada.
      .file(`${WS}/${PKG}/flows/FLW-001-r001-alta-miembro.md`, "esto ya no es un documento\n")
      .file(
        `${WS}/${PKG}/flows/FLW-001-r002-alta-miembro.md`,
        fixture("FLW-001-r002-alta-miembro.md"),
      )
      .file(
        `${WS}/${PKG}/screens/SCR-001-r001-formulario-alta.md`,
        fixture("SCR-001-r002-formulario-alta.md"),
      )
      .file(
        `${WS}/${PKG}/renditions/VIS-001-r001-formulario-alta/rendition.json`,
        fixture("rendition-VIS-001-r001.json"),
      )
  );
}

/**
 * El escenario del reporte: manifest y baseline válidos, y debajo un flow que
 * viola el contrato (`trace` con claves de screen) y una screen 'handoff' con
 * criterio visual sin evidencia.
 */
function brokenContent(): MemFs {
  const flow = fixture("FLW-001-r002-alta-miembro.md").replace(
    "    source: docs/specs/046-spec-nacimiento-familias.md",
    "    source: docs/specs/046-spec-nacimiento-familias.md\n    classification: visual",
  );
  const screen = fixture("SCR-001-r002-formulario-alta.md").replace(
    "    renditions: [DES-001/VIS-001@r1]",
    "    renditions: []",
  );
  return healthy()
    .file(`${WS}/${PKG}/flows/FLW-001-r002-alta-miembro.md`, flow)
    .file(`${WS}/${PKG}/screens/SCR-001-r001-formulario-alta.md`, screen);
}

describe("aw designs — el gate de contenido sobre lo ya publicado", () => {
  it("--id siempre lo corre: el package roto sale ok:false con los hallazgos reales", async () => {
    const result = await run(brokenContent(), ["--id", "DES-001"]);
    const data = result.data as {
      package: { ok: boolean; failures: Array<{ code: string }> };
    };
    expect(result.ok).toBe(true);
    expect(data.package.ok).toBe(false);
    const codes = data.package.failures.map((f) => f.code);
    expect(codes).toContain("DESIGN_KEY_UNKNOWN");
    expect(codes).toContain("DESIGN_MATURITY_INCOMPLETE");
  });

  it("el listado sin --deep se mantiene barato: el mismo package sale ok:true", async () => {
    const result = await run(brokenContent(), []);
    const data = result.data as { packages: Array<{ ok: boolean; failures: unknown[] }> };
    expect(data.packages[0]?.ok).toBe(true);
    expect(data.packages[0]?.failures).toEqual([]);
  });

  it("el listado con --deep corre el gate por package y lo marca", async () => {
    const result = await run(brokenContent(), ["--deep"]);
    const data = result.data as {
      packages: Array<{ ok: boolean; failures: Array<{ code: string }> }>;
    };
    expect(data.packages[0]?.ok).toBe(false);
    expect(data.packages[0]?.failures.map((f) => f.code)).toContain("DESIGN_KEY_UNKNOWN");
  });

  it("y con --detail ese listado imprime el diagnóstico del gate", async () => {
    const result = await run(brokenContent(), ["--deep"]);
    const text = designsCommand.renderHuman?.(result, { detail: true }) ?? "";
    expect(text).toContain("no admite la clave 'classification'");
  });

  it("un archivo vigente que falta en disco se reporta, no crashea", async () => {
    const fs = healthy();
    await fs.remove(`${WS}/${PKG}/screens/SCR-001-r001-formulario-alta.md`);
    const result = await run(fs, ["--id", "DES-001"]);
    const data = result.data as {
      package: { ok: boolean; failures: Array<{ code: string; artifact: string }> };
    };
    expect(data.package.ok).toBe(false);
    const missing = data.package.failures.find((f) => f.code === "DESIGN_REFERENCE_FILE_MISSING");
    expect(missing?.artifact).toBe(`${PKG}/screens/SCR-001-r001-formulario-alta.md`);
  });

  it("un package sano sigue ok:true — y la revisión superada no se rejuzga", async () => {
    const byId = await run(healthy(), ["--id", "DES-001"]);
    const detail = byId.data as { package: { ok: boolean; failures: unknown[] } };
    expect(detail.package.ok).toBe(true);
    expect(detail.package.failures).toEqual([]);

    const deep = await run(healthy(), ["--deep"]);
    const listing = deep.data as { packages: Array<{ ok: boolean; failures: unknown[] }> };
    expect(listing.packages[0]?.ok).toBe(true);
    expect(listing.packages[0]?.failures).toEqual([]);
  });
});
