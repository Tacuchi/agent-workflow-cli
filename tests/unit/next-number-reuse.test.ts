import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  appendClaimEvent,
  eligibleCorrelatives,
  readClaimEvents,
} from "../../src/application/claims-ledger.js";
import { applyRecovery, previewRecovery } from "../../src/application/claims-recovery.js";
import { runNextNumber } from "../../src/application/dev-only-services.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runSessionClose } from "../../src/application/session-close-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

/**
 * The correlative that came back.
 *
 * Minting computed `max + 1` and probed FORWARD only, so a number released in the
 * middle of the range was lost for good — this project's own `docs/plans` still
 * carries a permanent hole at `033` from exactly that. The disk cannot tell a
 * number that was given back from one that never existed; only the ledger can.
 */
const OWNER = "201-alpha-plan-new";
const OTHER = "202-beta-plan-new";

describe("reutilización determinista de correlativos liberados", () => {
  let workspace: string;
  let env: FakeEnv;
  let paths: PathsService;
  let fs: NodeFileSystem;
  const plans = (): string[] => readdirSync(join(workspace, "docs", "plans")).sort();

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "next-number-reuse-"));
    env = new FakeEnv(workspace, workspace);
    paths = new PathsService(normalizeNamespace("workflow"), workspace, workspace);
    fs = new NodeFileSystem();
    mkdirSync(join(workspace, ".workflow", "sessions"), { recursive: true });
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  const session = (folder: string): void => {
    const dir = join(workspace, ".workflow", "sessions", folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SESSION.md"), "# SESSION — x\n\n## Objective\nx\n");
  };
  const claim = async (name: string, owner: string) =>
    await runNextNumber(fs, env, paths, { directory: "docs/plans", claim: { name, owner } });

  it("un correlativo intermedio liberado vuelve, en lugar de crecer el rango", async () => {
    session(OWNER);
    session(OTHER);
    await claim("plan-uno.md", OTHER);
    const middle = await claim("plan-dos.md", OWNER);
    await claim("plan-tres.md", OTHER);
    expect(middle.next).toBe("002");

    // El dueño del 002 cierra sin publicar: su correlativo vuelve al conjunto.
    const closed = await runSessionClose(fs, paths, { code: "201" });
    if (!("sessionClose" in closed)) throw new Error("esperaba cerrar la sesión");
    expect(closed.sessionClose.reservations_released).toEqual(["docs/plans/002-plan-dos.md"]);
    expect(plans()).toEqual(["001-plan-uno.md", "003-plan-tres.md"]);

    session("203-gamma-plan-new");
    const reused = await claim("plan-cuatro.md", "203-gamma-plan-new");

    // Antes daba 004 y el 002 quedaba como hueco permanente.
    expect(reused.next).toBe("002");
    expect(plans()).toEqual(["001-plan-uno.md", "002-plan-cuatro.md", "003-plan-tres.md"]);
  });

  it("un correlativo PUBLICADO nunca entra al conjunto elegible", async () => {
    const claimIdentity = {
      category: "plans",
      correlative: "007",
      name: "plan-x.md",
      owner: OWNER,
    };
    await appendClaimEvent(fs, paths, {
      at: "2026-08-24T00:00:00Z",
      event: "claimed",
      claim: claimIdentity,
    });
    await appendClaimEvent(fs, paths, {
      at: "2026-08-24T01:00:00Z",
      event: "published",
      claim: claimIdentity,
    });

    const events = (await readClaimEvents(fs, paths)).events;
    expect(eligibleCorrelatives(events, "plans")).toEqual([]);
  });

  it("liberar, reclamar de nuevo y publicar deja el correlativo gastado, no elegible", async () => {
    const at = (h: number) => `2026-08-24T0${h}:00:00Z`;
    const base = { category: "plans", correlative: "005", name: "plan-x.md" };
    await appendClaimEvent(fs, paths, {
      at: at(0),
      event: "claimed",
      claim: { ...base, owner: OWNER },
    });
    await appendClaimEvent(fs, paths, {
      at: at(1),
      event: "released",
      claim: { ...base, owner: OWNER },
    });
    expect(eligibleCorrelatives((await readClaimEvents(fs, paths)).events, "plans")).toEqual([
      "005",
    ]);

    // Otro lo toma y lo publica: el último hecho terminal manda.
    await appendClaimEvent(fs, paths, {
      at: at(2),
      event: "claimed",
      claim: { ...base, owner: OTHER },
    });
    await appendClaimEvent(fs, paths, {
      at: at(3),
      event: "published",
      claim: { ...base, owner: OTHER },
    });

    expect(eligibleCorrelatives((await readClaimEvents(fs, paths)).events, "plans")).toEqual([]);
  });

  it("el orden es numérico y por categoría, no lexicográfico ni global", async () => {
    const rec = async (category: string, correlative: string, event: "released" | "published") => {
      await appendClaimEvent(fs, paths, {
        at: "2026-08-24T00:00:00Z",
        event: "claimed",
        claim: { category, correlative, name: "x.md", owner: OWNER },
      });
      await appendClaimEvent(fs, paths, {
        at: "2026-08-24T01:00:00Z",
        event,
        claim: { category, correlative, name: "x.md", owner: OWNER },
      });
    };
    await rec("plans", "010", "released");
    await rec("plans", "009", "released");
    await rec("plans", "002", "released");
    // Ancho distinto: es el único caso donde numérico y lexicográfico difieren,
    // y el que hace que esta prueba diga algo. `.sort()` pondría "1000" ANTES de
    // "999", porque compara carácter por carácter.
    await rec("plans", "1000", "released");
    await rec("plans", "999", "released");
    await rec("specs", "004", "released");

    const events = (await readClaimEvents(fs, paths)).events;
    expect(eligibleCorrelatives(events, "plans")).toEqual(["002", "009", "010", "999", "1000"]);
    // Y la categoría no se mezcla: un specs liberado no es un plans elegible.
    expect(eligibleCorrelatives(events, "specs")).toEqual(["004"]);
  });

  it("un correlativo liberado pero ya tomado en disco se saltea", async () => {
    session(OWNER);
    const held = await claim("plan-dos.md", OWNER);
    expect(held.next).toBe("001");
    const closed = await runSessionClose(fs, paths, { code: "201" });
    if (!("sessionClose" in closed)) throw new Error("esperaba cerrar la sesión");

    // El ledger dice que 001 volvió, pero alguien escribió un documento ahí.
    writeFileSync(join(workspace, "docs", "plans", "001-plan-ajeno.md"), "# Plan\n\ncontenido\n");
    session(OTHER);
    const minted = await claim("plan-nuevo.md", OTHER);

    // El registro contesta «volvió»; el disco contesta «está tomado». Manda el disco.
    expect(minted.next).toBe("002");
  });

  it("ocho reclamos concurrentes reciben ocho correlativos distintos", async () => {
    for (let i = 0; i < 8; i++) session(`30${i}-flujo-plan-new`);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        runNextNumber(fs, env, paths, {
          directory: "docs/plans",
          claim: { name: `plan-${i}.md`, owner: `30${i}-flujo-plan-new` },
        }),
      ),
    );

    expect(new Set(results.map((r) => r.next)).size).toBe(8);
    expect(new Set(results.map((r) => r.claimed_path)).size).toBe(8);
    expect(plans()).toHaveLength(8);
    // Y cada reserva dejó su registro: ocho claims, ninguno perdido.
    const events = (await readClaimEvents(fs, paths)).events;
    expect(events.filter((e) => e.event === "claimed")).toHaveLength(8);
  });

  it("un correlativo recuperado NO se re-entrega con la misma clave cercada", async () => {
    session(OWNER);
    const first = await claim("plan-x.md", OWNER);
    expect(first.next).toBe("001");
    const target = "docs/plans/001-plan-x.md";
    const preview = await previewRecovery(fs, paths, target);
    if ("error" in preview) throw new Error(preview.error);
    await applyRecovery(fs, paths, { target, approval: preview.proposal.digest });

    // Mismo dueño, mismo nombre. El 001 volvió al conjunto elegible, pero su
    // clave `plans/001-plan-x.md@OWNER` quedó cercada para siempre: entregarla
    // otra vez daba una reserva que el punto de publicación rechaza, o sea un
    // slot imposible de completar y sin salida que ningún mensaje sugería.
    const again = await claim("plan-x.md", OWNER);

    expect(again.next).not.toBe("001");
    expect(again.claimed_path).toContain("002-plan-x.md");
  });
});
