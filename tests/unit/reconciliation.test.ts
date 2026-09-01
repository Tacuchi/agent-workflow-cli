// El pasado validado conserva su historia y la ejecución sigue sola (F6 del
// plan 032, S033/AC-08 y S033/AC-10).
//
// La tentación es reabrir: destildar la tarea, volver la fase a `pendiente`. Eso
// reescribiría lo que pasó — esas casillas registran que el trabajo se hizo y se
// validó el día que se hizo, y eso sigue siendo verdad. Lo que cambió es que el
// contrato que satisfacía ya no es el vigente. Así que nada histórico se mueve:
// la decisión crea trabajo NUEVO, que lleva el contrato efectivo y no el
// documento del plan, y el plan deja de ser cerrable hasta saldarlo.
//
// Validación de fase de F6, sobre un plan fixture con una fase `validada`.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { noteIndexPath, sealNote } from "../../src/application/decision-note-service.js";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import { PathsService } from "../../src/application/paths-service.js";
import { buildWorklineIndex } from "../../src/application/workline-index-service.js";
import {
  type DecisionNote,
  NOTE_SCHEMA,
  computeNoteDigest,
} from "../../src/domain/decision-note.js";
import {
  type BaselineInput,
  composeEffectiveContract,
} from "../../src/domain/effective-contract.js";
import {
  consumeContinuation,
  newRunState,
  withContinuation,
} from "../../src/domain/flow/run-state.js";
import { baseDigest } from "../../src/domain/proposal.js";
import { checkClosable, reconciliationOf } from "../../src/domain/reconciliation.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";

const SPEC = {
  path: "docs/specs/033-spec-x.md",
  number: "033",
  digest: `sha256:${"1".repeat(64)}`,
};
const PLAN = {
  path: "docs/plans/032-plan-x.md",
  number: "032",
  digest: `sha256:${"2".repeat(64)}`,
};

const BASELINE: BaselineInput = { ...SPEC, criteria: ["S033/AC-01", "S033/AC-02"] };

function note(over: Partial<DecisionNote> = {}): DecisionNote {
  const body: Omit<DecisionNote, "digest"> = {
    schema: NOTE_SCHEMA,
    id: "DEC-001",
    lineage: { spec: SPEC, plan: PLAN, execution: { session: "131-x", phase: "F5" } },
    decision: "el gate se detiene",
    reason: "cierre y no tamaño",
    supersedes_assertions: ["S033/AC-01"],
    supersedes_note: null,
    scope: "functional",
    consumers: [PLAN.path],
    evidence_preserved: [],
    evidence_invalidated: ["F2 · el resultado de la fase validada"],
    obligations: ["revalidar el recorrido PLAN completo"],
    resume_point: "F2/T2.3",
    date: "2026-08-16",
    ...over,
  };
  return { ...body, digest: computeNoteDigest(body) };
}

function reconcile(chain: readonly DecisionNote[]) {
  const composed = composeEffectiveContract(BASELINE, chain);
  if (composed.status !== "composed") {
    throw new Error(`no compone: ${JSON.stringify(composed.failures)}`);
  }
  return reconciliationOf(composed.contract, chain);
}

