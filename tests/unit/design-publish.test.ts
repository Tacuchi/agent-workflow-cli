import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publishDesignRevision } from "../../src/application/design/design-publish-service.js";
import { validateDesignBaseline } from "../../src/domain/design/baseline.js";
import { validateDesignManifest } from "../../src/domain/design/manifest.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";
import {
  checkProjection,
  renderDesignMd,
  renderPackageMd,
} from "../../src/domain/design/projections.js";
import type { DirEntry } from "../../src/ports/file-system.js";
import { MemFs } from "../helpers/mem-fs.js";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const WS = "/ws";
const PKG = "docs/designs/001-design-alta";

/** A package with one published revision and its files really on disk. */
function workspace(): MemFs {
  const manifest = JSON.parse(fixture("manifest-maximal.json")) as Record<string, unknown>;
  // Empezamos desde r1 para que la publicación bajo prueba sea la r2.
  const baselines = manifest.baselines as Array<Record<string, unknown>>;
  manifest.baselines = [baselines[0]];
  manifest.current_baseline = {
    revision: 1,
    path: "baselines/DES-001-r001.json",
    digest: (baselines[0] as Record<string, unknown>).digest,
  };
  (manifest.governance as { revocations: unknown[] }).revocations = [];
  const reviews = (manifest.governance as { reviews: Array<Record<string, unknown>> }).reviews;
  (reviews[0] as Record<string, unknown>).target = "DES-001@r1";
  const catalog = manifest.catalog as Record<string, Array<Record<string, unknown>>>;
  catalog.flows = [(catalog.flows as Array<Record<string, unknown>>)[0] as Record<string, unknown>];
  manifest.currentness = [];

  const fs = new MemFs();
  fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(manifest, null, 2));
  for (const path of [
    "flows/FLW-001-r001-alta-miembro.md",
    "screens/SCR-001-r001-formulario-alta.md",
    "design-system/rules/RUL-001-r001-densidad.md",
    "tokens/TOK-001-r001-base.tokens.json",
    "renditions/VIS-001-r001-formulario-alta/rendition.json",
    `assets/${"5".repeat(64)}-logo.svg`,
  ]) {
    fs.file(`${WS}/${PKG}/${path}`, `contenido de ${path}\n`);
  }
  return fs;
}

// Un documento REAL: la publicación valida lo que sella, así que un cuerpo de
// mentira no llega al baseline.
const NEW_FLOW = {
  path: "flows/FLW-001-r002-alta-miembro.md",
  content: fixture("FLW-001-r002-alta-miembro.md"),
};

/**
 * The tree as it stands: every file WITH its content, and every directory.
 * Comparing only files would miss an empty folder left by a rolled-back write —
 * and under `docs/designs/` a stray folder reads as a package with no manifest.
 */
async function snapshot(fs: MemFs): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    let entries: DirEntry[];
    try {
      entries = await fs.list(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.type === "dir") {
        out[`${entry.path}/`] = "<dir>";
        await walk(entry.path);
      } else {
        out[entry.path] = await fs.readText(entry.path);
      }
    }
  };
  await walk(`${WS}/${PKG}`);
  return out;
}

