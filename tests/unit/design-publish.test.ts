import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import "../../src/application/capability/design-handler.js";
import {
  type DispatchContext,
  type DispatchResult,
  dispatchCapability,
} from "../../src/application/capability/dispatcher.js";
import { localDateIso } from "../../src/application/dates.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import { designsCommand } from "../../src/cli/commands/designs.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { CapabilityInputValue } from "../../src/domain/capability/protocol.js";
import { validateDesignBaseline } from "../../src/domain/design/baseline.js";
import { validateDesignManifest } from "../../src/domain/design/manifest.js";
import type { DesignManifest } from "../../src/domain/design/manifest.js";
import {
  checkProjection,
  renderDesignMd,
  renderPackageMd,
} from "../../src/domain/design/projections.js";
import { baseDigest } from "../../src/domain/proposal.js";
import type { DirEntry } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { packageCandidate } from "../helpers/design-package.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * The sealing of a package revision, on the code that really runs it.
 *
 * Until plan 030 this suite drove `publishDesignRevision`, a second publication
 * path with no production caller: it located the package, ran its own
 * compare-and-swap and wrote straight through `publishArtifacts`, skipping the
 * preview and the approval every other durable effect goes through. Its ~30
 * cases were therefore the bulk of the design coverage AND aimed at code nobody
 * executed. They live on here, split by what each one really asks:
 *
 * - what the revision SEALS is `buildPackageCandidate`, the one implementation
 *   of the seal, driven exactly as `packageProposal` drives it;
 * - what a publication WRITES is the live route end to end — dispatch
 *   `validate`, then `apply` — because that is the only thing that writes.
 */

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/design/${name}`, import.meta.url)), "utf8");

const WS = "/ws";
const HOME = "/home/u";
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

/** The candidate of this package's next revision, as the live route builds it. */
function candidate(
  fs: MemFs,
  files: Array<{ path: string; content: string }> = [NEW_FLOW],
  published?: string,
): ReturnType<typeof packageCandidate> {
  return packageCandidate(fs, WS, {
    packagePath: PKG,
    files,
    ...(published === undefined ? {} : { published }),
  });
}

/** Workspace-relative paths of everything the candidate would publish, in order. */
async function wouldWrite(fs: MemFs, files?: Array<{ path: string; content: string }>) {
  const built = await candidate(fs, files);
  if (!built.ok) throw new Error(built.failures[0]?.message);
  return built.value;
}

/**
 * The tree as it stands: every file WITH its content, and every directory.
 * Comparing only files would miss an empty folder left by a rolled-back write —
 * and under `docs/designs/` a stray folder reads as a package with no manifest.
 */
async function snapshot(fs: MemFs, root = `${WS}/${PKG}`): Promise<Record<string, string>> {
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
  await walk(root);
  return out;
}

describe("el candidato de una revisión — lo que la publicación va a sellar", () => {
  it("lleva el artefacto, el baseline, el manifest y las dos proyecciones", async () => {
    const built = await wouldWrite(workspace());

    expect(built.revision).toBe(2);
    expect(built.artifacts.map((a) => a.path)).toEqual([
      `${PKG}/flows/FLW-001-r002-alta-miembro.md`,
      `${PKG}/baselines/DES-001-r002.json`,
      `${PKG}/PACKAGE.md`,
      `${PKG}/design-system/DESIGN.md`,
      // El manifest ÚLTIMO: es el interruptor.
      `${PKG}/design-manifest.json`,
    ]);
    // Una revisión no se sobrescribe; el índice y las proyecciones sí.
    const overwrite = new Map(built.artifacts.map((a) => [a.path, a.overwrite]));
    expect(overwrite.get(`${PKG}/flows/FLW-001-r002-alta-miembro.md`)).toBe(false);
    expect(overwrite.get(`${PKG}/baselines/DES-001-r002.json`)).toBe(false);
    expect(overwrite.get(`${PKG}/design-manifest.json`)).toBe(true);
  });

  it("y todo lo que lleva valida contra su propio contrato", async () => {
    const built = await wouldWrite(workspace());
    const at = (path: string): string =>
      built.artifacts.find((a) => a.path === `${PKG}/${path}`)?.content ?? "";

    const manifest = validateDesignManifest(JSON.parse(at("design-manifest.json")));
    expect(manifest.failures).toEqual([]);
    const baseline = validateDesignBaseline(
      JSON.parse(at("baselines/DES-001-r002.json")),
      "baselines/DES-001-r002.json",
    );
    expect(baseline.failures).toEqual([]);
    expect(baseline.value?.parent_baseline).toBe("DES-001@r1");
  });

  it("el baseline sella el sha256 de los BYTES que hay en disco", async () => {
    const built = await wouldWrite(workspace());

    const sealed = built.baseline.selection.find((s) => s.path === NEW_FLOW.path);
    const expected = `sha256:${createHash("sha256").update(NEW_FLOW.content).digest("hex")}`;
    expect(sealed?.sha256).toBe(expected);

    // Y sella la revisión VIGENTE de cada artefacto, no la vieja.
    expect(built.baseline.selection.map((s) => s.path)).toContain(
      "flows/FLW-001-r002-alta-miembro.md",
    );
    expect(built.baseline.selection.map((s) => s.path)).not.toContain(
      "flows/FLW-001-r001-alta-miembro.md",
    );
  });

  it("no pisa una revisión ya escrita: el archivo se crea en exclusiva", async () => {
    const fs = workspace();
    fs.file(`${WS}/${PKG}/flows/FLW-001-r002-alta-miembro.md`, "otro contenido");

    const built = await candidate(fs);
    if (built.ok) throw new Error("esperaba un fallo");
    // El diagnóstico se dice en términos del dominio: sobrescribir una revisión
    // publicada no es una salida legal, así que no se ofrece.
    expect(built.failures[0]?.code).toBe("DESIGN_BASE_STALE");
    expect(built.failures[0]?.artifact).toContain("flows/FLW-001-r002-alta-miembro.md");
    expect(built.failures[0]?.action).not.toContain("sobrescritura");
  });

  it("y el baseline también: quien llega segundo pierde la carrera", async () => {
    const fs = workspace();
    // Otro proceso publicó la r2 mientras preparábamos: su baseline ya está.
    fs.file(`${WS}/${PKG}/baselines/DES-001-r002.json`, "{}");

    const built = await candidate(fs);
    if (built.ok) throw new Error("esperaba perder la carrera");
    expect(built.failures[0]?.code).toBe("DESIGN_BASE_STALE");
    expect(built.failures[0]?.artifact).toContain("baselines/DES-001-r002.json");
    // La capa genérica ofrecería «confirmá la sobrescritura»: acá es ilegal.
    expect(built.failures[0]?.action).not.toContain("sobrescritura");
  });

  it("rechaza sellar un archivo que el catálogo promete y no está", async () => {
    const fs = workspace();
    await fs.remove(`${WS}/${PKG}/tokens/TOK-001-r001-base.tokens.json`);
    const built = await candidate(fs);
    if (built.ok) throw new Error("esperaba un fallo");
    expect(built.failures[0]?.code).toBe("DESIGN_REFERENCE_FILE_MISSING");
  });

  it("rechaza publicar un archivo que no es un artefacto normativo", async () => {
    const built = await candidate(workspace(), [{ path: "notas/borrador.md", content: "x" }]);
    if (built.ok) throw new Error("esperaba un fallo");
    expect(built.failures[0]?.message).toContain("carpeta de artefactos normativos");
  });

  it("un candidato inválido no toca el disco ni para preguntar", async () => {
    const fs = workspace();
    // Solo la validación del candidato caza una fecha que no lo es.
    const built = await candidate(fs, [NEW_FLOW], "no-es-una-fecha");
    if (built.ok) throw new Error("esperaba un fallo");
    // La aserción que importa es la AUSENCIA de escrituras, no el fallo.
    expect([...fs.writes.keys()]).toEqual([]);
  });
});

describe("las proyecciones se comprueban contra el manifest", () => {
  it("el candidato las deja coincidiendo", async () => {
    const built = await wouldWrite(workspace());
    const manifest = built.manifest;

    for (const path of ["PACKAGE.md", "design-system/DESIGN.md"]) {
      const actual = built.artifacts.find((a) => a.path === `${PKG}/${path}`)?.content ?? "";
      expect(checkProjection(path, actual, manifest), path).toEqual([]);
    }
  });

  it("una proyección vieja se reporta nombrando la revisión de la que vino", async () => {
    const manifest = (await wouldWrite(workspace())).manifest;

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
    const manifest = (await wouldWrite(workspace())).manifest;

    for (const rendered of [renderPackageMd(manifest), renderDesignMd(manifest)]) {
      expect(rendered).not.toContain(NEW_FLOW.content.trim());
      expect(rendered).toContain("regenerable");
      expect(rendered).toContain("workline:projection source=DES-001@r2");
    }
  });

  it("un checkout con CRLF no vuelve stale una proyección correcta", async () => {
    const built = await wouldWrite(workspace());
    const page = built.artifacts.find((a) => a.path === `${PKG}/PACKAGE.md`)?.content ?? "";
    expect(checkProjection("PACKAGE.md", page.replaceAll("\n", "\r\n"), built.manifest)).toEqual(
      [],
    );
  });

  it("y checkProjection se niega a comprobar un path que no es una proyección", () => {
    const manifest = JSON.parse(fixture("manifest-maximal.json")) as DesignManifest;
    const failures = checkProjection("README.md", "lo que sea", manifest);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]?.artifact).toBe("README.md");
  });
});

describe("el candidato valida lo que sella", () => {
  it("un documento que no cumple su propio contrato NO entra al baseline", async () => {
    const built = await candidate(workspace(), [
      { path: NEW_FLOW.path, content: "---\nschema: workline.ui-flow/v1\n---\n\nx\n" },
    ]);
    if (built.ok)
      throw new Error("esperaba un fallo: sellar bytes inválidos es sellar una mentira");
  });

  it("la identidad la manda el frontmatter, no el nombre del archivo", async () => {
    // El cuerpo declara FLW-001@r2; el nombre dice otra cosa.
    const built = await candidate(workspace(), [
      { path: "flows/FLW-009-r007-alta-miembro.md", content: NEW_FLOW.content },
    ]);
    if (built.ok) throw new Error("esperaba un fallo");
    expect(built.failures[0]?.code).toBe("DESIGN_AUTHORITY_CONFLICT");
    expect(built.failures[0]?.action).toContain("flows/FLW-001-r002-");
  });

  it("y rechaza publicar en un package que el documento no declara", async () => {
    const built = await candidate(workspace(), [
      {
        path: NEW_FLOW.path,
        content: NEW_FLOW.content.replaceAll("DES-001/FLW-001", "DES-002/FLW-001"),
      },
    ]);
    if (built.ok) throw new Error("esperaba un fallo");
    expect(built.failures[0]?.code).toBe("DESIGN_AUTHORITY_CONFLICT");
  });

  it("un asset solo se publica bajo el digest de su contenido", async () => {
    const rechazado = await candidate(workspace(), [
      NEW_FLOW,
      { path: `assets/${"a".repeat(64)}-logo.svg`, content: "<svg/>" },
    ]);
    if (rechazado.ok) throw new Error("esperaba un fallo");
    expect(rechazado.failures[0]?.message).toContain("no es el digest de su contenido");

    const nombre = (rechazado.failures[0]?.action ?? "").match(/assets\/[0-9a-f]{64}-/)?.[0] ?? "";
    const aceptado = await wouldWrite(workspace(), [
      NEW_FLOW,
      { path: `${nombre}logo.svg`, content: "<svg/>" },
    ]);
    expect(aceptado.manifest.catalog.assets.map((a) => a.path)).toContain(`${nombre}logo.svg`);
  });

  it("deriva currentness: la revisión anterior queda superseded", async () => {
    const manifest = (await wouldWrite(workspace())).manifest;
    expect(manifest.currentness).toContainEqual({ ref: "DES-001/FLW-001@r1", state: "superseded" });
    expect(manifest.currentness).toContainEqual({ ref: "DES-001/FLW-001@r2", state: "current" });
    const revalidado = validateDesignManifest(JSON.parse(JSON.stringify(manifest)));
    if (!revalidado.ok) throw new Error(revalidado.failures.map((f) => f.message).join(" · "));
  });
});

describe("la estructura del package sigue al contenido", () => {
  it("PACKAGE.md localiza cada estado por su referencia completa", async () => {
    const built = await wouldWrite(workspace());
    const page = built.artifacts.find((a) => a.path === `${PKG}/PACKAGE.md`)?.content ?? "";

    const screen = built.manifest.catalog.screens[0];
    if (screen === undefined) throw new Error("el fixture perdió su screen");
    expect(screen.states?.length ?? 0).toBeGreaterThan(0);
    for (const anchor of screen.states ?? []) {
      expect(page).toContain(`DES-001/${screen.id}@r${screen.revision}#${anchor}`);
      // Localizar no es repetir: el propósito del estado vive en el documento.
      expect(page).not.toContain("Formulario vacío");
    }
    expect(checkProjection("PACKAGE.md", page, built.manifest)).toEqual([]);
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

    const built = await wouldWrite(fs);
    expect(built.artifacts.some((a) => a.path.includes("design-system/"))).toBe(false);
  });
});