describe("reconciliationOf — el trabajo compensatorio conserva su causa", () => {
  it("una nota sin obligaciones deja el plan cerrable", () => {
    const r = reconcile([note({ obligations: [] })]);

    expect(r.pending).toEqual([]);
    expect(r.resume_point).toBeNull();
    expect(r.closable).toBe(true);
    expect(checkClosable(r)).toEqual([]);
  });

  it("cada obligación pendiente nombra la nota que la creó y dónde se retoma", () => {
    const r = reconcile([note()]);

    expect(r.pending).toEqual([
      { text: "revalidar el recorrido PLAN completo", by: "DEC-001", resume_point: "F2/T2.3" },
    ]);
    expect(r.closable).toBe(false);
  });

  it("el punto de retorno es la PRIMERA obligación alcanzada, no la más nueva", () => {
    const first = note({ obligations: ["revalidar F2"], resume_point: "F2/T2.3" });
    const second = note({
      id: "DEC-002",
      supersedes_assertions: ["S033/AC-02"],
      obligations: ["revalidar F4"],
      resume_point: "F4/T4.1",
      date: "2026-08-17",
    });

    const r = reconcile([first, second]);

    expect(r.pending.map((o) => o.by)).toEqual(["DEC-001", "DEC-002"]);
    // Retomar en F4 pisaría trabajo que DEC-001 todavía debe.
    expect(r.resume_point).toBe("F2/T2.3");
  });

  it("saldar una obligación es publicar una nota que sustituye a la suya sin arrastrarla", () => {
    const owing = note();
    expect(reconcile([owing]).closable).toBe(false);

    const settled = note({
      id: "DEC-002",
      supersedes_note: "DEC-001",
      decision: "el trabajo compensatorio quedó hecho",
      obligations: [],
      date: "2026-08-17",
    });

    const r = reconcile([owing, settled]);
    expect(r.pending).toEqual([]);
    expect(r.closable).toBe(true);
  });

  it("el rechazo de cierre dice qué se debe y cómo se salda, no sólo que no se puede", () => {
    const failures = checkClosable(reconcile([note()]));

    expect(failures).toHaveLength(1);
    expect(failures[0]?.code).toBe("RECONCILIATION_PENDING");
    expect(failures[0]?.message).toContain("revalidar el recorrido PLAN completo");
    expect(failures[0]?.action).toContain("F2/T2.3");
    expect(failures[0]?.action).toContain("sustituya");
  });
});

describe("continuidad acotada: mueve la posición en el PLAN, nunca el cursor", () => {
  it("apunta a la primera obligación y no toca applied, skipped ni boundary", () => {
    const before = newRunState("plan-exec", "131-x");
    const after = withContinuation(before, reconcile([note()]));

    expect(after.continuation).toEqual({ resume_point: "F2/T2.3", by: "DEC-001" });
    // Lo que NO se movió: el recorrido sigue siendo una pasada lineal.
    expect(after.applied).toEqual(before.applied);
    expect(after.skipped).toEqual(before.skipped);
    expect(after.boundary).toBe(before.boundary);
    expect(after.attempts).toEqual(before.attempts);
  });

  it("una reconciliación sin nada pendiente limpia la continuidad sola", () => {
    const owing = withContinuation(newRunState("plan-exec", "131-x"), reconcile([note()]));
    expect(owing.continuation).not.toBeNull();

    const settled = withContinuation(owing, reconcile([note({ obligations: [] })]));
    expect(settled.continuation).toBeNull();
  });

  it("re-apuntar a la MISMA obligación no re-sella el estado", () => {
    const first = withContinuation(newRunState("plan-exec", "131-x"), reconcile([note()]));
    const again = withContinuation(first, reconcile([note()]));

    expect(again).toBe(first);
  });

  it("consumir la continuidad la borra sin tocar el cursor", () => {
    const owing = withContinuation(newRunState("plan-exec", "131-x"), reconcile([note()]));
    const consumed = consumeContinuation(owing);

    expect(consumed.continuation).toBeNull();
    expect(consumed.applied).toEqual(owing.applied);
    expect(consumed.digest).not.toBe(owing.digest);
    // Consumir dos veces no hace nada la segunda.
    expect(consumeContinuation(consumed)).toBe(consumed);
  });
});