describe("publishDesignRevision — la publicación completa", () => {
  it("escribe el artefacto, el baseline, el manifest y las dos proyecciones", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);

    expect(result.value.revision).toBe(2);
    expect(result.value.written).toEqual([
      `${PKG}/flows/FLW-001-r002-alta-miembro.md`,
      `${PKG}/baselines/DES-001-r002.json`,
      `${PKG}/PACKAGE.md`,
      `${PKG}/design-system/DESIGN.md`,
      // El manifest ÚLTIMO: es el interruptor.
      `${PKG}/design-manifest.json`,
    ]);
  });

  it("y todo lo escrito valida contra su propio contrato", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);

    const manifest = validateDesignManifest(
      JSON.parse(await fs.readText(`${WS}/${PKG}/design-manifest.json`)),
    );
    expect(manifest.failures).toEqual([]);
    const baseline = validateDesignBaseline(
      JSON.parse(await fs.readText(`${WS}/${PKG}/baselines/DES-001-r002.json`)),
      "baselines/DES-001-r002.json",
    );
    expect(baseline.failures).toEqual([]);
    expect(baseline.value?.parent_baseline).toBe("DES-001@r1");
  });

  it("el baseline sella el sha256 de los BYTES que hay en disco", async () => {
    const fs = workspace();
    await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    const baseline = validateDesignBaseline(
      JSON.parse(await fs.readText(`${WS}/${PKG}/baselines/DES-001-r002.json`)),
      "x",
    ).value;

    const sealed = baseline?.selection.find((s) => s.path === NEW_FLOW.path);
    const { createHash } = await import("node:crypto");
    const expected = `sha256:${createHash("sha256").update(NEW_FLOW.content).digest("hex")}`;
    expect(sealed?.sha256).toBe(expected);

    // Y sella la revisión VIGENTE de cada artefacto, no la vieja.
    expect(baseline?.selection.map((s) => s.path)).toContain("flows/FLW-001-r002-alta-miembro.md");
    expect(baseline?.selection.map((s) => s.path)).not.toContain(
      "flows/FLW-001-r001-alta-miembro.md",
    );
  });
});

describe("publishDesignRevision — o no ocurre", () => {
  // La validación de fase: interrumpir a mitad y comprobar que el árbol queda
  // EXACTAMENTE como estaba. El fallo se fuerza en la última escritura, que es
  // el peor momento posible: ya hay cuatro archivos puestos.
  it("una escritura que falla a mitad deja el árbol idéntico", async () => {
    const fs = workspace();
    const antes = await snapshot(fs);

    const original = fs.writeText.bind(fs);
    let writes = 0;
    fs.writeText = async (path: string, content: string): Promise<void> => {
      writes += 1;
      if (path.endsWith("DESIGN.md")) throw new Error("disco lleno");
      return original(path, content);
    };

    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    expect(result.ok).toBe(false);
    expect(writes).toBeGreaterThan(1); // llegó lejos antes de fallar

    fs.writeText = original;
    expect(await snapshot(fs)).toEqual(antes);
  });

  // El compare-and-swap protege a quien PREPARÓ contra una base y aplica después,
  // y no es opcional: declarar la base es parte de pedir la publicación.
  it("rechaza aplicar lo preparado si la línea se movió, y no escribe nada", async () => {
    const fs = workspace();
    const antes = await snapshot(fs);

    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: null, // preparó cuando el package no tenía nada publicado
    });
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failures[0]?.code).toBe("DESIGN_BASE_STALE");
    expect(result.failures[0]?.message).toContain("la vigente es DES-001@r1");
    expect(result.failures[0]?.action).toContain("publicó mientras preparabas");
    expect(await snapshot(fs)).toEqual(antes);
  });

  it("y lo acepta cuando la base es la que se esperaba", async () => {
    const result = await publishDesignRevision(workspace(), WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    expect(result.ok).toBe(true);
  });

  it("no pisa una revisión ya escrita: el archivo se crea en exclusiva", async () => {
    const fs = workspace();
    fs.file(`${WS}/${PKG}/flows/FLW-001-r002-alta-miembro.md`, "otro contenido");
    const antes = await snapshot(fs);

    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo");
    // El diagnóstico se dice en términos del dominio: sobrescribir una revisión
    // publicada no es una salida legal, así que no se ofrece.
    expect(result.failures[0]?.code).toBe("DESIGN_BASE_STALE");
    expect(result.failures[0]?.artifact).toContain("flows/FLW-001-r002-alta-miembro.md");
    expect(result.failures[0]?.action).not.toContain("sobrescritura");
    expect(await snapshot(fs)).toEqual(antes);
  });

  it("rechaza sellar un archivo que el catálogo promete y no está", async () => {
    const fs = workspace();
    await fs.remove(`${WS}/${PKG}/tokens/TOK-001-r001-base.tokens.json`);
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failures[0]?.code).toBe("DESIGN_REFERENCE_FILE_MISSING");
  });

  it("rechaza publicar un archivo que no es un artefacto normativo", async () => {
    const result = await publishDesignRevision(workspace(), WS, {
      packageId: "DES-001",
      files: [{ path: "notas/borrador.md", content: "x" }],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failures[0]?.message).toContain("carpeta de artefactos normativos");
  });
});

