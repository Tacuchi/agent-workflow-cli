import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { locateRun } from "../../src/application/flow/run-state-service.js";
import { parseTasks } from "../../src/application/parsers/tasks.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  inferPlanExecBatch,
  preparePlanExecBatchPublication,
  preparePlanExecDoneSeal,
  publishPlanExecBatch,
} from "../../src/application/plan-exec-batch-service.js";
import { journeyForState, journeyOfFlow } from "../../src/domain/flow/authority.js";
import {
  applyTransition,
  checkAgainstJourney,
  newRunState,
  serializeRunState,
  withBoundary,
  withPlanExecBatch,
  withPlanExecBatchLoop,
  withPlanExecBatchPublication,
  withPlanExecBatchPublicationPrepared,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

/** The 7/9 regression: F1–F3 were already accredited; only F4 remains. */
const PLAN = [
  "# Plan 032 — batch",
  "",
  "> Derived from docs/specs/033-spec-x.md",
  "> Estado: open",
  "",
  "## Tasks",
  "",
  "### F1 — previo",
  "> Estado: validada",
  "- [x] T1.1 — hecho",
  "- [x] T1.2 — hecho",
  "",
  "### F2 — previo",
  "> Estado: validada",
  "- [x] T2.1 — hecho",
  "- [x] T2.2 — hecho",
  "",
  "### F3 — previo",
  "> Estado: validada",
  "- [x] T3.1 — hecho",
  "- [x] T3.2 — hecho",
  "- [x] T3.3 — hecho",
  "",
  "### F4 — cierre",
  "> Estado: en ejecución",
  "- [ ] T4.1 — primer trabajo ya hecho",
  "- [ ] T4.2 — segundo trabajo ya hecho",
  "",
].join("\n");

const PLAN_WITH_NEXT_BATCH = [
  PLAN,
  "### F5 — siguiente",
  "> Estado: en ejecución",
  "- [ ] T5.1 — siguiente trabajo",
  "",
].join("\n");

describe("plan-exec batch publication", () => {
  it("acredita exactamente T4.1/T4.2: 7/9 pasa a 9/9 sin reejecutar ni inventar baseline", () => {
    const inferred = inferPlanExecBatch(PLAN, {
      id: "batch-4",
      iteration: 4,
      mode: "continuous",
      phases: [4],
    });
    if (!inferred.ok) throw new Error(inferred.failure.message);
    expect(inferred.batch.tasks).toEqual(["T4.1", "T4.2"]);

    const prepared = preparePlanExecBatchPublication(PLAN, {
      plan: "docs/plans/032-plan-batch.md",
      batch: inferred.batch,
      completed_tasks: ["T4.1", "T4.2"],
      phase_updates: [{ phase: 4, state: "validada" }],
      transition: "plan-exec.batch-close",
    });
    if (!prepared.ok) throw new Error(prepared.failure.message);

    expect(parseTasks(prepared.prepared.content)).toMatchObject({ total: 9, closed: 9, open: 0 });
    expect(prepared.prepared.content).toContain("> Estado: validada\n- [x] T4.1");
    expect(prepared.prepared.content).not.toContain("> Baseline:");
    expect(prepared.prepared.after_digest).not.toBe(prepared.prepared.before_digest);
  });

  it("rechaza una atribución parcial, ajena al batch o sobre un plan movido", () => {
    const inferred = inferPlanExecBatch(PLAN, {
      id: "batch-4",
      iteration: 4,
      mode: "continuous",
      phases: [4],
    });
    if (!inferred.ok) throw new Error(inferred.failure.message);

    const partial = preparePlanExecBatchPublication(PLAN, {
      plan: "docs/plans/032-plan-batch.md",
      batch: inferred.batch,
      completed_tasks: ["T4.1"],
      phase_updates: [],
      transition: "plan-exec.batch-close",
    });
    expect(partial).toMatchObject({
      ok: false,
      failure: { code: "PLAN_EXEC_BATCH_TASK_SET_INVALID" },
    });

    const stale = preparePlanExecBatchPublication(`${PLAN}\n<!-- moved -->\n`, {
      plan: "docs/plans/032-plan-batch.md",
      batch: inferred.batch,
      completed_tasks: ["T4.1", "T4.2"],
      phase_updates: [],
      transition: "plan-exec.batch-close",
    });
    expect(stale).toMatchObject({ ok: false, failure: { code: "PLAN_EXEC_BATCH_STALE" } });

    const ambiguousPhase = preparePlanExecBatchPublication(PLAN, {
      plan: "docs/plans/032-plan-batch.md",
      batch: inferred.batch,
      completed_tasks: ["T4.1", "T4.2"],
      phase_updates: [
        { phase: 4, state: "validada" },
        { phase: 4, state: "bloqueada", blocker: "dos estados no pueden competir" },
      ],
      transition: "plan-exec.batch-close",
    });
    expect(ambiguousPhase).toMatchObject({
      ok: false,
      failure: { code: "PLAN_EXEC_BATCH_PHASE_DUPLICATE" },
    });
  });

  it("sella done sólo sobre el 9/9 validado y añade un Cierre sin fabricar baseline", () => {
    const inferred = inferPlanExecBatch(PLAN, {
      id: "batch-4",
      iteration: 4,
      mode: "continuous",
      phases: [4],
    });
    if (!inferred.ok) throw new Error(inferred.failure.message);
    const batch = preparePlanExecBatchPublication(PLAN, {
      plan: "docs/plans/032-plan-batch.md",
      batch: inferred.batch,
      completed_tasks: inferred.batch.tasks,
      phase_updates: [{ phase: 4, state: "validada" }],
      transition: "plan-exec.batch-close",
    });
    if (!batch.ok) throw new Error(batch.failure.message);

    const done = preparePlanExecDoneSeal(batch.prepared.content, {
      plan: "docs/plans/032-plan-batch.md",
      closure: "validación final, commits e integración acreditados por la corrida 131",
    });
    if (!done.ok) throw new Error(done.failure.message);
    expect(done.prepared.content).toContain("> Estado: done");
    expect(done.prepared.content).toContain("> Cierre: validación final, commits e integración");
    expect(done.prepared.content).not.toContain("> Baseline:");

    const retry = preparePlanExecDoneSeal(done.prepared.content, {
      plan: "docs/plans/032-plan-batch.md",
      closure: "validación final, commits e integración acreditados por la corrida 131",
    });
    expect(retry).toMatchObject({ ok: true, prepared: { already_sealed: true } });
    expect(
      preparePlanExecDoneSeal(PLAN, {
        plan: "docs/plans/032-plan-batch.md",
        closure: "no debe cerrar",
      }),
    ).toMatchObject({ ok: false, failure: { code: "PLAN_EXEC_DONE_TASKS_OPEN" } });
  });
});

describe("recuperación durable del batch", () => {
  const fs = new NodeFileSystem();
  const session = "131-batch-plan-exec";
  let root = "";

  afterEach(() => {
    if (root.length > 0) rmSync(root, { recursive: true, force: true });
  });

  it("reconoce el plan escrito entre intención y traza, y cierra sin acreditar dos veces", async () => {
    root = mkdtempSync(join(tmpdir(), "aw-batch-recovery-"));
    const paths = new PathsService(normalizeNamespace("agent-workflow"), root, root);
    const plan = "docs/plans/032-plan-batch.md";
    const location = locateRun(paths, session);
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(location.dir, { recursive: true });
    writeFileSync(join(root, plan), PLAN);

    const inferred = inferPlanExecBatch(PLAN, {
      id: "batch-4",
      iteration: 4,
      mode: "continuous",
      phases: [4],
    });
    if (!inferred.ok) throw new Error(inferred.failure.message);
    const prepared = preparePlanExecBatchPublication(PLAN, {
      plan,
      batch: inferred.batch,
      completed_tasks: inferred.batch.tasks,
      phase_updates: [{ phase: 4, state: "validada" }],
      transition: "plan-exec.batch-close",
    });
    if (!prepared.ok) throw new Error(prepared.failure.message);

    // This is the exact durable state a process leaves before it enters the
    // document CAS. The next two writes simulate a crash after the plan landed
    // but before the run-state finalizer returned.
    let state = newRunState("plan-exec", session);
    state = withPlanExecBatch(state, inferred.batch);
    state = withPlanExecBatchPublicationPrepared(state, inferred.batch.id, {
      plan,
      before_plan_digest: prepared.prepared.before_digest,
      after_plan_digest: prepared.prepared.after_digest,
      transition: "plan-exec.batch-close",
    });
    writeFileSync(location.statePath, serializeRunState(state));
    writeFileSync(join(root, plan), prepared.prepared.content);

    const recovered = await publishPlanExecBatch(fs, paths, {
      root,
      location,
      state_digest: state.digest,
      plan,
      batch: inferred.batch,
      completed_tasks: inferred.batch.tasks,
      phase_updates: [{ phase: 4, state: "validada" }],
      transition: "plan-exec.batch-close",
    });
    if (!recovered.ok) throw new Error(recovered.failure.message);

    expect(recovered.already_applied).toBe(true);
    expect(recovered.written).toEqual([]);
    expect(readFileSync(join(root, plan), "utf8")).toBe(prepared.prepared.content);
    expect(recovered.batch.published_plan_digest).toBe(prepared.prepared.after_digest);
    expect(recovered.batch.publication?.status).toBe("applied");
    expect(recovered.state.batch_loop).toEqual({ pending: false, iteration: null });
    expect(recovered.state.batch_trace).toEqual([
      expect.objectContaining({ batch_id: "batch-4", stage: "inferred", kind: "entered" }),
      expect.objectContaining({ batch_id: "batch-4", stage: "closed", kind: "completed" }),
    ]);
  });

  it("publica una vez y el reintento con el sello nuevo es un no-op idempotente", async () => {
    root = mkdtempSync(join(tmpdir(), "aw-batch-idempotent-"));
    const paths = new PathsService(normalizeNamespace("agent-workflow"), root, root);
    const plan = "docs/plans/032-plan-batch.md";
    const location = locateRun(paths, session);
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(location.dir, { recursive: true });
    writeFileSync(join(root, plan), PLAN);

    const inferred = inferPlanExecBatch(PLAN, {
      id: "batch-4",
      iteration: 4,
      mode: "continuous",
      phases: [4],
    });
    if (!inferred.ok) throw new Error(inferred.failure.message);
    let state = newRunState("plan-exec", session);
    state = withPlanExecBatch(state, inferred.batch);
    writeFileSync(location.statePath, serializeRunState(state));

    const first = await publishPlanExecBatch(fs, paths, {
      root,
      location,
      state_digest: state.digest,
      plan,
      batch: inferred.batch,
      completed_tasks: inferred.batch.tasks,
      phase_updates: [{ phase: 4, state: "validada" }],
      transition: "plan-exec.batch-close",
    });
    if (!first.ok) throw new Error(first.failure.message);
    expect(first.already_applied).toBe(false);
    expect(first.written).toEqual([plan]);

    const retry = await publishPlanExecBatch(fs, paths, {
      root,
      location,
      state_digest: first.state.digest,
      plan,
      batch: inferred.batch,
      completed_tasks: inferred.batch.tasks,
      phase_updates: [{ phase: 4, state: "validada" }],
      transition: "plan-exec.batch-close",
    });
    if (!retry.ok) throw new Error(retry.failure.message);
    expect(retry.already_applied).toBe(true);
    expect(retry.written).toEqual([]);
    expect(retry.state.batch_trace).toHaveLength(2);
    expect(retry.state.batch_loop).toEqual({ pending: false, iteration: null });
  });

  it("rechaza publicar un batch que no fue sellado antes de implementar", async () => {
    root = mkdtempSync(join(tmpdir(), "aw-batch-no-snapshot-"));
    const paths = new PathsService(normalizeNamespace("agent-workflow"), root, root);
    const plan = "docs/plans/032-plan-batch.md";
    const location = locateRun(paths, session);
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(location.dir, { recursive: true });
    writeFileSync(join(root, plan), PLAN);
    const inferred = inferPlanExecBatch(PLAN, {
      id: "batch-4",
      iteration: 4,
      mode: "continuous",
      phases: [4],
    });
    if (!inferred.ok) throw new Error(inferred.failure.message);
    const state = newRunState("plan-exec", session);
    writeFileSync(location.statePath, serializeRunState(state));

    const result = await publishPlanExecBatch(fs, paths, {
      root,
      location,
      state_digest: state.digest,
      plan,
      batch: inferred.batch,
      completed_tasks: inferred.batch.tasks,
      phase_updates: [{ phase: 4, state: "validada" }],
      transition: "plan-exec.batch-close",
    });
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "PLAN_EXEC_BATCH_NOT_INFERRED" },
    });
    expect(readFileSync(join(root, plan), "utf8")).toBe(PLAN);
  });

  it("abre otra iteración sólo cuando los bytes publicados aún tienen una fase abierta", async () => {
    root = mkdtempSync(join(tmpdir(), "aw-batch-loop-"));
    const paths = new PathsService(normalizeNamespace("agent-workflow"), root, root);
    const plan = "docs/plans/032-plan-batch.md";
    const location = locateRun(paths, session);
    mkdirSync(join(root, "docs", "plans"), { recursive: true });
    mkdirSync(location.dir, { recursive: true });
    writeFileSync(join(root, plan), PLAN_WITH_NEXT_BATCH);
    const firstBatch = inferPlanExecBatch(PLAN_WITH_NEXT_BATCH, {
      id: "batch-4",
      iteration: 4,
      mode: "continuous",
      phases: [4],
    });
    if (!firstBatch.ok) throw new Error(firstBatch.failure.message);
    let state = newRunState("plan-exec", session);
    state = withPlanExecBatch(state, firstBatch.batch);
    writeFileSync(location.statePath, serializeRunState(state));
    const first = await publishPlanExecBatch(fs, paths, {
      root,
      location,
      state_digest: state.digest,
      plan,
      batch: firstBatch.batch,
      completed_tasks: firstBatch.batch.tasks,
      phase_updates: [{ phase: 4, state: "validada" }],
      transition: "plan-exec.batch-close",
    });
    if (!first.ok) throw new Error(first.failure.message);
    expect(first.state.batch_loop).toEqual({ pending: true, iteration: 5 });
    expect(
      journeyForState(first.state).filter((row) => row.id === "plan-exec.batch-close"),
    ).toHaveLength(2);

    const secondPlan = readFileSync(join(root, plan), "utf8");
    const secondBatch = inferPlanExecBatch(secondPlan, {
      id: "batch-5",
      iteration: 5,
      mode: "continuous",
      phases: [5],
    });
    if (!secondBatch.ok) throw new Error(secondBatch.failure.message);
    const secondState = withPlanExecBatch(first.state, secondBatch.batch);
    writeFileSync(location.statePath, serializeRunState(secondState));
    const second = await publishPlanExecBatch(fs, paths, {
      root,
      location,
      state_digest: secondState.digest,
      plan,
      batch: secondBatch.batch,
      completed_tasks: secondBatch.batch.tasks,
      phase_updates: [{ phase: 5, state: "validada" }],
      transition: "plan-exec.batch-close",
    });
    if (!second.ok) throw new Error(second.failure.message);
    expect(second.state.batch_loop).toEqual({ pending: false, iteration: null });
    expect(
      journeyForState(second.state).filter((row) => row.id === "plan-exec.batch-close"),
    ).toHaveLength(2);
  });
});

