// El saldo del cierre (plan 042 · F2 · S042/AC-01, AC-05, AC-09 y AC-12).
//
// El incidente que originó todo esto: un plan con 17/17 tareas y 6/6 fases
// validadas quedó «ni ejecutable ni cerrable» porque su nota cargaba dos
// obligaciones sin clase —una ya cumplida y un traspaso que el propio plan
// declaraba— y el cierre rechazaba recetando un remedio que el recorrido ya no
// podía alcanzar: publicá una nota que sustituya a la que lo creó. La única
// salida fue escribir el índice desde fuera del flow.
//
// Lo que se fija acá:
//
// 1. La nota de saldo se DERIVA, no se redacta: arrastra todo lo de la nota
//    portadora y suelta sólo lo saldado, porque la sustitución es por nota
//    entera y soltar una obligación de otro modo des-amenda sus criterios.
// 2. Las tres filas del tramo se saltan SOLAS cuando el plan no debe
//    compensación: un cierre limpio tiene exactamente las fronteras que tenía.
// 3. La pregunta existe para un solo caso —una obligación cuya clase nadie
//    declaró y que el plan no enumera— y recomienda la lectura que el agente
//    propuso.
// 4. Una compensación que sigue pendiente deja la frontera de autoría abierta y
//    NO gasta intento: decir la verdad no puede costarle sus reintentos.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  noteIndexArtifact,
  noteIndexPath,
  sealNote,
} from "../../src/application/decision-note-service.js";
import { advanceFlowRun } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { internalActionExecutor } from "../../src/application/flow/internal-actions.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { functionalSpecDigest } from "../../src/application/parsers/spec-functional.js";
import { PathsService } from "../../src/application/paths-service.js";
import { inferPlanExecBatch } from "../../src/application/plan-exec-batch-service.js";
import { settlePlanExecObligations } from "../../src/application/plan-exec-decision-service.js";
import {
  type DecisionNote,
  NOTE_SCHEMA,
  computeNoteDigest,
  normalizeObligations,
  validateDecisionNote,
} from "../../src/domain/decision-note.js";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  INTERNAL_ACTION_OPERATIONS,
  INTERNAL_OPERATION_EFFECTS,
  actionOf,
  alternativesOf,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";
import {
  FLOW_RUN_STATE_FILE,
  type FlowSettlement,
  PLAN_EXEC_BATCH_LOOP_TRANSITIONS,
  applyTransition,
  newRunState,
  serializeRunState,
  settlementAmbiguous,
  settlementOwed,
  withPlanExecBatch,
  withScope,
  withSettlement,
  withSettlementDeclarations,
} from "../../src/domain/flow/run-state.js";
import { baseDigest } from "../../src/domain/proposal.js";
import { deriveSettlementNote } from "../../src/domain/settlement.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";

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
const AT = { session: "167-x-plan-exec", phase: "cierre", date: "2026-09-03" };

function note(over: Partial<DecisionNote> = {}): DecisionNote {
  const body: Omit<DecisionNote, "digest"> = {
    schema: NOTE_SCHEMA,
    id: "DEC-001",
    lineage: { spec: SPEC, plan: PLAN, execution: { session: "131-x", phase: "F5" } },
    decision: "el gate compone en vez de escalar",
    reason: "las cuatro condiciones cerraron",
    supersedes_assertions: ["S033/AC-01"],
    supersedes_note: null,
    scope: "functional",
    consumers: [PLAN.path],
    evidence_preserved: ["F1/T1.1 como historia"],
    evidence_invalidated: ["F1/T1.1 como prueba"],
    obligations:
      normalizeObligations([
        { text: "revalidar el recorrido PLAN completo", kind: "compensation" },
        { text: "Producto y QA validan el flujo nuevo", kind: "handoff" },
      ]) ?? [],
    resume_point: "F2/T2.3",
    date: "2026-08-16",
    ...over,
  };
  return { ...body, digest: computeNoteDigest(body) };
}