describe("las proyecciones se comprueban contra el manifest", () => {
  it("la publicación las deja coincidiendo", async () => {
    const fs = workspace();
    await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    const manifest = validateDesignManifest(
      JSON.parse(await fs.readText(`${WS}/${PKG}/design-manifest.json`)),
    ).value as DesignManifest;

    for (const path of ["PACKAGE.md", "design-system/DESIGN.md"]) {
      const actual = await fs.readText(`${WS}/${PKG}/${path}`);
      expect(checkProjection(path, actual, manifest), path).toEqual([]);
    }
  });

  it("una proyección vieja se reporta nombrando la revisión de la que vino", async () => {
    const fs = workspace();
    await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    const manifest = validateDesignManifest(
      JSON.parse(await fs.readText(`${WS}/${PKG}/design-manifest.json`)),
    ).value as DesignManifest;

    const vieja = renderPackageMd({
      ...manifest,
      current_baseline: { revision: 1, path: "x", digest: "y" },
    });
    const failure = checkProjection("PACKAGE.md", vieja, manifest)[0];
    expect(failure?.code).toBe("DESIGN_PROJECTION_STALE");
    expect(failure?.message).toContain("DES-001@r1");
    expect(failure?.action).toContain("no una fuente");
  });

  // Una proyección no puede AFIRMAR nada normativo: si lo hiciera, sería una
  // segunda fuente de verdad para un hecho que ya tiene dueño.
  it("no repiten contenido normativo: solo identidades y ubicaciones", async () => {
    const fs = workspace();
    await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    const manifest = validateDesignManifest(
      JSON.parse(await fs.readText(`${WS}/${PKG}/design-manifest.json`)),
    ).value as DesignManifest;

    for (const rendered of [renderPackageMd(manifest), renderDesignMd(manifest)]) {
      expect(rendered).not.toContain(NEW_FLOW.content.trim());
      expect(rendered).toContain("regenerable");
      expect(rendered).toContain("workline:projection source=DES-001@r2");
    }
  });
});

describe("el rollback devuelve el ÁRBOL, no solo los archivos", () => {
  // Una publicación que crea `renditions/` y falla dejaba la carpeta vacía. Bajo
  // `docs/designs/` eso no es inocuo: el descubrimiento la lee como un package
  // sin manifest, así que un fallo inventaba un package roto que nadie escribió.
  it("una carpeta que la publicación creó y luego falló no queda", async () => {
    const fs = workspace();
    await fs.remove(`${WS}/${PKG}/design-system/rules/RUL-001-r001-densidad.md`);
    await fs.remove(`${WS}/${PKG}/design-system`);

    // El manifest ya no puede catalogar la rule que borramos.
    const manifest = JSON.parse(await fs.readText(`${WS}/${PKG}/design-manifest.json`)) as Record<
      string,
      unknown
    >;
    (manifest.catalog as Record<string, unknown[]>).rules = [];
    await fs.writeText(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(manifest, null, 2));

    const antes = await snapshot(fs);
    expect(Object.keys(antes)).not.toContain(`${WS}/${PKG}/design-system/`);

    const original = fs.writeText.bind(fs);
    fs.writeText = async (path: string, content: string): Promise<void> => {
      if (path.endsWith("DESIGN.md")) throw new Error("disco lleno");
      return original(path, content);
    };
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    fs.writeText = original;

    expect(result.ok).toBe(false);
    expect(await snapshot(fs)).toEqual(antes);
  });
});

