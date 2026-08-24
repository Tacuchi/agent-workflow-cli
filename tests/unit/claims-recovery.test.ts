import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  appendClaimEvent,
  isRevoked,
  openClaimsOf,
  readClaimEvents,
  revokedAmong,
} from "../../src/application/claims-ledger.js";
import {
  applyRecovery,
  previewRecovery,
  scanSlots,
} from "../../src/application/claims-recovery.js";
import { runNextNumber } from "../../src/application/dev-only-services.js";
import { acquireLock } from "../../src/application/lock-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * The reservation whose owner never came back.
 *
 * There is no clock in any of this: a reservation does not expire, because "it
 * has been a while" is not evidence that nobody is coming. What frees a slot is
 * an explicit, authorized recovery — and the ORDER inside it is the guarantee,
 * because once the file is gone the correlative is eligible and a late sealed
 * proposal from the dead owner could still land on it.
 */

/** Fails the ledger append, and nothing else, so the seal cannot be written. */
class UnsealableFs extends NodeFileSystem {
  override async appendText(): Promise<void> {
    throw new Error("EIO simulado: la revocación no se puede sellar");
  }
}

const OWNER = "201-alpha-plan-new";
const OTHER = "202-beta-plan-new";

describe("aw claims recover", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "claims-recovery-"));
    env = new FakeEnv(workspace, workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
    mkdirSync(join(workspace, ".workflow", "sessions"), { recursive: true });
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  const claimSlot = async (name: string, owner: string, dir = "docs/plans") =>
    await runNextNumber(fs, env, paths, { directory: dir, claim: { name, owner } });

  it("lista reservas y placeholders legacy, y NUNCA un documento publicado", async () => {
    await claimSlot("plan-alpha.md", OWNER);
    // Un documento real, con contenido.
    writeFileSync(
      join(workspace, "docs", "plans", "002-plan-publicado.md"),
      "# Plan\n\ncontenido\n",
    );
    // Un placeholder legacy: numerado, vacío, sin dueño.
    writeFileSync(join(workspace, "docs", "plans", "003-plan-viejo.md"), "");

    const scan = await scanSlots(fs, paths);

    expect(scan.slots.map((s) => `${s.kind}:${s.path}`)).toEqual([
      "reservation:docs/plans/001-plan-alpha.md",
      "legacy-placeholder:docs/plans/003-plan-viejo.md",
    ]);
    expect(scan.slots[0]?.owner).toBe(OWNER);
    expect(scan.slots[1]?.owner).toBeNull();
  });

  it("sella la revocación ANTES de liberar, y deja la sesión y sus otras reservas intactas", async () => {
    const mine = await claimSlot("plan-alpha.md", OWNER);
    const alsoMine = await claimSlot("plan-alpha-dos.md", OWNER);
    const theirs = await claimSlot("plan-beta.md", OTHER);
    const target = "docs/plans/001-plan-alpha.md";

    const preview = await previewRecovery(fs, paths, target);
    if ("error" in preview) throw new Error(preview.error);
    const applied = await applyRecovery(fs, paths, {
      target,
      approval: preview.proposal.digest,
    });
    if ("error" in applied) throw new Error(applied.error);

    const read = await readClaimEvents(fs, paths);
    const mineEvents = read.events.filter((e) => e.claim.name === "plan-alpha.md");
    // El orden es la garantía, y es observable en el registro.
    expect(mineEvents.map((e) => e.event)).toEqual(["claimed", "revoked", "released"]);
    expect(existsSync(join(workspace, target))).toBe(false);

    // Acotada al claim: la otra reserva del MISMO dueño sigue abierta y en disco,
    // y la de otra sesión no se toca. Revocar la sesión entera para reclamar un
    // número destruiría trabajo para ordenar un correlativo.
    expect(openClaimsOf(read.events, OWNER).map((c) => c.name)).toEqual(["plan-alpha-dos.md"]);
    expect(existsSync(join(workspace, `docs/plans/${alsoMine.next}-plan-alpha-dos.md`))).toBe(true);
    expect(openClaimsOf(read.events, OTHER)).toHaveLength(1);
    expect(existsSync(join(workspace, `docs/plans/${theirs.next}-plan-beta.md`))).toBe(true);
    expect(mine.next).toBe("001");
  });

  it("si la revocación no puede sellarse, la recuperación falla SIN liberar", async () => {
    await claimSlot("plan-alpha.md", OWNER);
    const target = "docs/plans/001-plan-alpha.md";
    const preview = await previewRecovery(fs, paths, target);
    if ("error" in preview) throw new Error(preview.error);

    await expect(
      applyRecovery(new UnsealableFs(), paths, { target, approval: preview.proposal.digest }),
    ).rejects.toThrow(/no se puede sellar/);

    // Lo único inaceptable sería un slot liberado sin cerco: el archivo sigue ahí.
    expect(existsSync(join(workspace, target))).toBe(true);
    const read = await readClaimEvents(fs, paths);
    expect(read.events.map((e) => e.event)).toEqual(["claimed"]);
    expect(openClaimsOf(read.events, OWNER)).toHaveLength(1);
  });

  it("una aprobación que no corresponde no libera nada", async () => {
    await claimSlot("plan-alpha.md", OWNER);
    const target = "docs/plans/001-plan-alpha.md";

    const applied = await applyRecovery(fs, paths, { target, approval: "0".repeat(64) });

    expect("error" in applied && applied.error).toMatch(/aprobación no corresponde/);
    expect(existsSync(join(workspace, target))).toBe(true);
  });

  it("un placeholder legacy exige confirmación explícita de que no queda productor", async () => {
    mkdirSync(join(workspace, "docs", "plans"), { recursive: true });
    writeFileSync(join(workspace, "docs", "plans", "005-plan-viejo.md"), "");
    const target = "docs/plans/005-plan-viejo.md";
    const preview = await previewRecovery(fs, paths, target);
    if ("error" in preview) throw new Error(preview.error);
    expect(preview.proposal.requires_no_producer_confirmation).toBe(true);

    // Sin la confirmación: se niega. Sus bytes no prueban nada — un numerado
    // vacío es lo que deja un reclamo viejo interrumpido Y lo que deja un
    // documento a medio escribir, y el archivo no distingue los dos casos.
    const refused = await applyRecovery(fs, paths, {
      target,
      approval: preview.proposal.digest,
    });
    expect("error" in refused && refused.error).toMatch(/placeholder legacy ambiguo/);
    expect(existsSync(join(workspace, target))).toBe(true);

    const applied = await applyRecovery(fs, paths, {
      target,
      approval: preview.proposal.digest,
      noProducerConfirmed: true,
    });
    if ("error" in applied) throw new Error(applied.error);
    expect(existsSync(join(workspace, target))).toBe(false);
    const read = await readClaimEvents(fs, paths);
    expect(read.events.map((e) => e.event)).toEqual(["released"]);
    expect(read.events[0]?.cause).toContain("no queda productor");
  });

  it("una revocación es irrevocable: no se repite y el claim queda fenced para siempre", async () => {
    await claimSlot("plan-alpha.md", OWNER);
    const target = "docs/plans/001-plan-alpha.md";
    const preview = await previewRecovery(fs, paths, target);
    if ("error" in preview) throw new Error(preview.error);
    await applyRecovery(fs, paths, { target, approval: preview.proposal.digest });

    const read = await readClaimEvents(fs, paths);
    expect(
      isRevoked(read.events, {
        category: "plans",
        correlative: "001",
        name: "plan-alpha.md",
        owner: OWNER,
      }),
    ).toBe(true);
    // Y volver a reclamar el MISMO nombre no resucita el claim revocado: el
    // cerco es del claim, y ese claim ya no puede publicarse nunca.
    const again = await previewRecovery(fs, paths, target);
    expect("error" in again && again.error).toMatch(/no es una reserva/);
  });

  it("un documento publicado no se recupera", async () => {
    mkdirSync(join(workspace, "docs", "plans"), { recursive: true });
    writeFileSync(join(workspace, "docs", "plans", "001-plan-real.md"), "# Plan\n\ncontenido\n");

    const preview = await previewRecovery(fs, paths, "docs/plans/001-plan-real.md");

    expect("error" in preview && preview.error).toMatch(/no es una reserva/);
    expect(existsSync(join(workspace, "docs", "plans", "001-plan-real.md"))).toBe(true);
  });

  it("un documento PUBLICADO no es un slot, aunque sus bytes estén vacíos", async () => {
    // El registro sabe lo que el archivo no puede decir: un publicado con
    // contenido vacío se veía idéntico a un placeholder legacy, y la
    // recuperación lo borraba.
    await claimSlot("plan-alpha.md", OWNER);
    await appendClaimEvent(fs, paths, {
      at: "2026-08-24T00:00:00Z",
      event: "published",
      claim: { category: "plans", correlative: "001", name: "plan-alpha.md", owner: OWNER },
    });
    writeFileSync(join(workspace, "docs", "plans", "001-plan-alpha.md"), "");

    expect((await scanSlots(fs, paths)).slots).toEqual([]);
    const preview = await previewRecovery(fs, paths, "docs/plans/001-plan-alpha.md");
    expect("error" in preview && preview.error).toMatch(/no es una reserva/);
    expect(existsSync(join(workspace, "docs", "plans", "001-plan-alpha.md"))).toBe(true);
  });

  it("un marcador VACIADO sigue siendo la reserva de su dueño, y su recuperación cerca ESE claim", async () => {
    await claimSlot("plan-alpha.md", OWNER);
    const target = "docs/plans/001-plan-alpha.md";
    // Alguien vació el marcador: un editor, un `> archivo`, un checkout.
    writeFileSync(join(workspace, target), "");

    const scan = await scanSlots(fs, paths);
    // No es de nadie sólo porque sus bytes se hayan ido: el ledger dice quién lo tiene.
    expect(scan.slots[0]?.kind).toBe("reservation");
    expect(scan.slots[0]?.owner).toBe(OWNER);
    expect(scan.slots[0]?.intact).toBe(false);

    const preview = await previewRecovery(fs, paths, target);
    if ("error" in preview) throw new Error(preview.error);
    // Bytes inciertos: exige la misma confirmación explícita que un legacy.
    expect(preview.proposal.requires_no_producer_confirmation).toBe(true);
    const applied = await applyRecovery(fs, paths, {
      target,
      approval: preview.proposal.digest,
      noProducerConfirmed: true,
    });
    if ("error" in applied) throw new Error(applied.error);

    // Y el cerco es del claim REAL, no de nadie: sin esto el correlativo volvía
    // al conjunto elegible sin protección para su dueño verdadero.
    const read = await readClaimEvents(fs, paths);
    expect(read.events.map((e) => e.event)).toEqual(["claimed", "revoked", "released"]);
    expect(revokedAmong(read.events, OWNER, [target])).toHaveLength(1);
    expect(openClaimsOf(read.events, OWNER)).toEqual([]);
  });

  it("una recuperación interrumpida tras sellar el cerco se COMPLETA, no se niega para siempre", async () => {
    await claimSlot("plan-alpha.md", OWNER);
    const target = "docs/plans/001-plan-alpha.md";
    // El estado exacto de una interrupción entre los dos registros: cerco
    // sellado, liberación no escrita, archivo todavía en disco.
    await appendClaimEvent(fs, paths, {
      at: "2026-08-24T00:00:00Z",
      event: "revoked",
      claim: { category: "plans", correlative: "001", name: "plan-alpha.md", owner: OWNER },
      cause: "interrumpida",
    });
    expect(existsSync(join(workspace, target))).toBe(true);

    const preview = await previewRecovery(fs, paths, target);
    if ("error" in preview) throw new Error(preview.error);
    // Antes contestaba «ya fue revocado» y aconsejaba justo la operación que
    // negaba: el correlativo quedaba inutilizable en las dos direcciones.
    expect(preview.proposal.resuming).toBe(true);
    const applied = await applyRecovery(fs, paths, {
      target,
      approval: preview.proposal.digest,
      noProducerConfirmed: true,
    });
    if ("error" in applied) throw new Error(applied.error);

    expect(applied.applied.resumed).toBe(true);
    expect(existsSync(join(workspace, target))).toBe(false);
    const read = await readClaimEvents(fs, paths);
    // El cerco NO se duplica: es irrevocable y ya estaba.
    expect(read.events.filter((e) => e.event === "revoked")).toHaveLength(1);
    expect(read.events.map((e) => e.event)).toEqual(["claimed", "revoked", "released"]);
  });

  it("la recuperación corre bajo el candado del workspace", async () => {
    await claimSlot("plan-alpha.md", OWNER);
    const target = "docs/plans/001-plan-alpha.md";
    const preview = await previewRecovery(fs, paths, target);
    if ("error" in preview) throw new Error(preview.error);

    // Con el candado tomado por otro flujo, la recuperación NO puede leer,
    // sellar y borrar por su cuenta: sin él, una publicación sancionada podía
    // pasar su propio cerco, escribir y ser borrada un instante después.
    const held = await acquireLock(paths.cwdLockFile(), fs, { waitMs: 0 });
    try {
      const refused = await applyRecovery(fs, paths, {
        target,
        approval: preview.proposal.digest,
      });
      expect("error" in refused && refused.error).toMatch(/candado/);
      expect(existsSync(join(workspace, target))).toBe(true);
    } finally {
      await held.release();
    }
  });
});