describe("la nota de saldo arrastra todo salvo lo saldado", () => {
  it("suelta la obligación cumplida y conserva el resto de la nota entera", () => {
    const carrier = note();
    const derived = deriveSettlementNote(
      carrier,
      [{ note: "DEC-001", index: 0, outcome: "settled", evidence: "npm test 4775 en verde" }],
      AT,
    );

    expect(derived.ok).toBe(true);
    if (!derived.ok || derived.draft === null) throw new Error("esperaba un sucesor");
    // Lo que arrastra, que es todo lo que la sustitución por nota entera se
    // llevaría puesto si no viajara: sin esto, soltar una obligación
    // des-amendaría los criterios que la original amendó.
    expect(derived.draft.supersedes_note).toBe("DEC-001");
    expect(derived.draft.decision).toBe(carrier.decision);
    expect(derived.draft.reason).toBe(carrier.reason);
    expect(derived.draft.supersedes_assertions).toEqual(["S033/AC-01"]);
    expect(derived.draft.scope).toBe("functional");
    expect(derived.draft.consumers).toEqual([PLAN.path]);
    expect(derived.draft.evidence_invalidated).toEqual(["F1/T1.1 como prueba"]);
    // Lo que suelta, y la evidencia del saldo entra donde va lo que sigue valiendo.
    expect(derived.draft.obligations.map((o) => o.text)).toEqual([
      "Producto y QA validan el flujo nuevo",
    ]);
    expect(derived.draft.evidence_preserved).toEqual([
      "F1/T1.1 como historia",
      "npm test 4775 en verde",
    ]);
    expect(derived.settled).toEqual(["revalidar el recorrido PLAN completo"]);
  });

  it("reconocer un traspaso reclasifica la obligación sin soltarla", () => {
    const derived = deriveSettlementNote(
      note(),
      [{ note: "DEC-001", index: 0, outcome: "handoff" }],
      AT,
    );

    expect(derived.ok).toBe(true);
    if (!derived.ok || derived.draft === null) throw new Error("esperaba un sucesor");
    expect(derived.draft.obligations[0]).toEqual({
      text: "revalidar el recorrido PLAN completo",
      kind: "handoff",
      declared: true,
    });
    expect(derived.settled).toEqual([]);
  });

  it("la sesión y la fase salen del contexto del saldo, no de la nota portadora", () => {
    const derived = deriveSettlementNote(
      note(),
      [{ note: "DEC-001", index: 0, outcome: "handoff" }],
      AT,
    );
    if (!derived.ok || derived.draft === null) throw new Error("esperaba un sucesor");

    expect(derived.draft.lineage.execution).toEqual({ session: AT.session, phase: "cierre" });
    // El linaje documental, en cambio, es el de la nota que sustituye.
    expect(derived.draft.lineage.spec).toEqual(SPEC);
    expect(derived.draft.lineage.plan).toEqual(PLAN);
  });

  it("un saldo que no cambia nada no publica: la cadena no crece por reintentar", () => {
    const derived = deriveSettlementNote(
      note(),
      [{ note: "DEC-001", index: 0, outcome: "pending" }],
      AT,
    );

    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.draft).toBeNull();
  });

  it("un saldo sobre otra nota no toca ésta", () => {
    const derived = deriveSettlementNote(
      note(),
      [{ note: "DEC-009", index: 0, outcome: "settled", evidence: "otra cosa" }],
      AT,
    );

    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(derived.draft).toBeNull();
  });

  const refusals: Array<[string, Parameters<typeof deriveSettlementNote>[1], string]> = [
    [
      "una posición que la nota no tiene",
      [{ note: "DEC-001", index: 7, outcome: "handoff" }],
      "SETTLEMENT_OBLIGATION_ABSENT",
    ],
    [
      "dos saldos para la misma obligación",
      [
        { note: "DEC-001", index: 0, outcome: "handoff" },
        { note: "DEC-001", index: 0, outcome: "pending" },
      ],
      "SETTLEMENT_OBLIGATION_REPEATED",
    ],
    [
      "cumplida sin decir qué lo prueba",
      [{ note: "DEC-001", index: 0, outcome: "settled" }],
      "SETTLEMENT_EVIDENCE_MISSING",
    ],
    [
      "evidencia sobre algo que no se declaró cumplido",
      [{ note: "DEC-001", index: 0, outcome: "handoff", evidence: "algo" }],
      "SETTLEMENT_EVIDENCE_UNEXPECTED",
    ],
  ];

  it.each(refusals)("rechaza %s con %s", (_name, settlements, code) => {
    const derived = deriveSettlementNote(note(), settlements, AT);

    expect(derived.ok).toBe(false);
    if (derived.ok) return;
    expect(derived.failures.map((f) => f.code)).toContain(code);
    expect(derived.failures.every((f) => f.action.length > 0)).toBe(true);
  });
});

