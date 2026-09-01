// `status` y `resume` dicen la verdad sobre el contrato efectivo (F7 del plan
// 032, S033/AC-09 y S033/AC-11).
//
// La superficie de lectura es donde una reconciliación pendiente se vuelve
// invisible más fácil: los contadores del plan cuadran, la fase está validada, y
// ofrecer «continuar por la primera fase no validada» manda a alguien a ejecutar
// contra un contrato que ya no rige. Y al revés: decir «sus contadores no lo
// respaldan» sobre un plan que sí los tiene cuadrados manda a reparar un
// documento sano.
//
// Validación de fase de F7, sobre fixtures del índice.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { noteIndexPath, sealNote } from "../../src/application/decision-note-service.js";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import { PathsService } from "../../src/application/paths-service.js";
import { runResume } from "../../src/application/resume-service.js";
import { buildWorklineIndex, specConsumers } from "../../src/application/workline-index-service.js";
import { type DecisionNote, NOTE_SCHEMA } from "../../src/domain/decision-note.js";
import { baseDigest } from "../../src/domain/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const SPEC_FILE = "docs/specs/033-spec-x.md";
const PLAN_FILE = "docs/plans/032-plan-x.md";

const SPEC_TEXT = [
  "# 033 — spec fixture",
  "",
  "## Acceptance criteria",
  "",
  "- [ ] **S033/AC-01 — una.** texto",
  "- [ ] **S033/AC-02 — otra.** texto",
  "",
].join("\n");

/** El sello LEGADO: los bytes exactos, que es lo que estos planes ya llevaban. */
const SPEC_DIGEST = `sha256:${baseDigest(SPEC_TEXT)}`;
/** Lo que pinea toda nota nueva, y lo que el tablero reporta como alineado. */
const SPEC_FUNCTIONAL = functionalSpecDigest(SPEC_TEXT);

/** Un plan ABIERTO con una fase validada y otra pendiente. */
function planText(seal: string | null): string {
  return [
    "# 032 — plan fixture",
    "",
    "> Derived from: docs/specs/033-spec-x.md",
    ...(seal === null ? [] : [`> Baseline: ${SPEC_FILE}@${seal}`]),
    "> Estado: open",
    "",
    "## Tasks",
    "",
    "### F1 — la fase cerrada",
    "> Estado: validada",
    "",
    "**Trabajo:**",
    "- [x] T1.1 — el trabajo que se hizo y se validó",
    "",
    "### F2 — la fase que falta",
    "> Estado: pendiente",
    "",
    "**Trabajo:**",
    "- [ ] T2.1 — lo que queda",
    "",
  ].join("\n");
}

