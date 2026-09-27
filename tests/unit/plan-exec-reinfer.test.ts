import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { internalActionExecutor } from "../../src/application/flow/internal-actions.js";
import {
  applyReinferBatch,
  previewReinferBatch,
} from "../../src/application/flow/reinfer-batch.js";
import { journeyForRun } from "../../src/application/flow/run-journey.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { inferPlanExecBatch } from "../../src/application/plan-exec-batch-service.js";
import { sealedPlanPath } from "../../src/application/plan-exec-plan-diff.js";
import { flowCommand } from "../../src/cli/commands/flow.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import {
  attemptAccountingAt,
  newRunState,
  sealRunState,
  serializeRunState,
  withPlanExecBatch,
  withPlanExecBatchLoop,
  withScope,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { batchReview } from "../helpers/batch-review.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";

const PLAN =
  "# Plan 001\n> Estado: open\n## Tasks\n### F1 — trabajo\n> Estado: pendiente\n> Fuentes: workspace\n- [ ] T1.1 — cambiar _(fuentes: workspace)_\n";
const SESSION = "001-sellos-plan-exec";
const DOCUMENT = "docs/plans/001-plan-sellos.md";

describe("recover --reinfer-batch", () => {
  let root = "";
  const fs = new NodeFileSystem();
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function seed() {
    root = mkdtempSync(join(tmpdir(), "aw-reinfer-"));
    const paths = new PathsService(normalizeNamespace("workflow"), root, root);
    const location = locateRun(paths, SESSION);
    mkdirSync(join(root, "docs/plans"), { recursive: true });
    mkdirSync(join(location.dir, ".plan-seals"), { recursive: true });
    writeFileSync(
      join(location.dir, "SESSION.md"),
      "# SESSION\n## Objective\nprobar recuperación\n",
    );
    writeFileSync(join(root, DOCUMENT), PLAN);
    const inferred = inferPlanExecBatch(PLAN, {
      id: "batch-1",
      iteration: 1,
      mode: "isolated",
      phases: [1],
    });
    if (!inferred.ok) throw new Error(inferred.failure.message);
    writeFileSync(sealedPlanPath(location.dir, inferred.batch.plan_digest), PLAN);
    let state = withScope(newRunState("plan-exec", SESSION), {
      plan: DOCUMENT,
      sources: ["workspace"],
    });
    state = withPlanExecBatchLoop(withPlanExecBatch(state, inferred.batch), {
      pending: true,
      iteration: 1,
    });
    const journey = journeyForRun(state);
    const at = journey.findIndex((row) => row.id === "plan-exec.batch-close");
    if (at < 0) throw new Error("no hay cierre de lote");
    const { digest: _seal, ...body } = state;
    state = sealRunState({
      ...body,
      applied: journey.slice(0, at).map((row) => row.id),
      boundary: "plan-exec.batch-close",
      batches: [
        {
          ...inferred.batch,
          stage: "reviewing",
          credit: { workspace: "prueba vieja" },
          review: batchReview(),
        },
      ],
    });
    writeFileSync(location.statePath, serializeRunState(state));
    return { paths, location, state };
  }

  it("muestra el diff sin escribir y re-sella el mismo lote, descartando validación y revisión", async () => {
    const { paths, location } = seed();
    const changed = PLAN.replace("cambiar", "cambiar de verdad");
    writeFileSync(join(root, DOCUMENT), changed);
    const before = readFileSync(location.statePath, "utf8");
    const preview = await previewReinferBatch(fs, paths, SESSION);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.preview.diff).toContain("cambiar de verdad");
    expect(readFileSync(location.statePath, "utf8")).toBe(before);
    const applied = await applyReinferBatch(fs, paths, SESSION, preview.preview.approval_digest);
    expect(applied.ok).toBe(true);
    const read = await readRun(fs, location);
    if (!read.ok) throw new Error(read.failure.message);
    expect(read.state.batches?.[0]).toMatchObject({ id: "batch-1", phases: [1], tasks: ["T1.1"] });
    expect(read.state.batches?.[0]?.review).toBeUndefined();
    expect(read.state.batches?.[0]?.credit).toBeUndefined();
    expect(read.state.batch_trace?.at(-1)).toMatchObject({
      batch_id: "batch-1",
      stage: "inferred",
    });
    expect(
      readFileSync(
        sealedPlanPath(location.dir, read.state.batches?.[0]?.plan_digest ?? ""),
        "utf8",
      ),
    ).toBe(changed);
    expect(resolveBoundary(read.state, journeyForRun(read.state)).stopped?.id).toBe(
      "plan-exec.validation-execution",
    );
    const remaining = journeyForRun(read.state)
      .slice(read.state.applied.length)
      .map((row) => row.id);
    expect(remaining).toContain("plan-exec.review-findings");
    expect(remaining.indexOf("plan-exec.review-findings")).toBeLessThan(
      remaining.indexOf("plan-exec.batch-close"),
    );
  });

  it("la CLI muestra el diff antes de aplicar y no acepta la aprobación de un plan vuelto a cambiar", async () => {
    const { paths, location } = seed();
    writeFileSync(join(root, DOCUMENT), PLAN.replace("cambiar", "mejorar"));
    const git = new RecordingGit();
    const ctx = { fs, paths, git, env: new FakeEnv(root, root) } as CliContext;
    const args = (approval?: string) =>
      ({
        rest: ["recover"],
        flags: new Set(["--reinfer-batch"]),
        values: new Map([["session", "001"], ...(approval ? [["approval", approval]] : [])]),
        valuesMulti: new Map(),
        plugin: {},
      }) as unknown as ParsedArgs;
    const preview = await flowCommand.execute(args(), ctx);
    expect(preview.ok).toBe(true);
    if (!preview.data || !("reinfer_batch" in preview.data)) throw new Error("falta preview");
    expect(preview.data.diff).toContain("mejorar");
    const before = readFileSync(location.statePath, "utf8");
    writeFileSync(join(root, DOCUMENT), PLAN.replace("cambiar", "otro texto"));
    const stale = await flowCommand.execute(args(preview.data.approval_digest), ctx);
    expect(stale.ok).toBe(false);
    expect(readFileSync(location.statePath, "utf8")).toBe(before);
    const fresh = await flowCommand.execute(args(), ctx);
    if (!fresh.data || !("reinfer_batch" in fresh.data)) throw new Error("falta nueva preview");
    const applied = await flowCommand.execute(args(fresh.data.approval_digest), ctx);
    expect(applied.ok).toBe(true);
    if (applied.data && "boundary" in applied.data) {
      expect(applied.data.boundary.transition).toBe("plan-exec.validation-execution");
    }
  });

  it("no re-sella un conjunto de tareas distinto ni un lote publicado", async () => {
    const { paths, location, state } = seed();
    writeFileSync(join(root, DOCUMENT), `${PLAN}- [ ] T1.2 — extra _(fuentes: workspace)_\n`);
    expect(await previewReinferBatch(fs, paths, SESSION)).toMatchObject({
      ok: false,
      failure: { code: "PLAN_EXEC_BATCH_TASK_SET_INVALID" },
    });
    const batch = state.batches?.[0];
    if (batch === undefined) throw new Error("falta lote inferido");
    const { digest: _seal, ...body } = state;
    writeFileSync(
      location.statePath,
      serializeRunState(
        sealRunState({ ...body, batches: [{ ...batch, published_plan_digest: "publicado" }] }),
      ),
    );
    expect(await previewReinferBatch(fs, paths, SESSION)).toMatchObject({
      ok: false,
      failure: { code: "PLAN_EXEC_BATCH_ALREADY_PUBLISHED" },
    });
  });

  it("un lote antiguo sin copia y uno con publicación pendiente no se re-sellan", async () => {
    const { paths, location, state } = seed();
    rmSync(sealedPlanPath(location.dir, state.batches?.[0]?.plan_digest ?? ""));
    expect(await previewReinferBatch(fs, paths, SESSION)).toMatchObject({
      ok: false,
      failure: {
        code: "PLAN_EXEC_BATCH_SNAPSHOT_MISSING",
        message: expect.stringContaining("copia"),
      },
    });
    const batch = state.batches?.[0];
    if (batch === undefined) throw new Error("falta lote inferido");
    const { digest: _seal, ...body } = state;
    writeFileSync(
      location.statePath,
      serializeRunState(sealRunState({ ...body, batches: [{ ...batch, commit_result: {} }] })),
    );
    expect(await previewReinferBatch(fs, paths, SESSION)).toMatchObject({
      ok: false,
      failure: { code: "PLAN_EXEC_BATCH_PUBLICATION_PENDING" },
    });
  });

  it("tres avances sobre un plan cambiado no gastan intento; otro rechazo interno sí", async () => {
    const { paths, location, state } = seed();
    writeFileSync(join(root, DOCUMENT), PLAN.replace("cambiar", "cambiar el texto"));
    const git = new RecordingGit();
    const executor = internalActionExecutor({ fs, paths, git, env: new FakeEnv(root, root) });
    for (let i = 0; i < 3; i += 1) {
      const result = await advanceFlow(fs, paths, { code: "001", adopt: false, executor, git });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.directive.error?.code).toBe("PLAN_EXEC_BATCH_STALE");
    }
    const read = await readRun(fs, location);
    if (!read.ok) throw new Error(read.failure.message);
    expect(attemptAccountingAt(read.state, "plan-exec.batch-close").spent).toBe(0);
    const preview = await previewReinferBatch(fs, paths, SESSION);
    if (!preview.ok) throw new Error(preview.failure.message);
    const resealed = await applyReinferBatch(fs, paths, SESSION, preview.preview.approval_digest);
    expect(resealed.ok).toBe(true);
    const { digest: _seal, ...body } = state;
    const batch = state.batches?.[0];
    if (batch === undefined) throw new Error("falta lote inferido");
    writeFileSync(
      location.statePath,
      serializeRunState(
        sealRunState({
          ...body,
          batches: [
            {
              ...batch,
              snapshot: { workspace: { head: "base", branch: "aw/test", dirty: [] } },
            },
          ],
        }),
      ),
    );
    const rejected = await advanceFlow(fs, paths, { code: "001", adopt: false, executor, git });
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.directive.error?.code).toBe("FLOW_INTERNAL_ACTION_REFUSED");
    const after = await readRun(fs, location);
    if (!after.ok) throw new Error(after.failure.message);
    expect(attemptAccountingAt(after.state, "plan-exec.batch-close").spent).toBe(1);
  });
});