describe("las tres filas del tramo se saltan solas cuando no hay nada que saldar", () => {
  const JOURNEY = journeyOfFlow("plan-exec");
  const at = (id: string): number => JOURNEY.findIndex((row: FlowDecision) => row.id === id);

  /** Una corrida parada exactamente donde empieza el cierre. */
  const atClosure = (settlement: FlowSettlement) => {
    let state = withScope(newRunState("plan-exec", "167-x-plan-exec"), {
      plan: PLAN.path,
      sources: ["agent-workflow-cli"],
    });
    for (const row of JOURNEY.slice(0, at("plan-exec.settlement-authoring"))) {
      state = applyTransition(state, row.id);
    }
    return withSettlement(state, settlement);
  };

  const owed = (over: Partial<FlowSettlement> = {}): FlowSettlement => ({
    compensations: [],
    handoffs: [],
    ...over,
  });

  const COMPENSATION = {
    note: "DEC-001",
    index: 0,
    text: "revalidar el recorrido PLAN completo",
    legacy: false,
  };

  it("sin compensación vigente el cierre llega directo a la validación final", () => {
    const advanced = advanceFlowRun({ state: atClosure(owed()), journey: JOURNEY });

    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.directive.boundary.transition).toBe("plan-exec.final-validation");
    // Y las tres quedan registradas como saltadas CON SU MOTIVO: un avance
    // silencioso dejaría la traza afirmando una decisión que nadie tomó.
    expect(advanced.state.skipped).toEqual(
      expect.arrayContaining([
        "plan-exec.settlement-authoring",
        "plan-exec.settlement-question",
        "plan-exec.settlement-publication",
      ]),
    );
  });

  it("con un traspaso vigente y ninguna compensación, tampoco se abre nada", () => {
    const state = atClosure(
      owed({ handoffs: [{ ...COMPENSATION, text: "Producto y QA validan el flujo" }] }),
    );

    expect(settlementOwed(state)).toBe(false);
    const advanced = advanceFlowRun({ state, journey: JOURNEY });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.directive.boundary.transition).toBe("plan-exec.final-validation");
  });

  it("con una compensación vigente el cierre se detiene en la autoría del saldo", () => {
    const advanced = advanceFlowRun({
      state: atClosure(owed({ compensations: [COMPENSATION] })),
      journey: JOURNEY,
    });

    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.directive.boundary.transition).toBe("plan-exec.settlement-authoring");
    expect(advanced.directive.boundary.authority).toBe("agent");
    // El contrato dice la forma exacta ANTES del primer intento.
    expect(advanced.directive.request?.contract).toContain("decisions.settlement");
    expect(advanced.directive.request?.contract).toContain("evidence");
  });

  it("una obligación con una sola lectura no abre la pregunta humana", () => {
    let state = atClosure(owed({ compensations: [COMPENSATION] }));
    state = withSettlementDeclarations(state, [
      { note: "DEC-001", index: 0, outcome: "settled", evidence: "npm test en verde" },
    ]);
    state = applyTransition(state, "plan-exec.settlement-authoring");

    expect(settlementAmbiguous(state)).toEqual([]);
    const advanced = advanceFlowRun({ state, journey: JOURNEY });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    // Salta la pregunta y se para en la publicación, que es del CLI.
    expect(advanced.state.skipped).toContain("plan-exec.settlement-question");
    expect(advanced.directive.boundary.transition).toBe("plan-exec.settlement-publication");
  });

  it("una obligación legada sin correspondencia SÍ la abre, con la lectura propuesta arriba", () => {
    const legacy = { ...COMPENSATION, legacy: true };
    let state = atClosure(owed({ compensations: [legacy] }));
    state = withSettlementDeclarations(state, [{ note: "DEC-001", index: 0, outcome: "handoff" }]);
    state = applyTransition(state, "plan-exec.settlement-authoring");

    const advanced = advanceFlowRun({ state, journey: JOURNEY });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.directive.boundary.transition).toBe("plan-exec.settlement-question");
    expect(advanced.directive.boundary.authority).toBe("human");

    const labels = advanced.directive.choices.map((choice) => choice.label);
    expect(labels).toEqual([
      "Cumplida con la evidencia declarada",
      "Es un traspaso",
      "Sigue pendiente",
      "Compactar",
      "Cerrar",
    ]);
    // Exactamente una recomendada, y es la que el agente propuso.
    const recommended = advanced.directive.choices.filter((choice) => choice.recommended);
    expect(recommended.map((choice) => choice.label)).toEqual(["Es un traspaso"]);
    // Y la consecuencia dice sobre qué se aplica, sin perder lo que la lectura hace.
    const handoff = advanced.directive.choices.find((c) => c.label === "Es un traspaso");
    expect(handoff?.consequence).toContain("deja de bloquear el cierre");
    expect(handoff?.consequence).toContain("revalidar el recorrido PLAN completo");
  });

  it("propuestas que no coinciden entre sí caen en la lectura segura", () => {
    const first = { ...COMPENSATION, legacy: true };
    const second = { note: "DEC-001", index: 1, text: "otra cosa vieja", legacy: true };
    let state = atClosure(owed({ compensations: [first, second] }));
    state = withSettlementDeclarations(state, [
      { note: "DEC-001", index: 0, outcome: "handoff" },
      { note: "DEC-001", index: 1, outcome: "settled", evidence: "corrió" },
    ]);
    state = applyTransition(state, "plan-exec.settlement-authoring");

    const advanced = advanceFlowRun({ state, journey: JOURNEY });
    expect(advanced.ok).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.directive.choices.filter((c) => c.recommended).map((c) => c.label)).toEqual([
      "Sigue pendiente",
    ]);
  });
});