describe("la publicación valida lo que sella", () => {
  it("un documento que no cumple su propio contrato NO entra al baseline", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [{ path: NEW_FLOW.path, content: "---\nschema: workline.ui-flow/v1\n---\n\nx\n" }],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok)
      throw new Error("esperaba un fallo: sellar bytes inválidos es sellar una mentira");
    expect(await snapshot(fs)).toEqual(await snapshot(workspace()));
  });

  it("la identidad la manda el frontmatter, no el nombre del archivo", async () => {
    const result = await publishDesignRevision(workspace(), WS, {
      packageId: "DES-001",
      // El cuerpo declara FLW-001@r2; el nombre dice otra cosa.
      files: [{ path: "flows/FLW-009-r007-alta-miembro.md", content: NEW_FLOW.content }],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failures[0]?.code).toBe("DESIGN_AUTHORITY_CONFLICT");
    expect(result.failures[0]?.action).toContain("flows/FLW-001-r002-");
  });

  it("y rechaza publicar en un package que el documento no declara", async () => {
    const result = await publishDesignRevision(workspace(), WS, {
      packageId: "DES-001",
      files: [
        {
          path: NEW_FLOW.path,
          content: NEW_FLOW.content.replaceAll("DES-001/FLW-001", "DES-002/FLW-001"),
        },
      ],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failures[0]?.code).toBe("DESIGN_AUTHORITY_CONFLICT");
  });

  it("un asset solo se publica bajo el digest de su contenido", async () => {
    const rechazado = await publishDesignRevision(workspace(), WS, {
      packageId: "DES-001",
      files: [NEW_FLOW, { path: `assets/${"a".repeat(64)}-logo.svg`, content: "<svg/>" }],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (rechazado.ok) throw new Error("esperaba un fallo");
    expect(rechazado.failures[0]?.message).toContain("no es el digest de su contenido");

    const nombre = (rechazado.failures[0]?.action ?? "").match(/assets\/[0-9a-f]{64}-/)?.[0] ?? "";
    const fs = workspace();
    const aceptado = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW, { path: `${nombre}logo.svg`, content: "<svg/>" }],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!aceptado.ok) throw new Error(aceptado.failures[0]?.message);
    const manifest = JSON.parse(
      await fs.readText(`${WS}/${PKG}/design-manifest.json`),
    ) as DesignManifest;
    expect(manifest.catalog.assets.map((a) => a.path)).toContain(`${nombre}logo.svg`);
  });

  it("deriva currentness: la revisión anterior queda superseded", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);
    const manifest = JSON.parse(
      await fs.readText(`${WS}/${PKG}/design-manifest.json`),
    ) as DesignManifest;
    expect(manifest.currentness).toContainEqual({ ref: "DES-001/FLW-001@r1", state: "superseded" });
    expect(manifest.currentness).toContainEqual({ ref: "DES-001/FLW-001@r2", state: "current" });
    const revalidado = validateDesignManifest(manifest);
    if (!revalidado.ok) throw new Error(revalidado.failures.map((f) => f.message).join(" · "));
  });
});

describe("la estructura del package sigue al contenido", () => {
  it("PACKAGE.md localiza cada estado por su referencia completa", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);

    const page = await fs.readText(`${WS}/${PKG}/PACKAGE.md`);
    const manifest = JSON.parse(
      await fs.readText(`${WS}/${PKG}/design-manifest.json`),
    ) as DesignManifest;
    const screen = manifest.catalog.screens[0];
    if (screen === undefined) throw new Error("el fixture perdió su screen");
    expect(screen.states?.length ?? 0).toBeGreaterThan(0);
    for (const anchor of screen.states ?? []) {
      expect(page).toContain(`DES-001/${screen.id}@r${screen.revision}#${anchor}`);
      // Localizar no es repetir: el propósito del estado vive en el documento.
      expect(page).not.toContain("Formulario vacío");
    }
    expect(checkProjection("PACKAGE.md", page, manifest)).toEqual([]);
  });

  it("no inventa design-system/ en un package sin reglas ni tokens", async () => {
    const fs = workspace();
    const raw = JSON.parse(await fs.readText(`${WS}/${PKG}/design-manifest.json`)) as Record<
      string,
      unknown
    >;
    const catalog = raw.catalog as Record<string, unknown[]>;
    catalog.rules = [];
    catalog.tokens = [];
    fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(raw, null, 2));

    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);
    expect(result.value.written.some((p) => p.includes("design-system/"))).toBe(false);
  });
});