describe("cursor repetible de PLAN-exec", () => {
  const session = "131-batch-plan-exec";

  it("añade la siguiente iteración sin rebobinar y sólo expone final-validation al último batch", () => {
    const inferred = inferPlanExecBatch(PLAN, {
      id: "batch-4",
      iteration: 4,
      mode: "continuous",
      phases: [4],
    });
    if (!inferred.ok) throw new Error(inferred.failure.message);

    const staticJourney = journeyOfFlow("plan-exec");
    const firstClose = staticJourney.findIndex((row) => row.id === "plan-exec.batch-close");
    if (firstClose < 0) throw new Error("el recorrido no tiene cierre de batch");
    let state = newRunState("plan-exec", session);
    for (const row of staticJourney.slice(0, firstClose + 1)) {
      state = applyTransition(state, row.id);
    }
    state = withPlanExecBatch(state, inferred.batch);
    state = withPlanExecBatchPublication(state, inferred.batch.id, "sha256:batch-4-closed");
    state = withPlanExecBatchLoop(state, { pending: true, iteration: 5 });
    state = withBoundary(state, "plan-exec.batch-eligibility-signal");

    const next = journeyForState(state);
    expect(next.filter((row) => row.id === "plan-exec.batch-inference")).toHaveLength(2);
    expect(checkAgainstJourney(state, next)).toBeNull();
    // El nuevo segmento vuelve a pedir su señal de elegibilidad; sólo su respuesta
    // permite inferir el siguiente snapshot de batch.
    expect(resolveBoundary(state, next).stopped?.id).toBe("plan-exec.batch-eligibility-signal");
    const secondClose = next.map((row) => row.id).lastIndexOf("plan-exec.batch-close");
    expect(next.findIndex((row) => row.id === "plan-exec.final-validation")).toBeGreaterThan(
      secondClose,
    );

    // Cerrado el último batch, el recorrido entra en el CIERRE, y el cierre
    // empieza por el saldo: entre la última publicación de batch y la validación
    // final están las tres filas que saldan o reconocen las obligaciones. Con un
    // plan que no debe compensación las tres se pasan de largo solas y la
    // frontera vuelve a ser la validación final, pero eso lo decide el walk sobre
    // el estado, no la forma estática del recorrido que este test mide.
    const last = withBoundary(
      withPlanExecBatchLoop(state, { pending: false, iteration: null }),
      "plan-exec.settlement-authoring",
    );
    const finalJourney = journeyForState(last);
    expect(finalJourney.filter((row) => row.id === "plan-exec.batch-inference")).toHaveLength(1);
    expect(checkAgainstJourney(last, finalJourney)).toBeNull();
    expect(resolveBoundary(last, finalJourney).stopped?.id).toBe("plan-exec.settlement-authoring");
    // Y la validación final sigue detrás de las tres, nunca delante.
    const ids = finalJourney.map((row) => row.id);
    expect(ids.indexOf("plan-exec.final-validation")).toBeGreaterThan(
      ids.indexOf("plan-exec.settlement-publication"),
    );
  });
});