describe("las guardas del registro sobre las tres filas nuevas", () => {
  const row = (id: string): FlowDecision => {
    const found = FLOW_DECISIONS.find((decision) => decision.id === id);
    if (found === undefined) throw new Error(`el registro no tiene '${id}'`);
    return found;
  };

  it("cada una declara su autoridad, y son tres autoridades distintas", () => {
    expect(row("plan-exec.settlement-authoring").authority).toBe("agent");
    expect(row("plan-exec.settlement-question").authority).toBe("human");
    expect(row("plan-exec.settlement-publication").authority).toBe("cli");
  });

  it("las tres viven fuera del conjunto que se repite por lote", () => {
    for (const id of [
      "plan-exec.settlement-authoring",
      "plan-exec.settlement-question",
      "plan-exec.settlement-publication",
    ]) {
      expect(PLAN_EXEC_BATCH_LOOP_TRANSITIONS.has(id), id).toBe(false);
    }
  });

  it("y entre el último cierre de batch y la validación final, en ese orden", () => {
    const ids = journeyOfFlow("plan-exec").map((decision: FlowDecision) => decision.id);
    const close = ids.lastIndexOf("plan-exec.batch-close");
    const authoring = ids.indexOf("plan-exec.settlement-authoring");
    const question = ids.indexOf("plan-exec.settlement-question");
    const publication = ids.indexOf("plan-exec.settlement-publication");
    const final = ids.indexOf("plan-exec.final-validation");

    expect(close).toBeGreaterThan(-1);
    expect(authoring).toBeGreaterThan(close);
    expect(question).toBe(authoring + 1);
    expect(publication).toBe(question + 1);
    expect(final).toBe(publication + 1);
  });

  it("la publicación es una operación interna declarada, con su techo de efectos", () => {
    const action = actionOf(row("plan-exec.settlement-publication"));
    expect(action?.execution).toEqual({
      kind: "internal",
      operation: "plan-exec.settlement-publish",
    });
    expect(INTERNAL_ACTION_OPERATIONS).toContain("plan-exec.settlement-publish");
    // Sólo sobrescribir: un saldo sustituye a una nota, así que la cadena a la
    // que se suma NECESARIAMENTE existe. Declarar además la clase de creación
    // haría que el veredicto exija un efecto que esta operación no puede ejercer
    // nunca, y toda publicación se rechazaría a sí misma.
    expect(INTERNAL_OPERATION_EFFECTS["plan-exec.settlement-publish"]).toEqual([
      "mutate_overwrite",
    ]);
    // Y su recuperación nombra el comando con el que se vuelve.
    expect(action?.recovery).toContain("aw flow advance");
  });

  it("la pregunta ofrece tres lecturas y ninguna recomendada de fábrica", () => {
    const alternatives = alternativesOf(row("plan-exec.settlement-question")) ?? [];

    expect(alternatives).toHaveLength(3);
    // La recomendación la pone el estado —la lectura que el agente propuso—, no
    // el registro: una fila se escribe una vez y no puede ver la obligación.
    expect(alternatives.filter((alternative) => alternative.recommended)).toEqual([]);
  });

  it("el gate de desviación conserva exactamente sus cuatro salidas", () => {
    const alternatives = alternativesOf(row("plan-exec.deviation-gate")) ?? [];

    expect(alternatives).toHaveLength(4);
    expect(alternatives.filter((alternative) => alternative.recommended)).toHaveLength(1);
  });
});