describe("una escritura que falla A MITAD tampoco deja residuo", () => {
  it("el destino se registra ANTES de escribirlo, así que el rollback lo alcanza", async () => {
    const fs = workspace();
    const antes = await snapshot(fs);
    // El adapter real abre con 'wx' y escribe DESPUÉS: el archivo existe antes
    // que su contenido. Reproducimos ese medio camino.
    const exclusive = fs.writeTextExclusive.bind(fs);
    fs.writeTextExclusive = async (path: string, content: string) => {
      if (path.endsWith("DES-001-r002.json")) {
        fs.file(path, ""); // creado, vacío
        throw new Error("ENOSPC: no space left on device");
      }
      return exclusive(path, content);
    };

    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo");
    expect(await snapshot(fs)).toEqual(antes);
  });
});

describe("validar el candidato COMPLETO antes del primer byte", () => {
  it("un candidato inválido no escribe absolutamente nada", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "no-es-una-fecha", // solo la validación del candidato lo caza
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo");
    // La aserción que importa es la AUSENCIA de escrituras, no el fallo.
    expect([...fs.writes.keys()]).toEqual([]);
  });

  it("y el baseline se crea en exclusiva: quien llega segundo pierde la carrera", async () => {
    const fs = workspace();
    // Otro proceso publicó la r2 mientras preparábamos: su baseline ya está.
    fs.file(`${WS}/${PKG}/baselines/DES-001-r002.json`, "{}");
    const antes = await snapshot(fs);

    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba perder la carrera");
    expect(result.failures[0]?.code).toBe("DESIGN_BASE_STALE");
    expect(result.failures[0]?.artifact).toContain("baselines/DES-001-r002.json");
    expect(await snapshot(fs)).toEqual(antes);
  });
});