describe("F7 — el contrato efectivo llega a las superficies", () => {
  let root: string;
  let fs: NodeFileSystem;
  let env: FakeEnv;
  let paths: PathsService;

  const board = () => buildWorklineIndex(fs, env, paths, { now: new Date("2026-08-16T12:00:00Z") });
  /** La propuesta que `resume` hace para el plan fixture, sea cual sea la vía. */
  const resumeNext = async (): Promise<string> => {
    const outcome = await runResume(fs, env, paths, {
      target: PLAN_FILE,
      now: new Date("2026-08-16T12:00:00Z"),
    });
    if (outcome.status !== "proposal") {
      throw new Error(`esperaba una propuesta, vino ${outcome.status}: ${JSON.stringify(outcome)}`);
    }
    expect(outcome.proposal.file).toBe(PLAN_FILE);
    return outcome.proposal.next;
  };
  const planOf = async () => (await board()).plans.find((p) => p.number === "032");

  const seed = (seal: string | null): void => {
    writeFileSync(join(root, SPEC_FILE), SPEC_TEXT);
    writeFileSync(join(root, PLAN_FILE), planText(seal));
  };

  /** Publica una nota vigente sobre el linaje, con las obligaciones dadas. */
  const publishNote = (obligations: readonly string[]): DecisionNote => {
    const index = {
      schema: "workline.decision-index/v1" as const,
      spec: { path: SPEC_FILE, number: "033" },
      notes: [] as DecisionNote[],
    };
    const sealed = sealNote(index, {
      schema: NOTE_SCHEMA,
      lineage: {
        spec: { path: SPEC_FILE, number: "033", digest: SPEC_FUNCTIONAL },
        plan: {
          path: PLAN_FILE,
          number: "032",
          digest: `sha256:${baseDigest(planText(SPEC_DIGEST))}`,
        },
        execution: { session: "131-x", phase: "F1" },
      },
      decision: "F1 ya no satisface el contrato",
      reason: "la afirmación que probaba cambió",
      supersedes_assertions: ["S033/AC-01"],
      supersedes_note: null,
      scope: "functional",
      consumers: [PLAN_FILE],
      evidence_preserved: ["F1/T1.1 como historia"],
      evidence_invalidated: ["F1/T1.1 como prueba"],
      obligations: [...obligations],
      resume_point: "F1/T1.1",
      date: "2026-08-16",
    });
    writeFileSync(
      join(root, noteIndexPath("docs/decisions", "033", "x")),
      `${JSON.stringify({ ...index, notes: [sealed] }, null, 2)}\n`,
    );
    return sealed;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "contract-surfaces-"));
    fs = new NodeFileSystem();
    env = new FakeEnv(root, root);
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "decisions"), { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe("T7.1 — status proyecta contrato, notas y reconciliación", () => {
    it("un plan con nota vigente muestra su contrato efectivo y qué afirmación quedó enmendada", async () => {
      seed(SPEC_DIGEST);
      publishNote(["revalidar F1"]);
      const plan = await planOf();

      expect(plan?.contract?.applied).toEqual(["DEC-001"]);
      expect(plan?.contract?.assertions).toEqual([
        { id: "S033/AC-01", state: "amended", by: "DEC-001" },
        { id: "S033/AC-02", state: "baseline", by: null },
      ]);
      expect(plan?.contract?.evidence_invalidated).toEqual(["F1/T1.1 como prueba"]);
    });

    it("y su reconciliación pendiente, con la obligación y dónde se retoma", async () => {
      seed(SPEC_DIGEST);
      publishNote(["revalidar F1"]);
      const plan = await planOf();

      expect(plan?.reconciliation).toEqual({
        pending: [{ text: "revalidar F1", by: "DEC-001", resume_point: "F1/T1.1" }],
        resume_point: "F1/T1.1",
        closable: false,
      });
    });

    it("un plan sin sello no tiene contra qué componer, y no inventa un contrato vacío", async () => {
      seed(null);
      publishNote(["revalidar F1"]);
      const plan = await planOf();

      expect(plan?.baseline.status).toBe("unsealed");
      expect(plan?.contract).toBeNull();
      expect(plan?.reconciliation).toBeNull();
    });
  });

  describe("T7.2 — resume no ofrece ejecutar ni cerrar contra un contrato que no rige", () => {
    it("propone saldar la obligación, con su causa y su punto de retorno", async () => {
      seed(SPEC_DIGEST);
      publishNote(["revalidar F1 contra el contrato nuevo"]);
      const next = await resumeNext();

      expect(next).toContain("RECONCILIACIÓN PENDIENTE por DEC-001");
      expect(next).toContain("revalidar F1 contra el contrato nuevo");
      expect(next).toContain("retomá en F1/T1.1");
      expect(next).toContain("ni ejecutable ni cerrable");
    });

    it("sin obligación abierta vuelve a proponer la primera fase no validada", async () => {
      seed(SPEC_DIGEST);
      publishNote([]);
      const next = await resumeNext();

      expect(next).toBe("continuar por la primera fase no validada");
    });

    it("una compensación abierta NO se reporta como contadores rotos: el documento está sano", async () => {
      seed(SPEC_DIGEST);
      publishNote(["revalidar F1"]);
      const next = await resumeNext();

      expect(next).not.toContain("repararlo a mano");
      expect(next).not.toContain("contadores");
    });
  });

  describe("T7.3 — cada consumidor se lee alineado, pendiente o histórico", () => {
    it("alineado: sellado sobre el baseline vigente y sin nada que deber", async () => {
      seed(SPEC_DIGEST);
      const [consumer] = specConsumers("033", (await board()).plans);

      expect(consumer?.standing).toBe("aligned");
      expect(consumer?.alignment.status).toBe("aligned");
    });

    it("con reconciliación pendiente: ningún consumidor abierto se presenta como alineado", async () => {
      seed(SPEC_DIGEST);
      publishNote(["revalidar F1"]);
      const [consumer] = specConsumers("033", (await board()).plans);

      expect(consumer?.standing).toBe("pending-reconciliation");
      expect(consumer?.plan_state).toBe("open");
    });

    it("histórico: un plan cerrado es historia, y la historia no se reconcilia hacia adelante", async () => {
      writeFileSync(join(root, SPEC_FILE), SPEC_TEXT);
      writeFileSync(
        join(root, PLAN_FILE),
        [
          "# 032 — plan cerrado",
          "",
          "> Derived from: docs/specs/033-spec-x.md",
          `> Baseline: ${SPEC_FILE}@${SPEC_DIGEST}`,
          "> Estado: done",
          "> Cierre: cerrado",
          "",
          "## Tasks",
          "",
          "### F1 — la única fase",
          "> Estado: validada",
          "",
          "**Trabajo:**",
          "- [x] T1.1 — hecho",
          "",
        ].join("\n"),
      );
      const [consumer] = specConsumers("033", (await board()).plans);

      expect(consumer?.standing).toBe("historical");
    });

    it("sin sello es `unproven`: no se afirma alineado ni se lo trata como derivado", async () => {
      seed(null);
      const [consumer] = specConsumers("033", (await board()).plans);

      expect(consumer?.standing).toBe("unproven");
      expect(consumer?.standing).not.toBe("aligned");
    });
  });

  describe("T7.4 — un plan legacy sin sello se declara compatible", () => {
    it("resume no lo llama alineado, pero sí permite ejecutarlo en modo compatible", async () => {
      seed(null);
      const next = await resumeNext();

      expect(next).toBe("continuar por la primera fase no validada");
    });

    it("un sello que ya no coincide se reporta divergente con los dos digests", async () => {
      seed(SPEC_DIGEST);
      writeFileSync(join(root, SPEC_FILE), `${SPEC_TEXT}- [ ] **S033/AC-03 — nueva.** texto\n`);
      const next = await resumeNext();

      expect(next).toContain("BASELINE DIVERGENTE");
      expect(next).toContain(SPEC_DIGEST);
    });

    it("un plan alineado NO se degrada: la advertencia aparece sólo cuando corresponde", async () => {
      seed(SPEC_DIGEST);
      const next = await resumeNext();

      expect(next).not.toContain("SIN SELLO");
      expect(next).not.toContain("DIVERGENTE");
      expect(next).toBe("continuar por la primera fase no validada");
    });
  });
});