describe("el saldo se publica por la primitiva sellada y deja el plan cerrable", () => {
  const SPEC_TEXT = [
    "# 033 — spec fixture",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] **S033/AC-01 — una.** texto",
    "- [ ] **S033/AC-02 — otra.** texto",
    "",
  ].join("\n");

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

  let root: string;
  let fs: NodeFileSystem;
  let paths: PathsService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "settle-"));
    fs = new NodeFileSystem();
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

  /** Publica la nota que carga las dos obligaciones del incidente. */
  const publishCarrier = (): DecisionNote => {
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
      obligations:
        normalizeObligations([
          { text: "revalidar F1 contra el contrato nuevo", kind: "compensation" },
          { text: "Producto y QA validan el flujo", kind: "handoff" },
        ]) ?? [],
      resume_point: "F1/T1.1",
      date: "2026-08-16",
    });
    const artifact = noteIndexArtifact(noteIndexPath("docs/decisions", "033", "x"), {
      ...index,
      notes: [sealed],
    });
    writeFileSync(join(root, artifact.path), artifact.content);
    return sealed;
  };

  const settle = () =>
    settlePlanExecObligations(fs, paths, {
      root,
      execution: () => ({ session: "167-x-plan-exec", phase: "cierre" }),
      plan: "docs/plans/032-plan-x.md",
      date: "2026-09-03",
      declarations: [
        {
          note: "DEC-001",
          index: 0,
          outcome: "settled",
          evidence: "npm test sobre la suite de F1: 4797 en verde",
        },
      ],
    });

  it("publica el sucesor, suelta la compensación y el plan queda cerrable", async () => {
    const carrier = publishCarrier();
    const result = await settle();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.published.map((note) => note.id)).toEqual(["DEC-002"]);
    expect(result.published[0]?.supersedes_note).toBe(carrier.id);
    expect(result.settled).toEqual(["revalidar F1 contra el contrato nuevo"]);
    // El traspaso sobrevive, la compensación no, y por eso el plan cierra.
    expect(result.reconciliation.pending).toEqual([]);
    expect(result.reconciliation.handoffs.map((o) => o.text)).toEqual([
      "Producto y QA validan el flujo",
    ]);
    expect(result.reconciliation.closable).toBe(true);
  });

  it("y el agente no escribió el índice: lo escribió la primitiva sellada", async () => {
    publishCarrier();
    const result = await settle();
    expect(result.ok).toBe(true);

    const written = JSON.parse(
      readFileSync(join(root, noteIndexPath("docs/decisions", "033", "x")), "utf8"),
    ) as { notes: DecisionNote[] };
    // Dos notas, la vieja intacta con su sello y la nueva con el suyo.
    expect(written.notes.map((note) => note.id)).toEqual(["DEC-001", "DEC-002"]);
    const reread = validateDecisionNote(written.notes[1]);
    expect(reread.ok).toBe(true);
  });

  it("repetirlo es idempotente: la cadena no gana una nota gemela", async () => {
    publishCarrier();
    const first = await settle();
    const second = await settle();

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.published.map((note) => note.id)).toEqual(["DEC-002"]);
    const written = JSON.parse(
      readFileSync(join(root, noteIndexPath("docs/decisions", "033", "x")), "utf8"),
    ) as { notes: DecisionNote[] };
    expect(written.notes).toHaveLength(2);
  });

  it("una obligación que no existe se rechaza sin escribir nada", async () => {
    publishCarrier();
    const before = readFileSync(join(root, noteIndexPath("docs/decisions", "033", "x")), "utf8");

    const result = await settlePlanExecObligations(fs, paths, {
      root,
      execution: () => ({ session: "167-x-plan-exec", phase: "cierre" }),
      plan: "docs/plans/032-plan-x.md",
      date: "2026-09-03",
      declarations: [{ note: "DEC-001", index: 9, outcome: "handoff" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe("SETTLEMENT_OBLIGATION_ABSENT");
    expect(readFileSync(join(root, noteIndexPath("docs/decisions", "033", "x")), "utf8")).toBe(
      before,
    );
  });
});

// El incidente EXACTO: una nota vieja, sin clases, con una compensación ya
// cumplida y un traspaso que el propio plan enumera. Es el caso que la fase
// existe para cerrar, y el que una nota portadora «moderna» no ejercita: un
// sucesor que arrastrara una obligación sin clase no se podría anexar nunca,
// porque la vía de escritura la rechaza — el saldo se refutaría a sí mismo.
describe("una nota LEGADA se salda: el sucesor clasifica lo que arrastra", () => {
  const HANDOFF_ITEM = "Producto y QA validan el flujo nuevo antes de la release";
  const SPEC_TEXT = [
    "# 033 — spec fixture",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] **S033/AC-01 — una.** texto",
    "",
  ].join("\n");
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
      "## Handoff operativo",
      "",
      `- ${HANDOFF_ITEM}`,
      "",
    ].join("\n");

  let root: string;
  let fs: NodeFileSystem;
  let paths: PathsService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "settle-legacy-"));
    fs = new NodeFileSystem();
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "decisions"), { recursive: true });
    writeFileSync(join(root, "docs/specs/033-spec-x.md"), SPEC_TEXT);
    writeFileSync(
      join(root, "docs/plans/032-plan-x.md"),
      planText(`sha256:${baseDigest(SPEC_TEXT)}`),
    );
    const index = {
      schema: "workline.decision-index/v1" as const,
      spec: { path: "docs/specs/033-spec-x.md", number: "033" },
      notes: [] as DecisionNote[],
    };
    // Las dos obligaciones en forma de TEXTO, como quedaron publicadas antes de
    // que las clases existieran.
    const sealed = sealNote(index, {
      schema: NOTE_SCHEMA,
      lineage: {
        spec: {
          path: "docs/specs/033-spec-x.md",
          number: "033",
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
      obligations:
        normalizeObligations(["revalidar F1 contra el contrato nuevo", HANDOFF_ITEM]) ?? [],
      resume_point: "F1/T1.1",
      date: "2026-08-16",
    });
    const artifact = noteIndexArtifact(noteIndexPath("docs/decisions", "033", "x"), {
      ...index,
      notes: [sealed],
    });
    writeFileSync(join(root, artifact.path), artifact.content);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("el traspaso que el plan enumera sale clasificado, y el plan queda cerrable", async () => {
    const result = await settlePlanExecObligations(fs, paths, {
      root,
      execution: () => ({ session: "167-x-plan-exec", phase: "cierre" }),
      plan: "docs/plans/032-plan-x.md",
      date: "2026-09-03",
      // Sólo la compensación se declara: el traspaso ni siquiera está en la lista
      // de lo que bloquea, porque el plan ya lo enumera.
      declarations: [
        {
          note: "DEC-001",
          index: 0,
          outcome: "settled",
          evidence: "npm test sobre la suite de F1, en verde",
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.published.map((note) => note.id)).toEqual(["DEC-002"]);
    // Lo que arrastra ya NO es texto suelto: sale con la clase que el tablero
    // leyó. Sin esto el sucesor no se habría podido anexar.
    expect(result.published[0]?.obligations).toEqual([
      { text: HANDOFF_ITEM, kind: "handoff", declared: true },
    ]);
    expect(result.reconciliation.pending).toEqual([]);
    expect(result.reconciliation.closable).toBe(true);
    expect(result.reconciliation.handoffs.map((o) => o.text)).toEqual([HANDOFF_ITEM]);
  });

  it("y el índice reescrito verifica entero: la nota vieja conserva su sello", async () => {
    const before = JSON.parse(
      readFileSync(join(root, noteIndexPath("docs/decisions", "033", "x")), "utf8"),
    ) as { notes: DecisionNote[] };

    await settlePlanExecObligations(fs, paths, {
      root,
      execution: () => ({ session: "167-x-plan-exec", phase: "cierre" }),
      plan: "docs/plans/032-plan-x.md",
      date: "2026-09-03",
      declarations: [
        { note: "DEC-001", index: 0, outcome: "settled", evidence: "npm test en verde" },
      ],
    });

    const after = JSON.parse(
      readFileSync(join(root, noteIndexPath("docs/decisions", "033", "x")), "utf8"),
    ) as { notes: DecisionNote[] };
    expect(after.notes[0]).toEqual(before.notes[0]);
    expect(after.notes.every((note) => validateDecisionNote(note).ok)).toBe(true);
    // La forma de disco de la nota vieja sigue siendo la legada.
    expect(after.notes[0]?.obligations).toEqual([
      "revalidar F1 contra el contrato nuevo",
      HANDOFF_ITEM,
    ]);
  });
});

// El hallazgo que dejaba la fase inerte: la foto de lo que el plan debe se
// tomaba SÓLO en la rama de inferencia sin trabajo abierto, que un cierre normal
// nunca alcanza — el publicador del batch ya termina el bucle al cerrar, así que
// la inferencia no se vuelve a caminar. Cualquier corrida que ejecutara trabajo
// llegaba a `plan-done` con la compensación viva y sin haber preguntado nada.
describe("el cierre del último batch es lo que le dice al cierre qué se debe", () => {
  const SESSION = "167-saldo-plan-exec";
  const SPEC_TEXT = [
    "# 033 — spec fixture",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] **S033/AC-01 — una.** texto",
    "",
  ].join("\n");
  const PLAN_FILE = "docs/plans/032-plan-x.md";
  /** Una fase con su tarea ABIERTA: hay batch que sellar y que cerrar. */
  const planText = (specDigest: string): string =>
    [
      "# 032 — plan fixture",
      "",
      "> Derived from: docs/specs/033-spec-x.md",
      `> Baseline: docs/specs/033-spec-x.md@${specDigest}`,
      "> Estado: open",
      "> Límite de ejecución: checkout",
      "",
      "## Tasks",
      "",
      "### F1 — la única fase",
      "> Estado: pendiente",
      "> Fuentes: workspace",
      "",
      "**Trabajo:**",
      "- [ ] T1.1 — el trabajo _(fuentes: workspace)_",
      "",
    ].join("\n");

  let root: string;
  let fs: NodeFileSystem;
  let env: FakeEnv;
  let paths: PathsService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "settle-close-"));
    fs = new NodeFileSystem();
    env = new FakeEnv(root, root);
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    mkdirSync(join(root, "docs", "specs"), { recursive: true });
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(join(root, "docs", "decisions"), { recursive: true });
    mkdirSync(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    writeFileSync(join(root, "docs/specs/033-spec-x.md"), SPEC_TEXT);
    writeFileSync(join(root, PLAN_FILE), planText(`sha256:${baseDigest(SPEC_TEXT)}`));

    // Una nota vigente con una compensación: lo que el cierre tiene que ver.
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
          digest: functionalSpecDigest(SPEC_TEXT),
        },
        plan: {
          path: PLAN_FILE,
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
      consumers: [PLAN_FILE],
      evidence_preserved: [],
      evidence_invalidated: ["F1/T1.1"],
      obligations:
        normalizeObligations([{ text: "revalidar F1 completo", kind: "compensation" }]) ?? [],
      resume_point: "F1/T1.1",
      date: "2026-08-16",
    });
    const artifact = noteIndexArtifact(noteIndexPath("docs/decisions", "033", "x"), {
      ...index,
      notes: [sealed],
    });
    writeFileSync(join(root, artifact.path), artifact.content);

    // La corrida, parada exactamente en el cierre del batch, con su snapshot.
    const text = planText(`sha256:${baseDigest(SPEC_TEXT)}`);
    const inferred = inferPlanExecBatch(text, {
      id: "batch-1",
      iteration: 1,
      mode: "continuous",
      phases: [1],
    });
    if (!inferred.ok) throw new Error("el fixture no expone un batch inferible");
    const journey = journeyOfFlow("plan-exec");
    let run = withScope(newRunState("plan-exec", SESSION), {
      plan: PLAN_FILE,
      sources: ["workspace"],
    });
    for (const row of journey.slice(
      0,
      journey.findIndex((decision: FlowDecision) => decision.id === "plan-exec.batch-close"),
    )) {
      run = applyTransition(run, row.id);
    }
    run = withPlanExecBatch(run, inferred.batch);
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE),
      serializeRunState(run),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("al cerrar el último batch la corrida queda sabiendo qué compensación debe", async () => {
    const read = await readRun(fs, locateRun(paths, SESSION));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // Antes de cerrar no hay nada anotado: no hay cierre al que informarle.
    expect(read.state.settlement).toBeUndefined();

    const executor = internalActionExecutor({ fs, env, paths, git: new RecordingGit() });
    const outcome = await executor(
      { operation: "plan-exec.batch-close" },
      {
        session: SESSION,
        code: "167",
        scope: { plan: PLAN_FILE, sources: ["workspace"] },
        proposal: null,
        state_digest: read.state.digest,
      },
    );

    expect(outcome.ok, outcome.summary).toBe(true);
    // El bucle terminó —la única fase quedó validada— y con él llegó la foto.
    expect(outcome.state?.batch_loop?.pending).toBe(false);
    expect(outcome.state?.settlement?.compensations).toEqual([
      { note: "DEC-001", index: 0, text: "revalidar F1 completo", legacy: false },
    ]);
    // Y quedó PERSISTIDA: el driver liquida contra el digest que trae, así que
    // una foto que viviera sólo en memoria fallaría su propio compare-and-swap.
    const after = await readRun(fs, locateRun(paths, SESSION));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.state.digest).toBe(outcome.state?.digest);
    expect(after.state.settlement?.compensations).toHaveLength(1);
  });

  /** El sobre que contesta la frontera vigente de esta corrida. */
  const answer = async (body: Record<string, unknown>) => {
    const executor = internalActionExecutor({ fs, env, paths, git: new RecordingGit() });
    const standing = await advanceFlow(fs, paths, { code: SESSION, flow: "plan-exec", executor });
    if (!standing.ok) throw new Error("esperaba una directiva");
    const result = await submitFlow(fs, paths, {
      code: SESSION,
      raw: JSON.stringify({ input_digest: standing.directive.state_digest, ...body }),
      approval: null,
      executor,
    });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
    return result.directive;
  };

  /** Cierra el batch y deja la corrida parada en la autoría del saldo. */
  const closeBatchAndStop = async () => {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error("esperaba la corrida");
    const executor = internalActionExecutor({ fs, env, paths, git: new RecordingGit() });
    const outcome = await executor(
      { operation: "plan-exec.batch-close" },
      {
        session: SESSION,
        code: "167",
        scope: { plan: PLAN_FILE, sources: ["workspace"] },
        proposal: null,
        state_digest: read.state.digest,
      },
    );
    if (!outcome.ok || outcome.state === undefined) throw new Error(outcome.summary);
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE),
      serializeRunState(applyTransition(outcome.state, "plan-exec.batch-close")),
    );
  };

  it("una declaración incompleta se rechaza nombrando la obligación que falta", async () => {
    await closeBatchAndStop();
    const directive = await answer({ decisions: { settlement: [] } });

    expect(directive.error?.code).toBe("FLOW_SETTLEMENT_INCOMPLETE");
    expect(directive.error?.message).toContain("revalidar F1 completo");
    expect(directive.boundary.transition).toBe("plan-exec.settlement-authoring");
  });

  it("una declaración sobre una obligación que el plan no debe se rechaza", async () => {
    await closeBatchAndStop();
    const directive = await answer({
      decisions: {
        settlement: [
          { note: "DEC-001", index: 0, outcome: "handoff" },
          { note: "DEC-009", index: 3, outcome: "handoff" },
        ],
      },
    });

    expect(directive.error?.code).toBe("FLOW_SETTLEMENT_INVALID");
    expect(directive.error?.message).toContain("DEC-009[3]");
  });

  it("«cumplida» sin evidencia no es una declaración: la forma la rechaza", async () => {
    await closeBatchAndStop();
    const directive = await answer({
      decisions: { settlement: [{ note: "DEC-001", index: 0, outcome: "settled" }] },
    });

    expect(directive.error?.code).toBe("FLOW_SETTLEMENT_INVALID");
  });

  it("una compensación con una sola lectura declarada pendiente detiene el cierre, gratis", async () => {
    await closeBatchAndStop();
    const before = await readRun(fs, locateRun(paths, SESSION));
    if (!before.ok) throw new Error("esperaba la corrida");

    const directive = await answer({
      decisions: { settlement: [{ note: "DEC-001", index: 0, outcome: "pending" }] },
    });

    expect(directive.error?.code).toBe("PLAN_EXEC_SETTLEMENT_PENDING");
    expect(directive.error?.message).toContain("revalidar F1 completo");
    expect(directive.action?.invocation).toBeUndefined();
    // La frontera sigue abierta y no le costó un intento a la corrida.
    expect(directive.boundary.transition).toBe("plan-exec.settlement-authoring");
    expect(directive.attempt_accounting.spent).toBe(0);
  });

  it("declarada cumplida con su evidencia, el CLI publica el saldo y el cierre sigue", async () => {
    await closeBatchAndStop();
    const directive = await answer({
      decisions: {
        settlement: [
          {
            note: "DEC-001",
            index: 0,
            outcome: "settled",
            evidence: "npm test sobre la suite de F1, en verde",
          },
        ],
      },
    });

    // Ninguna frontera humana en el camino: la pregunta se salta porque la
    // obligación tenía una sola lectura, y la publicación es del CLI.
    expect(directive.boundary.transition).toBe("plan-exec.final-validation");
    const after = await readRun(fs, locateRun(paths, SESSION));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.state.skipped).toContain("plan-exec.settlement-question");
    expect(after.state.applied).toContain("plan-exec.settlement-publication");
    // Y la nota de saldo está en la cadena, escrita por la primitiva sellada.
    const written = JSON.parse(
      readFileSync(join(root, noteIndexPath("docs/decisions", "033", "x")), "utf8"),
    ) as { notes: DecisionNote[] };
    expect(written.notes.map((note) => note.id)).toEqual(["DEC-001", "DEC-002"]);
    expect(written.notes[1]?.obligations).toEqual([]);
  });
});