describe("las reglas del catálogo, una por una", () => {
  const manifestOf = async (fs: MemFs): Promise<DesignManifest> =>
    JSON.parse(await fs.readText(`${WS}/${PKG}/design-manifest.json`)) as DesignManifest;

  it("la revisión nueva SUPERSEDE a la anterior del mismo artefacto", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);
    const flows = (await manifestOf(fs)).catalog.flows;
    expect(flows.find((f) => f.revision === 2)?.supersedes).toBe("DES-001/FLW-001@r1");
    // Y la primera de su línea no supersede a nadie.
    expect(flows.find((f) => f.revision === 1)?.supersedes).toBe(null);
  });

  it("la madurez sale del documento, no de un default de la publicación", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [
        {
          path: NEW_FLOW.path,
          content: NEW_FLOW.content.replace("maturity: handoff", "maturity: outline"),
        },
      ],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);
    const flows = (await manifestOf(fs)).catalog.flows;
    expect(flows.find((f) => f.revision === 2)?.maturity).toBe("outline");
  });

  it("una revisión ya catalogada no se re-publica", async () => {
    const fs = workspace();
    const r1 = fixture("FLW-001-r002-alta-miembro.md")
      .replace("revision: 2", "revision: 1")
      .replace("supersedes: DES-001/FLW-001@r1", "supersedes: null");
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [{ path: "flows/FLW-001-r001-alta-miembro.md", content: r1 }],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo: la r1 ya está catalogada");
    expect(result.failures[0]?.code).toBe("DESIGN_ID_DUPLICATE");
  });

  it("la primera publicación de un package sin baseline arranca en r1", async () => {
    const fs = workspace();
    const raw = JSON.parse(await fs.readText(`${WS}/${PKG}/design-manifest.json`)) as Record<
      string,
      unknown
    >;
    raw.baselines = [];
    raw.current_baseline = null;
    (raw.catalog as Record<string, unknown[]>).flows = [];
    (raw.governance as { reviews: unknown[] }).reviews = [];
    raw.currentness = [];
    fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(raw, null, 2));
    await fs.remove(`${WS}/${PKG}/flows/FLW-001-r001-alta-miembro.md`);

    const primera = fixture("FLW-001-r002-alta-miembro.md")
      .replace("revision: 2", "revision: 1")
      .replace("supersedes: DES-001/FLW-001@r1", "supersedes: null");
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [{ path: "flows/FLW-001-r001-alta-miembro.md", content: primera }],
      published: "2026-08-02",
      expectedBase: null,
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);
    expect(result.value.revision).toBe(1);
    expect(result.value.baseline.parent_baseline).toBe(null);
  });

  it("la selección sella el package ENTERO, no solo lo que cambió", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);
    const manifest = await manifestOf(fs);
    const sellado = new Set(result.value.baseline.selection.map((s) => s.path));
    for (const key of ["flows", "screens", "rules", "tokens", "renditions"] as const) {
      for (const entry of manifest.catalog[key]) {
        const vigente = manifest.catalog[key]
          .filter((e) => e.id === entry.id)
          .reduce((max, e) => Math.max(max, e.revision), 0);
        if (entry.revision === vigente) expect(sellado).toContain(entry.path);
      }
    }
    for (const asset of manifest.catalog.assets) expect(sellado).toContain(asset.path);
  });

  it("un package roto se NOMBRA; no se lee como inexistente", async () => {
    const fs = workspace();
    // JSON válido que NO valida: la identidad declarada sobrevive, y por eso el
    // diagnóstico puede nombrar el package en vez de negar que exista.
    const roto = JSON.parse(fixture("manifest-maximal.json")) as Record<string, unknown>;
    roto.created = "ayer";
    fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(roto, null, 2));
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo");
    expect(result.failures[0]?.code).not.toBe("DESIGN_REFERENCE_MISSING");
    expect(result.failures[0]?.artifact).toContain("design-manifest.json");
  });
});

describe("checkProjection no da falsos verdes ni falsos rojos", () => {
  it("un checkout con CRLF no vuelve stale una proyección correcta", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);
    const manifest = JSON.parse(
      await fs.readText(`${WS}/${PKG}/design-manifest.json`),
    ) as DesignManifest;
    const page = await fs.readText(`${WS}/${PKG}/PACKAGE.md`);
    expect(checkProjection("PACKAGE.md", page.replaceAll("\n", "\r\n"), manifest)).toEqual([]);
  });

  it("y se niega a comprobar un path que no es una proyección", () => {
    const manifest = JSON.parse(fixture("manifest-maximal.json")) as DesignManifest;
    const failures = checkProjection("README.md", "lo que sea", manifest);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]?.artifact).toBe("README.md");
  });
});

describe("un asset binario se sella por sus BYTES", () => {
  it("y no por una decodificación con pérdida a texto", async () => {
    const fs = workspace();
    // Bytes que no son UTF-8 válido: leerlos como texto los corrompe.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const asset = `assets/${"5".repeat(64)}-logo.svg`;
    fs.binary(`${WS}/${PKG}/${asset}`, png);

    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);

    const sellado = result.value.baseline.selection.find((s) => s.path === asset);
    const esperado = createHash("sha256").update(png).digest("hex");
    expect(sellado?.sha256).toBe(`sha256:${esperado}`);
    // Y es DISTINTO del digest de su decodificación: ese es el defecto que el
    // puerto `readBytes` existe para impedir.
    const perdida = createHash("sha256")
      .update(new TextEncoder().encode(new TextDecoder().decode(png)))
      .digest("hex");
    expect(esperado).not.toBe(perdida);
  });
});

