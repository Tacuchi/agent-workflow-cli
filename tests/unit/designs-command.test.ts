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
