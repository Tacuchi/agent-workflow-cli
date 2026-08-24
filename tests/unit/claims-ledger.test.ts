import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  appendClaimEvent,
  claimKey,
  completedClaimsIn,
  ledgerPath,
  openClaimsOf,
  readClaimEvents,
} from "../../src/application/claims-ledger.js";
import { runNextNumber } from "../../src/application/dev-only-services.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/** Fails every ledger append, and nothing else. */
class FailingAppendFs extends NodeFileSystem {
  override async appendText(): Promise<void> {
    throw new Error("EIO simulado al registrar en el ledger");
  }
}

/**
 * The trace of a reservation's life, and where it is allowed to live.
 *
 * Releasing a claim used to delete the marker and end there: nothing said who
 * had held the number, why it went away, or whether it had ever been published.
 * A released correlative and one that never existed read identically, so a
 * recovery had no evidence and a reuse had no basis.
 */
describe("claims ledger", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;
  const OWNER = "201-alpha-plan-new";

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "claims-ledger-"));
    env = new FakeEnv(workspace, workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
    mkdirSync(join(workspace, ".workflow", "sessions"), { recursive: true });
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("vive bajo .workflow/ y nunca dentro de docs/", async () => {
    await appendClaimEvent(fs, paths, {
      at: "2026-08-23T00:00:00.000Z",
      event: "claimed",
      claim: { category: "plans", correlative: "036", name: "plan-x.md", owner: OWNER },
    });

    const path = ledgerPath(paths);
    expect(path).toBe(join(workspace, ".workflow", "claims.jsonl"));
    expect(path).not.toContain(`${join(workspace, "docs")}`);
    // El corpus es para documentos que alguien publicó, y una historia de
    // reservas no es uno: dentro de docs/ la huella se leería como una spec.
    expect(existsSync(join(workspace, "docs"))).toBe(false);
  });

  it("es append-only: un registro nuevo no reescribe al anterior", async () => {
    const claim = { category: "plans", correlative: "036", name: "plan-x.md", owner: OWNER };
    await appendClaimEvent(fs, paths, { at: "2026-08-23T00:00:00.000Z", event: "claimed", claim });
    const afterFirst = readFileSync(ledgerPath(paths), "utf8");

    await appendClaimEvent(fs, paths, {
      at: "2026-08-23T01:00:00.000Z",
      event: "released",
      claim,
      cause: "la sesión cerró sin publicar",
    });

    const both = readFileSync(ledgerPath(paths), "utf8");
    expect(both.startsWith(afterFirst)).toBe(true);
    const read = await readClaimEvents(fs, paths);
    expect(read.events.map((e) => e.event)).toEqual(["claimed", "released"]);
    expect(read.events.every((e) => claimKey(e.claim) === claimKey(claim))).toBe(true);
    expect(read.events[1]?.cause).toBe("la sesión cerró sin publicar");
  });

  it("una línea corrupta se cuenta, no esconde a las demás ni se lee como vacío", async () => {
    await appendClaimEvent(fs, paths, {
      at: "2026-08-23T00:00:00.000Z",
      event: "claimed",
      claim: { category: "plans", correlative: "036", name: "plan-x.md", owner: OWNER },
    });
    writeFileSync(ledgerPath(paths), `${readFileSync(ledgerPath(paths), "utf8")}{roto\n`);

    const read = await readClaimEvents(fs, paths);

    expect(read.events).toHaveLength(1);
    // Un ledger que nadie puede leer entero NO es un ledger vacío, y la
    // diferencia decide si una recuperación puede levantar un cerco.
    expect(read.unreadable).toBe(1);
  });

  it("un ledger ausente se lee vacío, sin error", async () => {
    expect(await readClaimEvents(fs, paths)).toEqual({ events: [], unreadable: 0 });
  });

  it("el reclamo deja su registro dentro del mismo candado que lo mintea", async () => {
    const claimed = await runNextNumber(fs, env, paths, {
      directory: "docs/plans",
      claim: { name: "plan-alpha.md", owner: OWNER },
    });

    const read = await readClaimEvents(fs, paths);
    expect(read.events).toHaveLength(1);
    expect(read.events[0]?.event).toBe("claimed");
    expect(read.events[0]?.claim).toEqual({
      category: "plans",
      correlative: claimed.next,
      name: "plan-alpha.md",
      owner: OWNER,
    });
  });

  it("una publicación de una pasada NO deja registro: no hay reserva que contar", async () => {
    await runNextNumber(fs, env, paths, {
      directory: "docs/specs",
      publish: { name: "spec-x.md", content: "# spec\n" },
    });

    expect((await readClaimEvents(fs, paths)).events).toEqual([]);
  });

  it("la liberación al cerrar deja su causa, y la huella sobrevive al borrado de la sesión", async () => {
    const sessionDir = join(workspace, ".workflow", "sessions", OWNER);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "SESSION.md"), "# SESSION — alpha\n\n## Objective\nx\n");
    await runNextNumber(fs, env, paths, {
      directory: "docs/plans",
      claim: { name: "plan-alpha.md", owner: OWNER },
    });

    const closed = await runSessionClose(fs, paths, { code: "201" });
    if (!("sessionClose" in closed)) throw new Error("esperaba cerrar la sesión");
    expect(closed.sessionClose.reservations_released).toEqual(["docs/plans/001-plan-alpha.md"]);

    // La carpeta de la sesión se va; la historia del correlativo no.
    rmSync(sessionDir, { recursive: true, force: true });
    const read = await readClaimEvents(fs, paths);
    expect(read.events.map((e) => e.event)).toEqual(["claimed", "released"]);
    expect(read.events[1]?.cause).toContain("session-close");
    expect(read.events[1]?.claim.correlative).toBe("001");
    // Y lo que importa: el registro CIERRA el claim en la lectura del propio
    // ledger. Sin esto, un `released` que no fuera terminal —o cuya identidad no
    // coincidiera con la del `claimed` por un solo carácter— dejaría el
    // correlativo abierto para siempre y nadie lo notaría.
    expect(openClaimsOf(read.events, OWNER)).toEqual([]);
  });

  it("un correlativo liberado deja de estar abierto; uno publicado también, y por eso NO vuelve", async () => {
    const claim = { category: "plans", correlative: "007", name: "plan-x.md", owner: OWNER };
    await appendClaimEvent(fs, paths, { at: "2026-08-23T00:00:00Z", event: "claimed", claim });
    expect(openClaimsOf((await readClaimEvents(fs, paths)).events, OWNER)).toHaveLength(1);

    await appendClaimEvent(fs, paths, { at: "2026-08-23T01:00:00Z", event: "published", claim });
    expect(openClaimsOf((await readClaimEvents(fs, paths)).events, OWNER)).toEqual([]);
  });

  it("sólo cuenta como completado el destino que cierra un claim ABIERTO de ESE dueño", async () => {
    await appendClaimEvent(fs, paths, {
      at: "2026-08-23T00:00:00Z",
      event: "claimed",
      claim: { category: "plans", correlative: "003", name: "plan-mio.md", owner: OWNER },
    });
    const events = (await readClaimEvents(fs, paths)).events;

    // El propio: cuenta.
    expect(
      completedClaimsIn(events, OWNER, {
        written: ["docs/plans/003-plan-mio.md"],
        already_applied: false,
        destinations: [],
      }),
    ).toHaveLength(1);

    // Un documento numerado que este dueño NUNCA reclamó: NO cuenta. Sin esta
    // guarda, cualquier sesión con un claim abierto estamparía un `published`
    // —un cerco permanente de «gastado para siempre»— sobre todo numerado que
    // escriba, y eso es una mentira durable sobre el corpus.
    expect(
      completedClaimsIn(events, OWNER, {
        written: ["docs/specs/003-spec-ajeno.md"],
        already_applied: false,
        destinations: [],
      }),
    ).toEqual([]);
    expect(
      completedClaimsIn(events, OWNER, {
        written: ["docs/plans/004-plan-otro.md"],
        already_applied: false,
        destinations: [],
      }),
    ).toEqual([]);
    // El claim de otro dueño sobre el mismo camino: tampoco.
    expect(
      completedClaimsIn(events, "202-beta-plan-new", {
        written: ["docs/plans/003-plan-mio.md"],
        already_applied: false,
        destinations: [],
      }),
    ).toEqual([]);
    // Y lo que no es un documento numerado dentro de una categoría: tampoco.
    expect(
      completedClaimsIn(events, OWNER, {
        written: ["docs/plans/README.md", "otro/003-plan-mio.md"],
        already_applied: false,
        destinations: [],
      }),
    ).toEqual([]);
  });

  it("un dueño sin claims abiertos no completa nada", async () => {
    expect(
      completedClaimsIn([], OWNER, {
        written: ["docs/plans/001-plan-x.md"],
        already_applied: false,
        destinations: [],
      }),
    ).toEqual([]);
  });

  it("si el registro de la liberación falla, el marcador NO se borra: nada se libera sin huella", async () => {
    const sessionDir = join(workspace, ".workflow", "sessions", OWNER);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "SESSION.md"), "# SESSION — alpha\n\n## Objective\nx\n");
    await runNextNumber(fs, env, paths, {
      directory: "docs/plans",
      claim: { name: "plan-alpha.md", owner: OWNER },
    });
    const slot = join(workspace, "docs", "plans", "001-plan-alpha.md");
    expect(existsSync(slot)).toBe(true);

    const closed = await runSessionClose(new FailingAppendFs(), paths, { code: "201" });
    if (!("sessionClose" in closed)) throw new Error("esperaba cerrar la sesión");

    // El orden es la garantía: se registra ANTES de borrar. Si el registro no
    // pudo escribirse, el marcador tiene que seguir ahí — un correlativo liberado
    // sin ninguna línea que lo diga es exactamente el estado que este ledger
    // existe para terminar, y nadie lo podría reconciliar después.
    expect(existsSync(slot)).toBe(true);
    expect(closed.sessionClose.reservations_released).toBeUndefined();
    expect(closed.sessionClose.reservations_error).toBeDefined();
    // Y el claim sigue abierto y atribuido, listo para una recuperación.
    expect(openClaimsOf((await readClaimEvents(fs, paths)).events, OWNER)).toHaveLength(1);
  });

  it("una reentrada ya aplicada acredita los destinos: si no, el claim quedaría abierto para siempre", async () => {
    const claim = { category: "plans", correlative: "005", name: "plan-mio.md", owner: OWNER };
    await appendClaimEvent(fs, paths, { at: "2026-08-23T00:00:00Z", event: "claimed", claim });
    const events = (await readClaimEvents(fs, paths)).events;

    // `applyLocalProposal` contesta la reentrada con `written: []` porque no
    // escribió nada ESTA vez, pero el documento ya está en disco. Acreditar sólo
    // `written` dejaba el claim abierto y NINGÚN reintento podía corregirlo: todos
    // contestan igual. El destino es la evidencia en ese caso.
    expect(
      completedClaimsIn(events, OWNER, {
        written: [],
        already_applied: true,
        destinations: ["docs/plans/005-plan-mio.md"],
      }),
    ).toHaveLength(1);

    // Y sin already_applied, una lista vacía sigue siendo nada que acreditar.
    expect(
      completedClaimsIn(events, OWNER, {
        written: [],
        already_applied: false,
        destinations: ["docs/plans/005-plan-mio.md"],
      }),
    ).toEqual([]);
  });
});