describe("nada se escribe fuera del package", () => {
  const HEX = createHash("sha256").update("<svg/>").digest("hex");

  it("un asset con travesía se rechaza aunque su digest ya esté catalogado", async () => {
    const fs = workspace();
    const antes = await snapshot(fs);
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [
        NEW_FLOW,
        { path: `assets/${HEX}-logo.svg`, content: "<svg/>" },
        { path: `assets/${HEX}-x/../../../../../../evil.svg`, content: "<svg/>" },
      ],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo: eso escribe fuera del workspace");
    expect(result.failures[0]?.code).toBe("DESIGN_PATH_UNSAFE");
    expect(await fs.exists("/evil.svg")).toBe(false);
    expect(await snapshot(fs)).toEqual(antes);
  });

  it("y un gemelo del mismo contenido no se escribe sin catalogarse", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [
        NEW_FLOW,
        { path: `assets/${HEX}-logo.svg`, content: "<svg/>" },
        { path: `assets/${HEX}-logo-duplicado.svg`, content: "<svg/>" },
      ],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo: sellaría bytes que no declara");
    expect(result.failures[0]?.code).toBe("DESIGN_ID_DUPLICATE");
    expect(await fs.exists(`${WS}/${PKG}/assets/${HEX}-logo-duplicado.svg`)).toBe(false);
  });
});

describe("el frontmatter manda también en supersedes", () => {
  it("el catálogo publica lo que el documento declara, no lo que deduce", async () => {
    const fs = workspace();
    // El catálogo ya llega hasta r3, así que deducir daría @r3.
    const raw = JSON.parse(await fs.readText(`${WS}/${PKG}/design-manifest.json`)) as Record<
      string,
      unknown
    >;
    const flows = (raw.catalog as Record<string, Array<Record<string, unknown>>>).flows;
    flows.push({
      id: "FLW-001",
      revision: 3,
      path: "flows/FLW-001-r003-alta-miembro.md",
      supersedes: "DES-001/FLW-001@r1",
      maturity: "handoff",
    });
    fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(raw, null, 2));
    fs.file(`${WS}/${PKG}/flows/FLW-001-r003-alta-miembro.md`, "contenido r3\n");

    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [
        {
          path: "flows/FLW-001-r005-alta-miembro.md",
          // El documento supersede la r1, no la r3.
          content: NEW_FLOW.content.replace("revision: 2", "revision: 5"),
        },
      ],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);
    const manifest = JSON.parse(
      await fs.readText(`${WS}/${PKG}/design-manifest.json`),
    ) as DesignManifest;
    expect(manifest.catalog.flows.find((f) => f.revision === 5)?.supersedes).toBe(
      "DES-001/FLW-001@r1",
    );
  });

  it("y un documento que declara no superseder a nadie tampoco se corrige solo", async () => {
    const fs = workspace();
    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [
        {
          path: "flows/FLW-009-r001-alta-paralela.md",
          content: NEW_FLOW.content
            .replace("id: DES-001/FLW-001", "id: DES-001/FLW-009")
            .replace("revision: 2", "revision: 1")
            .replace("supersedes: DES-001/FLW-001@r1", "supersedes: null"),
        },
      ],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (!result.ok) throw new Error(result.failures[0]?.message);
    const manifest = JSON.parse(
      await fs.readText(`${WS}/${PKG}/design-manifest.json`),
    ) as DesignManifest;
    expect(manifest.catalog.flows.find((f) => f.id === "FLW-009")?.supersedes).toBe(null);
  });
});

describe("un archivo ilegible no se sobrescribe ni se trunca", () => {
  it("la publicación falla antes de tocarlo", async () => {
    const fs = workspace();
    fs.file(`${WS}/${PKG}/PACKAGE.md`, "la landing anterior");
    const antes = await snapshot(fs);
    const readText = fs.readText.bind(fs);
    fs.readText = async (path: string) => {
      if (path.endsWith("PACKAGE.md")) throw new Error("EACCES: permission denied");
      return readText(path);
    };

    const result = await publishDesignRevision(fs, WS, {
      packageId: "DES-001",
      files: [NEW_FLOW],
      published: "2026-08-02",
      expectedBase: "DES-001@r1",
    });
    if (result.ok) throw new Error("esperaba un fallo");
    fs.readText = readText;
    expect(await snapshot(fs)).toEqual(antes);
  });
});