describe("las reglas del catálogo, una por una", () => {
  it("la revisión nueva SUPERSEDE a la anterior del mismo artefacto", async () => {
    const flows = (await wouldWrite(workspace())).manifest.catalog.flows;
    expect(flows.find((f) => f.revision === 2)?.supersedes).toBe("DES-001/FLW-001@r1");
    // Y la primera de su línea no supersede a nadie.
    expect(flows.find((f) => f.revision === 1)?.supersedes).toBe(null);
  });

  it("la madurez sale del documento, no de un default de la publicación", async () => {
    const built = await wouldWrite(workspace(), [
      {
        path: NEW_FLOW.path,
        content: NEW_FLOW.content.replace("maturity: handoff", "maturity: outline"),
      },
    ]);
    expect(built.manifest.catalog.flows.find((f) => f.revision === 2)?.maturity).toBe("outline");
  });

  it("una revisión ya catalogada no se re-publica", async () => {
    const r1 = fixture("FLW-001-r002-alta-miembro.md")
      .replace("revision: 2", "revision: 1")
      .replace("supersedes: DES-001/FLW-001@r1", "supersedes: null");
    const built = await candidate(workspace(), [
      { path: "flows/FLW-001-r001-alta-miembro.md", content: r1 },
    ]);
    if (built.ok) throw new Error("esperaba un fallo: la r1 ya está catalogada");
    expect(built.failures[0]?.code).toBe("DESIGN_ID_DUPLICATE");
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
    const built = await wouldWrite(fs, [
      { path: "flows/FLW-001-r001-alta-miembro.md", content: primera },
    ]);
    expect(built.revision).toBe(1);
    expect(built.baseline.parent_baseline).toBe(null);
  });

  it("la selección sella el package ENTERO, no solo lo que cambió", async () => {
    const built = await wouldWrite(workspace());
    const manifest = built.manifest;
    const sellado = new Set(built.baseline.selection.map((s) => s.path));
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
});

describe("un asset binario se sella por sus BYTES", () => {
  it("y no por una decodificación con pérdida a texto", async () => {
    const fs = workspace();
    // Bytes que no son UTF-8 válido: leerlos como texto los corrompe.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
    const asset = `assets/${"5".repeat(64)}-logo.svg`;
    fs.binary(`${WS}/${PKG}/${asset}`, png);

    const built = await wouldWrite(fs);

    const sellado = built.baseline.selection.find((s) => s.path === asset);
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

describe("nada se sella fuera del package", () => {
  const HEX = createHash("sha256").update("<svg/>").digest("hex");

  it("un asset con travesía se rechaza aunque su digest ya esté catalogado", async () => {
    const fs = workspace();
    const antes = await snapshot(fs);
    const built = await candidate(fs, [
      NEW_FLOW,
      { path: `assets/${HEX}-logo.svg`, content: "<svg/>" },
      { path: `assets/${HEX}-x/../../../../../../evil.svg`, content: "<svg/>" },
    ]);
    if (built.ok) throw new Error("esperaba un fallo: eso escribe fuera del workspace");
    expect(built.failures[0]?.code).toBe("DESIGN_PATH_UNSAFE");
    expect(await fs.exists("/evil.svg")).toBe(false);
    expect(await snapshot(fs)).toEqual(antes);
  });

  it("y un gemelo del mismo contenido no se sella sin catalogarse", async () => {
    const built = await candidate(workspace(), [
      NEW_FLOW,
      { path: `assets/${HEX}-logo.svg`, content: "<svg/>" },
      { path: `assets/${HEX}-logo-duplicado.svg`, content: "<svg/>" },
    ]);
    if (built.ok) throw new Error("esperaba un fallo: sellaría bytes que no declara");
    expect(built.failures[0]?.code).toBe("DESIGN_ID_DUPLICATE");
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

    const built = await wouldWrite(fs, [
      {
        path: "flows/FLW-001-r005-alta-miembro.md",
        // El documento supersede la r1, no la r3.
        content: NEW_FLOW.content.replace("revision: 2", "revision: 5"),
      },
    ]);
    expect(built.manifest.catalog.flows.find((f) => f.revision === 5)?.supersedes).toBe(
      "DES-001/FLW-001@r1",
    );
  });

  it("y un documento que declara no superseder a nadie tampoco se corrige solo", async () => {
    const built = await wouldWrite(workspace(), [
      {
        path: "flows/FLW-009-r001-alta-paralela.md",
        content: NEW_FLOW.content
          .replace("id: DES-001/FLW-001", "id: DES-001/FLW-009")
          .replace("revision: 2", "revision: 1")
          .replace("supersedes: DES-001/FLW-001@r1", "supersedes: null"),
      },
    ]);
    expect(built.manifest.catalog.flows.find((f) => f.id === "FLW-009")?.supersedes).toBe(null);
  });
});

// ── La publicación: el único camino que escribe ──────────────────────────────

const EXPANSION = "design.independent-outcomes";

function ctx(fs: MemFs): DispatchContext {
  return {
    fs,
    env: new FakeEnv(HOME, WS),
    paths: new PathsService(normalizeNamespace("workflow"), HOME, WS),
    workspace: WS,
    host: "claude-code",
  };
}

const input = (name: string, value: unknown): CapabilityInputValue => ({
  name,
  value,
  provenance: { kind: "text", origin: "caller", seal: null, sensitivity: "public" },
});

function consumerInput(path: string, content: string, base: string): CapabilityInputValue {
  return {
    name: "consumer_document",
    value: content,
    provenance: {
      kind: "attachment",
      origin: path,
      seal: baseDigest(base),
      sensitivity: "public",
    },
  };
}

function consumerMarkdown(revision: number, digest: string): string {
  const padded = String(revision).padStart(3, "0");
  return [
    "# Plan 031 — consumidor atómico",
    "",
    "## Design references",
    "",
    `package: DES-001@r${revision}`,
    `baseline_hint: ${PKG}/baselines/DES-001-r${padded}.json`,
    `digest: ${digest}`,
    "",
    "## Tasks",
    "",
    "- [ ] T1.1 — Consumir la revisión publicada.",
  ].join("\n");
}

/** The `input_digest` an authored answer has to quote, recomputed from the inputs. */
function digestOfInputs(inputs: CapabilityInputValue[]): string {
  return semanticDigest(
    [...inputs]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((i) => ({ name: i.name, value: i.value })),
  );
}

async function dispatch(
  fs: MemFs,
  verb: "prepare" | "validate" | "apply",
  operation: string,
  inputs: CapabilityInputValue[],
  extra: Record<string, unknown> = {},
): Promise<DispatchResult> {
  return dispatchCapability(
    { verb, capability: "design", operation, route: "direct", inputs, ...extra },
    ctx(fs),
  );
}

async function validateWith(
  fs: MemFs,
  operation: string,
  inputs: CapabilityInputValue[],
  artifacts: Array<{ path: string; content: string }>,
): Promise<DispatchResult> {
  return dispatch(fs, "validate", operation, inputs, {
    answer: JSON.stringify({
      version: 1,
      operation: `design.${operation}`,
      input_digest: digestOfInputs(inputs),
      state: "proposed",
      artifacts,
    }),
  });
}

async function applyValidated(
  fs: MemFs,
  validated: DispatchResult,
  operation: string,
): Promise<DispatchResult> {
  if (!validated.ok) throw new Error("validate falló antes de apply");
  const plan = validated.attempt.plan;
  if (plan === null) throw new Error("validate no produjo plan");
  return dispatchCapability(
    {
      verb: "apply",
      capability: "design",
      operation,
      route: "direct",
      request: validated.attempt.request,
      plan,
      approval: { digest: plan.proposal.digest, granted: plan.proposal.requires_approval },
    },
    ctx(fs),
  );
}

const updateInputs = (base: string): CapabilityInputValue[] => [
  input("package", "DES-001"),
  input("base", base),
  input("expansion", EXPANSION),
];

/** Publish this package's r2 through the live route, and hand back the outcome. */
async function publishR2(
  fs: MemFs,
  files: Array<{ path: string; content: string }> = [NEW_FLOW],
): Promise<DispatchResult> {
  const inputs = updateInputs("DES-001@r1");
  const validated = await validateWith(
    fs,
    "update",
    inputs,
    files.map((f) => ({ path: `${PKG}/${f.path}`, content: f.content })),
  );
  return applyValidated(fs, validated, "update");
}

/** `aw designs` over the tree a publication left, as a person would run it. */
async function listDesigns(fs: MemFs, argv: string[] = []) {
  const cliContext = {
    fs,
    env: new FakeEnv(HOME, WS),
    paths: new PathsService(normalizeNamespace("workflow"), HOME, WS),
  } as unknown as CliContext;
  return designsCommand.execute(parseArgv(["designs", ...argv]), cliContext);
}

/** The package `create` mints over an empty index, and its folder from the title. */
const NEW_PKG = "docs/designs/001-design-alta-de-miembro";

const createInputs = (maturity?: string): CapabilityInputValue[] => [
  input("title", "Alta de miembro"),
  input("sources", ["docs/requisitos.md"]),
  input("expansion", EXPANSION),
  ...(maturity === undefined ? [] : [input("maturity", maturity)]),
];

/** The fixture renumbered to r1, superseding nobody — a package's first line. */
const FLOW_R1 = fixture("FLW-001-r002-alta-miembro.md")
  .replace("revision: 2", "revision: 1")
  .replace("supersedes: DES-001/FLW-001@r1", "supersedes: null");

/**
 * A screen still in `outline`: publishable next to a `handoff` flow, and the
 * weakest current document of the package it lands in. The rendition citation
 * goes with the maturity — an `outline` owes no visual evidence, and keeping the
 * reference would leave a citation nothing in this package backs.
 */
const SCREEN_OUTLINE = fixture("SCR-002-r001-confirmacion.md")
  .replace("maturity: handoff", "maturity: outline")
  .replace("renditions: [DES-001/VIS-004@r1]", "renditions: []");

/** The receipt's own view of what the attempt attained. */
function receiptMaturity(result: DispatchResult): {
  attained: string | null;
  gaps: string[];
} {
  if (!result.ok) throw new Error("el intento falló antes de producir output");
  const value = result.attempt.output?.value as {
    design: { maturity: { attained: string | null } };
    gaps?: string[];
  };
  return { attained: value.design.maturity.attained, gaps: value.gaps ?? [] };
}

describe("publicar por la ruta de paquete: o el árbol queda legible, o no se escribe", () => {
  it("una revisión publicada deja el árbol que el listado acepta", async () => {
    const fs = new MemFs();
    const inputs = createInputs();
    const validated = await validateWith(fs, "create", inputs, [
      { path: `${NEW_PKG}/flows/FLW-001-r001-alta-miembro.md`, content: FLOW_R1 },
    ]);
    const applied = await applyValidated(fs, validated, "create");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("completed");

    // El criterio de F2: el propio CLI acepta después lo que la publicación dio
    // por bueno — y `--id` corre el gate de CONTENIDO, que es exactamente donde
    // la ruta verbatim dejaba un árbol que el listado rechazaba.
    const listed = await listDesigns(fs, ["--id", "DES-001"]);
    const entry = (
      listed.data as {
        package: { ok: boolean; failures: unknown[]; current_baseline: { revision: number } };
      }
    ).package;
    expect(listed.ok).toBe(true);
    expect(entry.ok, JSON.stringify(entry.failures)).toBe(true);
    expect(entry.current_baseline.revision).toBe(1);

    const baseline = validateDesignBaseline(
      JSON.parse(await fs.readText(`${WS}/${NEW_PKG}/baselines/DES-001-r001.json`)),
      "baselines/DES-001-r001.json",
    );
    expect(baseline.failures).toEqual([]);
    expect(baseline.value?.parent_baseline).toBe(null);
  });

  // El compare-and-swap protege a quien PREPARÓ contra una base y aplica después,
  // y no es opcional: declarar la base es parte de pedir la publicación.
  it("rechaza publicar si la línea se movió, antes incluso de pedir contenido", async () => {
    const fs = workspace();
    const antes = await snapshot(fs);

    const prepared = await dispatch(fs, "prepare", "update", updateInputs("null"));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.attempt.receipt.outcome).toBe("blocked");
    expect(prepared.attempt.receipt.error?.code).toBe("DESIGN_BASE_STALE");
    expect(prepared.attempt.receipt.error?.message).toContain("la vigente es DES-001@r1");
    expect(prepared.attempt.receipt.error?.action).toContain("una publicada no se reescribe");
    expect(await snapshot(fs)).toEqual(antes);
  });

  it("no adopta como base un manifest que cambió después del snapshot que derivó el candidato", async () => {
    const fs = workspace();
    const manifestPath = `${WS}/${PKG}/design-manifest.json`;
    const original = await fs.readText(manifestPath);
    const concurrent = JSON.stringify(
      {
        ...(JSON.parse(original) as Record<string, unknown>),
        title: "Alta cambiada por otro autor",
      },
      null,
      2,
    );

    // The index receives M1, then another writer lands M2 before the candidate
    // is built. The proposal must retain M1 as its CAS base and fail at apply;
    // re-reading only to make the base would silently overwrite M2 with M1's
    // derived candidate.
    const readText = fs.readText.bind(fs);
    let interleaved = false;
    fs.readText = async (path: string): Promise<string> => {
      const content = await readText(path);
      if (path === manifestPath && !interleaved) {
        interleaved = true;
        fs.file(manifestPath, concurrent);
      }
      return content;
    };

    const validated = await validateWith(fs, "update", updateInputs("DES-001@r1"), [
      { path: `${PKG}/${NEW_FLOW.path}`, content: NEW_FLOW.content },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.attempt.receipt.outcome).toBe("needs_input");

    const beforeApply = await snapshot(fs);
    const applied = await applyValidated(fs, validated, "update");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("blocked");
    expect(applied.attempt.receipt.error?.code).toBe("PROPOSAL_BASE_STALE");
    expect(await fs.readText(manifestPath)).toBe(concurrent);
    expect(await snapshot(fs)).toEqual(beforeApply);
  });

  it("un package ROTO se nombra; no se lee como inexistente", async () => {
    const fs = workspace();
    // JSON válido que NO valida: la identidad declarada sobrevive, y por eso el
    // diagnóstico puede nombrar el package en vez de negar que exista.
    const roto = JSON.parse(fixture("manifest-maximal.json")) as Record<string, unknown>;
    roto.created = "ayer";
    fs.file(`${WS}/${PKG}/design-manifest.json`, JSON.stringify(roto, null, 2));

    const prepared = await dispatch(fs, "prepare", "update", updateInputs("DES-001@r1"));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.attempt.receipt.error?.code).not.toBe("DESIGN_PACKAGE_NOT_FOUND");
    expect(prepared.attempt.receipt.error?.message).toContain("design-manifest.json");
  });

  it("y dos packages con la misma identidad frenan la publicación en vez de elegir uno", async () => {
    const fs = workspace();
    fs.file(
      `${WS}/docs/designs/002-design-copia/design-manifest.json`,
      await fs.readText(`${WS}/${PKG}/design-manifest.json`),
    );

    const prepared = await dispatch(fs, "prepare", "update", updateInputs("DES-001@r1"));
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.attempt.receipt.error?.code).toBe("DESIGN_REFERENCE_AMBIGUOUS");
    expect(prepared.attempt.receipt.error?.message).toContain("002-design-copia");
  });

  it("una publicación fuera de un workspace se rechaza al preparar, sin escribir", async () => {
    const fs = new MemFs();
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "update",
        route: "direct",
        target: "/tmp/mis-disenos",
        inputs: updateInputs("DES-001@r1"),
      },
      { ...ctx(fs), workspace: null },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.error?.code).toBe("DESIGN_WORKSPACE_ABSENT");
    expect(result.attempt.receipt.gaps, "no se publica un contrato incontestable").toEqual([]);
    expect([...fs.writes.keys()]).toEqual([]);
  });
});

/**
 * `render` and `record` write files no baseline selects — a projection derived
 * from the manifest, a decision ABOUT a revision. Minting nothing is their
 * nature, so the question is not whether they seal but whether the tree stays
 * readable and whether the receipt says what happened.
 */
describe("una publicación que no acuña revisión: publica adentro del package, y lo declara", () => {
  const recordInputs: CapabilityInputValue[] = [
    input("package", "DES-001"),
    input("revision", "r1"),
    input("decision", "approved"),
  ];

  /** The governance decision as a `record` answer: inside the package, never sealed. */
  const REVIEW = {
    path: `${NEW_PKG}/governance/reviews/REV-001.json`,
    content: `${JSON.stringify({ decision: "approved", target: "DES-001@r1" }, null, 2)}\n`,
  };

  /** A package published by the live route — sealed, gated and accepted by the listing. */
  async function published(): Promise<MemFs> {
    const fs = new MemFs();
    const validated = await validateWith(fs, "create", createInputs(), [
      { path: `${NEW_PKG}/flows/FLW-001-r001-alta-miembro.md`, content: FLOW_R1 },
    ]);
    await applyValidated(fs, validated, "create");
    return fs;
  }

  it("publica dentro del package indexado y el listado sigue aceptando el árbol", async () => {
    const fs = await published();
    const validated = await validateWith(fs, "record", recordInputs, [REVIEW]);
    const applied = await applyValidated(fs, validated, "record");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("completed");
    expect(await fs.readText(`${WS}/${REVIEW.path}`)).toBe(REVIEW.content);

    // El criterio de AC-02, sobre la operación que la revisión adversarial dejó
    // muerta: el propio CLI acepta después lo que la publicación dio por bueno.
    const listed = await listDesigns(fs, ["--id", "DES-001"]);
    const entry = (listed.data as { package: { ok: boolean; failures: unknown[] } }).package;
    expect(listed.ok).toBe(true);
    expect(entry.ok, JSON.stringify(entry.failures)).toBe(true);
  });

  // Lo que el recibo callaba: `baseline: null` sin nada más se lee igual que
  // «no consiguió sellar», y eso es lo contrario de lo que pasó.
  it("y el recibo declara que no acuñó revisión, nombrando por qué", async () => {
    const validated = await validateWith(await published(), "record", recordInputs, [REVIEW]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const design = (
      validated.attempt.output?.value as {
        design: { baseline: unknown; unsealed: string | null; package: string; path: string };
      }
    ).design;
    expect(design.baseline).toBe(null);
    expect(design.unsealed).toContain("no acuña");
    expect(design.package).toBe("DES-001");
    expect(design.path).toBe(NEW_PKG);
  });

  it("el contrato dice, antes de nada, que la respuesta no se va a sellar", async () => {
    const prepared = await dispatch(await published(), "prepare", "record", recordInputs);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.attempt.receipt.outcome).toBe("needs_input");
    expect(prepared.attempt.receipt.gaps.join(" ")).toContain("NO acuña una revisión");
    expect(prepared.attempt.receipt.gaps.join(" ")).toContain(NEW_PKG);
  });

  // Lo único que estas operaciones SÍ pueden romper: sellar el package a mano.
  it("rechaza autorar el manifest o un baseline, que es lo que dejaría el árbol ilegible", async () => {
    const fs = await published();
    const antes = await snapshot(fs, `${WS}/${NEW_PKG}`);
    for (const path of ["design-manifest.json", "baselines/DES-001-r002.json"]) {
      const validated = await validateWith(fs, "record", recordInputs, [
        { path: `${NEW_PKG}/${path}`, content: "{}\n" },
      ]);
      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      expect(validated.attempt.receipt.outcome, path).toBe("blocked");
      expect(validated.attempt.receipt.error?.code, path).toBe("DESIGN_FIELD_INVALID");
      expect(validated.attempt.receipt.error?.message, path).toContain("no acuña revisión");
    }
    expect(await snapshot(fs, `${WS}/${NEW_PKG}`)).toEqual(antes);
  });

  // Y la otra mitad de la regla: sin package indexado no hay dónde escribir que
  // el listado pueda leer después, así que no se escribe.
  it("sin package indexado donde escribir, se rechaza con causa y no escribe nada", async () => {
    const fs = new MemFs();
    const prepared = await dispatch(fs, "prepare", "record", [
      input("package", "DES-404"),
      input("revision", "r1"),
      input("decision", "approved"),
    ]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.attempt.receipt.outcome).toBe("blocked");
    expect(prepared.attempt.receipt.error?.code).toBe("DESIGN_PACKAGE_NOT_FOUND");
    expect([...fs.writes.keys()]).toEqual([]);
  });

  // Un diseño simple no tiene catálogo, así que juzgarlo por uno lo declararía
  // `handoff` por vacuidad. La madurez la contesta la MISMA función que contesta
  // `validate`, que es la que sabe qué forma tiene el diseño que está mirando.
  it("sobre un diseño simple reporta la madurez de su documento, no la de un catálogo vacío", async () => {
    const fs = new MemFs();
    const abierto = [
      "# Alta de miembro",
      "",
      "## Objetivo",
      "",
      "Dar de alta a un miembro nuevo.",
      "",
      "## Diseño propuesto",
      "",
      "Un formulario con documento y nombre.",
      "",
      "## Validación",
      "",
      "Se comprueba con un alta real.",
      "",
      "## Abiertos",
      "",
      "¿La baja reusa el mismo formulario?",
      "",
    ].join("\n");
    const created = await validateWith(
      fs,
      "create",
      [input("title", "Alta de miembro"), input("sources", ["docs/requisitos.md"])],
      [{ path: `${NEW_PKG}/DESIGN.md`, content: abierto }],
    );
    await applyValidated(fs, created, "create");

    const validated = await validateWith(fs, "record", recordInputs, [
      {
        path: `${NEW_PKG}/governance/reviews/REV-001.json`,
        content: REVIEW.content,
      },
    ]);
    const maturity = receiptMaturity(validated);
    expect(maturity.attained, JSON.stringify(maturity.gaps)).toBe("outline");
    expect(maturity.gaps.join(" ")).toContain("Abiertos");
  });

  it("una proyección REEMPLAZA la que regenera; un record no pisa una decisión", async () => {
    const validated = await validateWith(await published(), "record", recordInputs, [
      REVIEW,
      { path: `${NEW_PKG}/PACKAGE.md`, content: "# DES-001\n" },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const artifacts = validated.attempt.plan?.proposal.artifacts ?? [];
    expect(artifacts.find((a) => a.path.endsWith("PACKAGE.md"))?.overwrite).toBe(true);
    expect(artifacts.find((a) => a.path.endsWith("REV-001.json"))?.overwrite).toBe(false);
  });
});

describe("la revisión y su consumidor se publican en un único lote", () => {
  const CONSUMER_PATH = "docs/plans/031-plan-consumidor-atomico.md";
  const CONSUMER_BEFORE = "# Plan 031 — versión anterior\n";

  async function consumerFor(fs: MemFs): Promise<{
    content: string;
    input: CapabilityInputValue;
  }> {
    const preview = await candidate(fs, [NEW_FLOW], localDateIso(new Date()));
    if (!preview.ok) throw new Error(preview.failures[0]?.message);
    const content = consumerMarkdown(preview.value.revision, preview.value.baseline.digest);
    return { content, input: consumerInput(CONSUMER_PATH, content, CONSUMER_BEFORE) };
  }

  it("relaciona el manifest, sella ambas bases y escribe el consumidor al final", async () => {
    const fs = workspace();
    fs.file(`${WS}/${CONSUMER_PATH}`, CONSUMER_BEFORE);
    const consumer = await consumerFor(fs);
    const inputs = [...updateInputs("DES-001@r1"), consumer.input];

    const validated = await validateWith(fs, "update", inputs, [
      { path: `${PKG}/${NEW_FLOW.path}`, content: NEW_FLOW.content },
    ]);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const plan = validated.attempt.plan;
    expect(plan).not.toBeNull();
    if (plan === null) return;

    const last = plan.proposal.artifacts[plan.proposal.artifacts.length - 1];
    expect(last?.path).toBe(CONSUMER_PATH);
    expect(plan.proposal.bases.map((base) => base.path)).toEqual([
      `${PKG}/design-manifest.json`,
      CONSUMER_PATH,
    ]);

    const applied = await applyValidated(fs, validated, "update");
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("completed");

    const manifest = JSON.parse(
      await fs.readText(`${WS}/${PKG}/design-manifest.json`),
    ) as DesignManifest;
    // La relación nueva se incorpora sin borrar el consumidor histórico que
    // ya declaraba el manifest de partida.
    expect(manifest.relations.plans).toEqual([
      "docs/plans/012-plan-paquete-diseno-ui-y-flows.md",
      CONSUMER_PATH,
    ]);
    expect(await fs.readText(`${WS}/${CONSUMER_PATH}`)).toBe(consumer.content);
    expect(await fs.readText(`${WS}/${PKG}/PACKAGE.md`)).toContain(CONSUMER_PATH);
  });

  it("una refinería compuesta no puede acuñar un baseline sin su consumidor", async () => {
    const result = await dispatchCapability(
      {
        verb: "prepare",
        capability: "design",
        operation: "update",
        route: "compose",
        flow: "plan-refine",
        inputs: updateInputs("DES-001@r1"),
      },
      ctx(workspace()),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("blocked");
    expect(result.attempt.receipt.error?.code).toBe("DESIGN_CONSUMER_REQUIRED");
  });

  it("rechaza un attachment que ya quedó stale antes de preparar el lote", async () => {
    const fs = workspace();
    fs.file(`${WS}/${CONSUMER_PATH}`, "# Plan 031 — bytes vigentes\n");
    const stale = consumerInput(CONSUMER_PATH, "# Plan 031 — final\n", CONSUMER_BEFORE);

    const result = await validateWith(
      fs,
      "update",
      [...updateInputs("DES-001@r1"), stale],
      [{ path: `${PKG}/${NEW_FLOW.path}`, content: NEW_FLOW.content }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("blocked");
    expect(result.attempt.receipt.error?.code).toBe("DESIGN_CONSUMER_BASE_STALE");
  });

  it("vuelve a comprobar la base del consumidor al aplicar", async () => {
    const fs = workspace();
    fs.file(`${WS}/${CONSUMER_PATH}`, CONSUMER_BEFORE);
    const consumer = await consumerFor(fs);
    const beforePackage = await snapshot(fs);
    const validated = await validateWith(
      fs,
      "update",
      [...updateInputs("DES-001@r1"), consumer.input],
      [{ path: `${PKG}/${NEW_FLOW.path}`, content: NEW_FLOW.content }],
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    fs.file(`${WS}/${CONSUMER_PATH}`, "# Plan 031 — cambió tras la vista previa\n");
    const applied = await applyValidated(fs, validated, "update");

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("blocked");
    expect(applied.attempt.receipt.error?.code).toBe("PROPOSAL_BASE_STALE");
    expect(await snapshot(fs)).toEqual(beforePackage);
  });

  it.each([
    [
      "proveniencia que no es attachment",
      {
        name: "consumer_document",
        value: "# Plan\n",
        provenance: {
          kind: "text",
          origin: CONSUMER_PATH,
          seal: baseDigest(CONSUMER_BEFORE),
          sensitivity: "public",
        },
      } satisfies CapabilityInputValue,
      "DESIGN_CONSUMER_INVALID",
    ],
    [
      "path que sale del workspace",
      {
        name: "consumer_document",
        value: "# Plan\n",
        provenance: {
          kind: "attachment",
          origin: "../fuera.md",
          seal: baseDigest(CONSUMER_BEFORE),
          sensitivity: "public",
        },
      } satisfies CapabilityInputValue,
      "DESIGN_PATH_UNSAFE",
    ],
  ])("rechaza %s", async (_case, invalid, code) => {
    const result = await dispatch(new MemFs(), "prepare", "update", [
      ...updateInputs("DES-001@r1"),
      invalid,
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("blocked");
    expect(result.attempt.receipt.error?.code).toBe(code);
  });

  it("rechaza una referencia del consumidor que no fija el baseline candidato", async () => {
    const fs = workspace();
    fs.file(`${WS}/${CONSUMER_PATH}`, CONSUMER_BEFORE);
    const preview = await candidate(fs, [NEW_FLOW], localDateIso(new Date()));
    if (!preview.ok) throw new Error(preview.failures[0]?.message);
    const staleReference = consumerMarkdown(1, preview.value.baseline.digest);
    const stale = consumerInput(CONSUMER_PATH, staleReference, CONSUMER_BEFORE);

    const result = await validateWith(
      fs,
      "update",
      [...updateInputs("DES-001@r1"), stale],
      [{ path: `${PKG}/${NEW_FLOW.path}`, content: NEW_FLOW.content }],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attempt.receipt.outcome).toBe("blocked");
    expect(result.attempt.receipt.error?.code).toBe("DESIGN_CONSUMER_REFERENCE_STALE");
  });

  it("un fallo al escribir el consumidor restaura también el package", async () => {
    const fs = workspace();
    // El directorio runtime ya existía antes del lote; la release actual deja
    // el directorio intacto y elimina sólo el archivo lock que adquirió.
    fs.dir(`${WS}/.workflow`);
    fs.file(`${WS}/${CONSUMER_PATH}`, CONSUMER_BEFORE);
    const consumer = await consumerFor(fs);
    const before = await snapshot(fs, WS);
    const validated = await validateWith(
      fs,
      "update",
      [...updateInputs("DES-001@r1"), consumer.input],
      [{ path: `${PKG}/${NEW_FLOW.path}`, content: NEW_FLOW.content }],
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const writeText = fs.writeText.bind(fs);
    let consumerWrites = 0;
    fs.writeText = async (path: string, content: string): Promise<void> => {
      if (path === `${WS}/${CONSUMER_PATH}` && consumerWrites++ === 0) {
        throw new Error("disco lleno al reemplazar el consumidor");
      }
      return writeText(path, content);
    };
    const applied = await applyValidated(fs, validated, "update");
    fs.writeText = writeText;

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("blocked");
    expect(await snapshot(fs, WS)).toEqual(before);
  });
});

describe("la publicación es todo o nada, y el rollback devuelve el ÁRBOL", () => {
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

    const applied = await publishR2(fs);
    fs.writeText = original;
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("blocked");
    expect(writes).toBeGreaterThan(1); // llegó lejos antes de fallar
    expect(await snapshot(fs)).toEqual(antes);
  });

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
    const applied = await publishR2(fs);
    fs.writeText = original;

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("blocked");
    expect(await snapshot(fs)).toEqual(antes);
  });

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

    const applied = await publishR2(fs);
    fs.writeTextExclusive = exclusive;
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("blocked");
    expect(await snapshot(fs)).toEqual(antes);
  });

  it("un archivo ilegible no se sobrescribe ni se trunca", async () => {
    const fs = workspace();
    fs.file(`${WS}/${PKG}/PACKAGE.md`, "la landing anterior");
    const antes = await snapshot(fs);
    const readText = fs.readText.bind(fs);
    let armed = false;
    fs.readText = async (path: string) => {
      if (armed && path.endsWith("PACKAGE.md")) throw new Error("EACCES: permission denied");
      return readText(path);
    };

    const inputs = updateInputs("DES-001@r1");
    const validated = await validateWith(fs, "update", inputs, [
      { path: `${PKG}/${NEW_FLOW.path}`, content: NEW_FLOW.content },
    ]);
    armed = true;
    const applied = await applyValidated(fs, validated, "update");
    fs.readText = readText;

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("blocked");
    expect(await snapshot(fs)).toEqual(antes);
  });
});

describe("la madurez sale del veredicto de los gates, no de la ruta", () => {
  it("un artefacto que satisface los gates de handoff obtiene handoff", async () => {
    const fs = new MemFs();
    const validated = await validateWith(fs, "create", createInputs("handoff"), [
      { path: `${NEW_PKG}/flows/FLW-001-r001-alta-miembro.md`, content: FLOW_R1 },
    ]);
    const maturity = receiptMaturity(validated);
    expect(maturity.attained).toBe("handoff");
    expect(maturity.gaps).toEqual([]);
  });

  it("y uno que no los satisface obtiene outline CON su razón", async () => {
    const fs = new MemFs();
    const validated = await validateWith(fs, "create", createInputs("handoff"), [
      {
        path: `${NEW_PKG}/flows/FLW-001-r001-alta-miembro.md`,
        content: FLOW_R1.replace("maturity: handoff", "maturity: outline"),
      },
    ]);
    const maturity = receiptMaturity(validated);
    expect(maturity.attained).toBe("outline");
    // La razón nombra el artefacto que la retiene POR IDENTIDAD — la misma que
    // usa `validate` — y qué se pidió: sin eso el veredicto es un adjetivo que
    // nadie puede accionar.
    expect(maturity.gaps.join(" ")).toContain("FLW-001@r1");
    expect(maturity.gaps.join(" ")).toContain("outline");
    expect(maturity.gaps.join(" ")).toContain("handoff");
  });

  it("y un package publicado reporta la misma madurez cuando se lo vuelve a juzgar", async () => {
    const fs = new MemFs();
    const validated = await validateWith(fs, "create", createInputs(), [
      { path: `${NEW_PKG}/flows/FLW-001-r001-alta-miembro.md`, content: FLOW_R1 },
    ]);
    await applyValidated(fs, validated, "create");

    const judged = await dispatch(fs, "prepare", "validate", [input("package", "DES-001")]);
    expect(receiptMaturity(judged).attained).toBe("handoff");
  });

  /**
   * The false `handoff` an adversarial review found with the real binary: r3
   * left the flow in `outline`, r4 introduced a single token, and the receipt
   * answered `handoff` with no gaps — because the ceiling judged only the files
   * that revision INTRODUCED, and a token has no ladder to hold anything back.
   * The `validate` immediately afterwards said `outline` about the same tree.
   */
  it("una revisión que no introduce documentos hereda el techo del catálogo, no un handoff vacuo", async () => {
    const fs = new MemFs();
    const outline = FLOW_R1.replace("maturity: handoff", "maturity: outline");
    const r1 = await validateWith(fs, "create", createInputs(), [
      { path: `${NEW_PKG}/flows/FLW-001-r001-alta-miembro.md`, content: outline },
    ]);
    expect(receiptMaturity(r1).attained).toBe("outline");
    await applyValidated(fs, r1, "create");

    // Una revisión de un solo token: ni un flow ni una screen que puedan objetar.
    const r2 = await validateWith(
      fs,
      "update",
      [input("package", "DES-001"), input("base", "DES-001@r1"), input("expansion", EXPANSION)],
      [
        {
          path: `${NEW_PKG}/tokens/TOK-001-r001-base.tokens.json`,
          content: `${JSON.stringify({ color: { base: "#000" } }, null, 2)}\n`,
        },
      ],
    );
    const maturity = receiptMaturity(r2);
    expect(maturity.attained, JSON.stringify(maturity.gaps)).toBe("outline");
    expect(maturity.gaps.join(" ")).toContain("FLW-001@r1");

    // Y el recibo y el veredicto del listado hablan del MISMO árbol: era esa
    // contradicción, y no el valor suelto, la que hacía inservible la madurez.
    await applyValidated(fs, r2, "update");
    const judged = await dispatch(fs, "prepare", "validate", [input("package", "DES-001")]);
    expect(receiptMaturity(judged).attained).toBe("outline");
  });

  /**
   * The other half of the same false `handoff`: `currentness` is allowed not to
   * enumerate an artifact — `manifest-maximal.json` does not enumerate its
   * screen — and a ceiling that kept only the entries it MARKS dropped that
   * screen out of the verdict entirely.
   */
  it("un artefacto que `currentness` no enumera sigue contando en el veredicto", async () => {
    const fs = new MemFs();
    const created = await validateWith(fs, "create", createInputs(), [
      { path: `${NEW_PKG}/flows/FLW-001-r001-alta-miembro.md`, content: FLOW_R1 },
      { path: `${NEW_PKG}/screens/SCR-002-r001-confirmacion.md`, content: SCREEN_OUTLINE },
    ]);
    await applyValidated(fs, created, "create");

    // El flow queda marcado y la screen no. `currentness` NO está obligada a
    // enumerar todo — `manifest-maximal.json` tampoco enumera la suya — y un
    // techo que filtraba por lo que marca borraba la screen del juicio entero.
    const path = `${WS}/${NEW_PKG}/design-manifest.json`;
    const manifest = JSON.parse(await fs.readText(path)) as DesignManifest;
    manifest.currentness = [{ ref: "DES-001/FLW-001@r1", state: "current" }];
    fs.file(path, JSON.stringify(manifest, null, 2));

    const judged = await dispatch(fs, "prepare", "validate", [input("package", "DES-001")]);
    const maturity = receiptMaturity(judged);
    expect(maturity.attained, JSON.stringify(maturity.gaps)).toBe("outline");
    expect(maturity.gaps.join(" ")).toContain("SCR-002@r1");
  });
});

describe("la ruta simple publica, se lista y alcanza handoff", () => {
  const SIMPLE_PKG = "docs/designs/001-design-alta-de-miembro";
  const DOCUMENT = [
    "# Alta de miembro",
    "",
    "## Objetivo",
    "",
    "Dar de alta a un miembro nuevo con su documento.",
    "",
    "## Diseño propuesto",
    "",
    "Un formulario con documento y nombre, y una confirmación al guardar.",
    "",
    "## Validación",
    "",
    "Se comprueba con un alta real y con un documento repetido.",
    "",
  ].join("\n");

  /** Simple is the default: nothing declares an expansion signal. */
  const simpleInputs = (maturity?: string): CapabilityInputValue[] => [
    input("title", "Alta de miembro"),
    input("sources", ["docs/requisitos.md"]),
    ...(maturity === undefined ? [] : [input("maturity", maturity)]),
  ];

  async function publishSimple(fs: MemFs, document: string, maturity?: string) {
    const inputs = simpleInputs(maturity);
    const validated = await validateWith(fs, "create", inputs, [
      { path: `${SIMPLE_PKG}/DESIGN.md`, content: document },
    ]);
    return { validated, applied: await applyValidated(fs, validated, "create") };
  }

  it("publica un diseño simple que el listado acepta", async () => {
    const fs = new MemFs();
    const { applied } = await publishSimple(fs, DOCUMENT);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.attempt.receipt.outcome).toBe("completed");

    const listed = await listDesigns(fs, ["--id", "DES-001"]);
    const entry = (listed.data as { package: { ok: boolean; mode: string; failures: unknown[] } })
      .package;
    expect(listed.ok).toBe(true);
    expect(entry.ok, JSON.stringify(entry.failures)).toBe(true);
    expect(entry.mode).toBe("simple");
  });

  // Lo que F3 desbloquea: antes la ruta simple fijaba la madurez en «ninguna»,
  // así que `handoff` no se alcanzaba jamás por este camino.
  it("un documento sin puntos abiertos alcanza handoff", async () => {
    const { validated } = await publishSimple(new MemFs(), DOCUMENT, "handoff");
    const maturity = receiptMaturity(validated);
    expect(maturity.attained).toBe("handoff");
    expect(maturity.gaps).toEqual([]);
  });

  it("y uno que declara '## Abiertos' se queda en outline con su razón", async () => {
    const conAbiertos = `${DOCUMENT}## Abiertos\n\n¿La baja reusa el mismo formulario?\n`;
    const { validated } = await publishSimple(new MemFs(), conAbiertos, "handoff");
    const maturity = receiptMaturity(validated);
    expect(maturity.attained).toBe("outline");
    expect(maturity.gaps.join(" ")).toContain("Abiertos");
    expect(maturity.gaps.join(" ")).toContain("incógnitas");
  });
});