describe("sobre un plan fixture con una fase validada", () => {
  let root: string;
  let fs: NodeFileSystem;
  let env: FakeEnv;
  let paths: PathsService;

  const SPEC_TEXT = [
    "# 033 — spec fixture",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] **S033/AC-01 — una.** texto",
    "- [ ] **S033/AC-02 — otra.** texto",
    "",
  ].join("\n");

  /** Un plan CERRADO: declara done, todas las casillas y su fase validada. */
  const planText = (specDigest: string): string =>
    [
      "# 032 — plan fixture",
      "",
      "> Derived from: docs/specs/033-spec-x.md",
      `> Baseline: docs/specs/033-spec-x.md@${specDigest}`,
      "> Estado: done",
      "> Cierre: cerrado tras validar su única fase",
      "",
      "## Tasks",
      "",
      "### F1 — la única fase",
      "> Estado: validada",
      "",
      "**Trabajo:**",
      "- [x] T1.1 — el trabajo que se hizo y se validó",
      "",
    ].join("\n");

  const board = () => buildWorklineIndex(fs, env, paths, { now: new Date("2026-08-16T12:00:00Z") });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reconc-board-"));
    fs = new NodeFileSystem();
    env = new FakeEnv(root, root);
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "decisions"), { recursive: true });
    writeFileSync(join(root, "docs/specs/033-spec-x.md"), SPEC_TEXT);
    writeFileSync(
      join(root, "docs/plans/032-plan-x.md"),
      planText(`sha256:${baseDigest(SPEC_TEXT)}`),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Publica una cadena con UNA nota que invalida el resultado de F1. */
  const publishNote = (obligations: readonly string[]): DecisionNote => {
    const index = {
      schema: "workline.decision-index/v1" as const,
      spec: { path: "docs/specs/033-spec-x.md", number: "033" },
      notes: [] as DecisionNote[],
    };
    const sealed = sealNote(index, {
      schema: NOTE_SCHEMA,
      lineage: {
        spec: {
          path: "docs/specs/033-spec-x.md",
          number: "033",
          // Lo que pinea el servicio real: el digest FUNCIONAL. El plan de al
          // lado sigue sellado byte-exacto (legado) y la composición casa igual.
          digest: functionalSpecDigest(SPEC_TEXT),
        },
        plan: {
          path: "docs/plans/032-plan-x.md",
          number: "032",
          digest: `sha256:${baseDigest(planText(`sha256:${baseDigest(SPEC_TEXT)}`))}`,
        },
        execution: { session: "131-x", phase: "F1" },
      },
      decision: "el resultado de F1 ya no satisface el contrato",
      reason: "la afirmación que probaba cambió",
      supersedes_assertions: ["S033/AC-01"],
      supersedes_note: null,
      scope: "functional",
      consumers: ["docs/plans/032-plan-x.md"],
      evidence_preserved: [],
      evidence_invalidated: ["F1/T1.1"],
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

  it("sin ninguna nota, el plan cerrado se lee done", async () => {
    const plans = (await board()).plans;
    const plan = plans.find((p) => p.number === "032");

    expect(plan?.plan_state).toBe("done");
    expect(plan?.reconciliation).toEqual({ pending: [], resume_point: null, closable: true });
  });

  it("una nota con obligación abierta impide declarar el plan cerrable", async () => {
    publishNote(["revalidar F1 contra el contrato nuevo"]);
    const plan = (await board()).plans.find((p) => p.number === "032");

    // El documento dice `done` y el contrato dice que no: eso es `inconsistent`.
    expect(plan?.plan_state).toBe("inconsistent");
    expect(plan?.reconciliation?.closable).toBe(false);
    expect(plan?.reconciliation?.pending).toEqual([
      { text: "revalidar F1 contra el contrato nuevo", by: "DEC-001", resume_point: "F1/T1.1" },
    ]);
    expect(plan?.reconciliation?.resume_point).toBe("F1/T1.1");
  });

  it("la fase sigue VALIDADA y su casilla marcada: no se destilda ni se edita nada", async () => {
    const before = readFileSync(join(root, "docs/plans/032-plan-x.md"), "utf8");
    publishNote(["revalidar F1 contra el contrato nuevo"]);
    const plan = (await board()).plans.find((p) => p.number === "032");

    expect(plan?.phases_validated).toBe(1);
    expect(plan?.phases_total).toBe(1);
    expect(plan?.tasks_done).toBe(1);
    expect(plan?.tasks_total).toBe(1);
    // Y el documento es byte-idéntico: leer el tablero no reescribe la historia.
    expect(readFileSync(join(root, "docs/plans/032-plan-x.md"), "utf8")).toBe(before);
  });

  it("una nota SIN obligaciones no bloquea el cierre: lo que gatea es la compensación", async () => {
    publishNote([]);
    const plan = (await board()).plans.find((p) => p.number === "032");

    expect(plan?.reconciliation?.closable).toBe(true);
    expect(plan?.plan_state).toBe("done");
  });
});
