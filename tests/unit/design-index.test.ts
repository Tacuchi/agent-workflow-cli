import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  readDesignIndex,
  resolveDesignPackage,
} from "../../src/application/design/design-index-service.js";
import { MemFs } from "../helpers/mem-fs.js";

const MAXIMAL = readFileSync(
  fileURLToPath(new URL("../fixtures/design/manifest-maximal.json", import.meta.url)),
  "utf8",
);

const WS = "/ws";

/** A package on disk: the folder name is deliberately free — identity is inside. */
function withPackage(fs: MemFs, folder: string, manifest: string): MemFs {
  return fs.file(`${WS}/docs/designs/${folder}/design-manifest.json`, manifest);
}

function reid(id: string, folder = id): string {
  return MAXIMAL.replaceAll("DES-001", id).replaceAll("001-design-alta", folder);
}

describe("readDesignIndex — descubrimiento bajo docs/designs/", () => {
  it("devuelve un índice vacío cuando la taxonomía todavía no nació", async () => {
    const index = await readDesignIndex(new MemFs({ lenient: true }), WS);
    expect(index.packages).toEqual([]);
    expect(index.failures).toEqual([]);
    expect(index.root).toBe("docs/designs");
  });

  it("lista identidad, baseline vigente y ubicación actual", async () => {
    const fs = withPackage(new MemFs(), "001-design-alta-miembros", MAXIMAL);
    const index = await readDesignIndex(fs, WS);

    expect(index.packages).toHaveLength(1);
    const pkg = index.packages[0] as NonNullable<(typeof index.packages)[0]>;
    expect(pkg.id).toBe("DES-001");
    expect(pkg.title).toBe("Alta y baja de miembros");
    expect(pkg.current_baseline?.revision).toBe(2);
    expect(pkg.path).toBe("docs/designs/001-design-alta-miembros");
    expect(pkg.ok).toBe(true);
  });

  it("ordena por identidad, no por carpeta", async () => {
    let fs = withPackage(new MemFs(), "900-design-z", reid("DES-002"));
    fs = withPackage(fs, "010-design-a", reid("DES-003"));
    const index = await readDesignIndex(fs, WS);
    expect(index.packages.map((p) => p.id)).toEqual(["DES-002", "DES-003"]);
  });
});

describe("readDesignIndex — la identidad sobrevive al rename y al movimiento", () => {
  it("resuelve por DES-NNN después de renombrar la carpeta en disco", async () => {
    const before = await readDesignIndex(withPackage(new MemFs(), "001-design-alta", MAXIMAL), WS);
    expect(resolveDesignPackage(before, "DES-001")?.path).toBe("docs/designs/001-design-alta");

    // El mismo package, misma identidad, carpeta renombrada y renumerada.
    const after = await readDesignIndex(
      withPackage(new MemFs(), "042-design-altas-y-bajas", MAXIMAL),
      WS,
    );
    const found = resolveDesignPackage(after, "DES-001");
    expect(found?.id).toBe("DES-001");
    expect(found?.path).toBe("docs/designs/042-design-altas-y-bajas");
    expect(found?.current_baseline?.digest).toBe(`sha256:${"2".repeat(64)}`);
  });

  it("no resuelve una identidad inexistente", async () => {
    const index = await readDesignIndex(withPackage(new MemFs(), "001-design-alta", MAXIMAL), WS);
    expect(resolveDesignPackage(index, "DES-999")).toBeNull();
  });
});

describe("readDesignIndex — diagnósticos", () => {
  it("reporta una identidad reclamada por dos packages, nombrando ambos", async () => {
    let fs = withPackage(new MemFs(), "001-design-alta", MAXIMAL);
    fs = withPackage(fs, "002-design-copia", MAXIMAL);
    const index = await readDesignIndex(fs, WS);

    expect(index.failures).toHaveLength(1);
    const failure = index.failures[0] as NonNullable<(typeof index.failures)[0]>;
    expect(failure.code).toBe("DESIGN_ID_DUPLICATE");
    expect(failure.artifact).toContain("001-design-alta");
    expect(failure.artifact).toContain("002-design-copia");
    expect(failure.action.length).toBeGreaterThan(0);
  });

  it("reporta una carpeta bajo docs/designs/ que no es un package", async () => {
    const fs = new MemFs().dir(`${WS}/docs/designs/borradores`);
    const index = await readDesignIndex(fs, WS);
    const failure = index.packages[0]?.failures[0];
    expect(failure?.code).toBe("DESIGN_MANIFEST_MISSING");
    expect(failure?.artifact).toBe("docs/designs/borradores/design-manifest.json");
    expect(index.packages[0]?.ok).toBe(false);
  });

  it("reporta un manifest ilegible sin tumbar el resto del índice", async () => {
    let fs = withPackage(new MemFs(), "001-design-roto", "{ esto no es json");
    fs = withPackage(fs, "002-design-sano", reid("DES-002"));
    const index = await readDesignIndex(fs, WS);

    const broken = index.packages.find((p) => p.path.endsWith("001-design-roto"));
    expect(broken?.failures[0]?.code).toBe("DESIGN_MANIFEST_UNREADABLE");
    expect(resolveDesignPackage(index, "DES-002")?.ok).toBe(true);
  });

  it("un manifest inválido deja el package sin identidad resoluble", async () => {
    const fs = withPackage(
      new MemFs(),
      "001-design-invalido",
      MAXIMAL.replace(
        '"schema": "workline.design-manifest/v1"',
        '"schema": "workline.design-manifest/v9"',
      ),
    );
    const index = await readDesignIndex(fs, WS);
    expect(index.packages[0]?.id).toBeNull();
    expect(index.packages[0]?.failures[0]?.code).toBe("DESIGN_SCHEMA_UNKNOWN");
    expect(resolveDesignPackage(index, "DES-001")).toBeNull();
  });
});

describe("readDesignIndex — la frontera del workspace", () => {
  // Un symlink bajo docs/designs/ traería un manifest —y una identidad— desde
  // fuera del workspace. `list` no sigue enlaces, así que la entrada no es `dir`
  // y el descubrimiento la ignora. Con FS real: es la única forma de probarlo.
  it("no descubre un package alcanzado por symlink", async () => {
    const root = mkdtempSync(join(tmpdir(), "aw-designs-"));
    try {
      const outside = join(root, "afuera", "001-design-ajeno");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "design-manifest.json"), MAXIMAL);
      const designs = join(root, "ws", "docs", "designs");
      mkdirSync(designs, { recursive: true });
      symlinkSync(outside, join(designs, "001-design-link"), "dir");

      const index = await readDesignIndex(new NodeFileSystem(), join(root, "ws"));
      expect(index.packages).toEqual([]);
      expect(resolveDesignPackage(index, "DES-001")).toBeNull();

      // Control: el mismo contenido, en una carpeta de verdad, SÍ se descubre.
      // Sin esto, el vacío de arriba podría venir de un path mal armado.
      rmSync(join(designs, "001-design-link"));
      mkdirSync(join(designs, "001-design-real"));
      writeFileSync(join(designs, "001-design-real", "design-manifest.json"), MAXIMAL);
      const control = await readDesignIndex(new NodeFileSystem(), join(root, "ws"));
      expect(resolveDesignPackage(control, "DES-001")?.path).toBe("docs/designs/001-design-real");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
