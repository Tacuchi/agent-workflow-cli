import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { runNextNumber } from "../../src/application/dev-only-services.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * The single-pass creation that has no session to own a reservation.
 *
 * `--claim` demands an owner, which is right: a durable reservation nobody can
 * attribute has no re-entry, no close and no recovery. But `spec-new` legitimately
 * runs outside any session, and refusing it a claim without giving it another
 * route would leave it unable to create anything. Its route is this one — the
 * correlative and the final bytes land as ONE act, so there is no reserved state
 * in between for an interruption to strand.
 */
const DRAFT = "---\nstatus: draft\n---\n\n# Spec — algo que ya está escrito\n";

/** Fails exactly where the destination would be created, and nowhere earlier. */
class FailingPublishFs extends NodeFileSystem {
  override async publishTextExclusive(): Promise<{ created: boolean }> {
    throw new Error("EIO simulado en la creación exclusiva");
  }
}

describe("runNextNumber --publish", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;
  const specs = (): string[] => readdirSync(join(workspace, "docs", "specs")).sort();

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "next-number-publish-"));
    env = new FakeEnv(workspace, workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("asigna el correlativo y escribe los bytes finales en un solo acto", async () => {
    const out = await runNextNumber(fs, env, paths, {
      directory: "docs/specs",
      publish: { name: "spec-algo.md", content: DRAFT },
    });

    expect(out.next).toBe("001");
    expect(out.published_path).toContain("001-spec-algo.md");
    // Una publicación NO es una reserva: no hay slot que nadie pueda completar.
    expect(out.claimed_path).toBeNull();
    expect(out.claimed_owner).toBeNull();
    expect(out.claim_reused).toBe(false);
    expect(readFileSync(join(workspace, "docs", "specs", "001-spec-algo.md"), "utf8")).toBe(DRAFT);
  });

  it("el documento nace con todos sus bytes, nunca con cero", async () => {
    await runNextNumber(fs, env, paths, {
      directory: "docs/specs",
      publish: { name: "spec-uno.md", content: DRAFT },
    });

    const onDisk = specs();
    expect(onDisk).toEqual(["001-spec-uno.md"]);
    // El defecto de origen fue exactamente un archivo de cero bytes ocupando un
    // correlativo: si esta afirmación se rompe, volvió.
    expect(
      readFileSync(join(workspace, "docs", "specs", onDisk[0] as string), "utf8").length,
    ).toBeGreaterThan(0);
  });

  it("un fallo antes del commit deja los dos efectos ausentes", async () => {
    const failing = new FailingPublishFs();

    await expect(
      runNextNumber(failing, env, paths, {
        directory: "docs/specs",
        publish: { name: "spec-interrumpida.md", content: DRAFT },
      }),
    ).rejects.toThrow(/EIO simulado/);

    // Ni archivo ni marcador: el directorio quedó vacío.
    expect(specs()).toEqual([]);
    // Y el correlativo sigue disponible para la creación siguiente.
    const after = await runNextNumber(fs, env, paths, { directory: "docs/specs" });
    expect(after.next).toBe("001");
  });

  it("no deja residuo temporal en el directorio publicado", async () => {
    await runNextNumber(fs, env, paths, {
      directory: "docs/specs",
      publish: { name: "spec-limpia.md", content: DRAFT },
    });

    expect(specs().filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  it("salta un correlativo que otro documento ya tiene", async () => {
    mkdirSync(join(workspace, "docs", "specs"), { recursive: true });
    writeFileSync(join(workspace, "docs", "specs", "001-spec-vieja.md"), "x");

    const out = await runNextNumber(fs, env, paths, {
      directory: "docs/specs",
      publish: { name: "spec-nueva.md", content: DRAFT },
    });

    expect(out.next).toBe("002");
    expect(readFileSync(join(workspace, "docs", "specs", "001-spec-vieja.md"), "utf8")).toBe("x");
  });

  it("publicar dos veces el mismo nombre da dos documentos, no una reentrada", async () => {
    // Una reserva se reentra porque su dueño sigue vivo; una publicación no dejó
    // nada abierto que reentrar, así que la segunda es un documento nuevo.
    const first = await runNextNumber(fs, env, paths, {
      directory: "docs/specs",
      publish: { name: "spec-dos-veces.md", content: DRAFT },
    });
    const second = await runNextNumber(fs, env, paths, {
      directory: "docs/specs",
      publish: { name: "spec-dos-veces.md", content: DRAFT },
    });

    expect(second.published_path).not.toBe(first.published_path);
    expect(specs()).toHaveLength(2);
  });

  it("rechaza un nombre que es una ruta en lugar de un nombre", async () => {
    await expect(
      runNextNumber(fs, env, paths, {
        directory: "docs/specs",
        publish: { name: "../fuera.md", content: DRAFT },
      }),
    ).rejects.toThrow(/separadores de ruta/);
    // La guarda corre ANTES del candado y del scan, así que ni el directorio se
    // creó: no hay «directorio vacío» que inspeccionar, no hay directorio.
    expect(() => readdirSync(join(workspace, "docs"))).toThrow();
  });

  it("reclamar y publicar se excluyen", async () => {
    await expect(
      runNextNumber(fs, env, paths, {
        directory: "docs/specs",
        claim: { name: "spec-x.md", owner: "201-x-spec-new" },
        publish: { name: "spec-x.md", content: DRAFT },
      }),
    ).rejects.toThrow(/se excluyen/);
    // Mismo motivo: la exclusión se decide antes de tocar el filesystem.
    expect(() => readdirSync(join(workspace, "docs"))).toThrow();
  });
});

/**
 * The primitive underneath, on the real filesystem.
 *
 * `writeTextExclusive` opens `wx` and only then writes, so a process that dies in
 * between leaves a zero-byte file at the destination. That is the artifact the
 * whole spec exists to retire, so the publication path uses a primitive that is
 * atomic as well as exclusive.
 */
describe("publishTextExclusive", () => {
  let dir: string;
  let fs: NodeFileSystem;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "publish-exclusive-"));
    fs = new NodeFileSystem();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("crea el archivo con todo su contenido y sin dejar temporales", async () => {
    const target = join(dir, "doc.md");

    expect(await fs.publishTextExclusive(target, DRAFT)).toEqual({ created: true });
    expect(readFileSync(target, "utf8")).toBe(DRAFT);
    expect(readdirSync(dir)).toEqual(["doc.md"]);
  });

  it("se niega sobre una ruta tomada y no toca sus bytes", async () => {
    const target = join(dir, "doc.md");
    writeFileSync(target, "lo que ya estaba");

    expect(await fs.publishTextExclusive(target, DRAFT)).toEqual({ created: false });
    expect(readFileSync(target, "utf8")).toBe("lo que ya estaba");
    // El staging se limpia también cuando el link falla.
    expect(readdirSync(dir)).toEqual(["doc.md"]);
  });
});
