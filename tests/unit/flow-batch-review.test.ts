import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceFlow, recoverFlowBoundary } from "../../src/application/flow/flow-service.js";
import { reopenRun } from "../../src/application/flow/reopen-run.js";
import { locateRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  applyTransition,
  sealRunState,
  serializeRunState,
  withBoundary,
  withReentry,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { batchReview } from "../helpers/batch-review.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";
import { planExecWalk } from "../helpers/plan-exec-walk.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const RUN = { code: "501", folder: "501-review-plan-exec", plan: "docs/plans/051-plan-review.md" };
const REVIEW = "plan-exec.review-findings";

describe("cada lote exige y conserva su revisión", () => {
  let root: string;
  let paths: PathsService;
  const fs = new NodeFileSystem();
  let walk: ReturnType<typeof planExecWalk>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-batch-review-"));
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
    await mkdir(join(root, "docs/plans"), { recursive: true });
    await mkdir(join(paths.cwdSessionsDir(), RUN.folder), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), RUN.folder, "SESSION.md"),
      "# SESSION\n\n## Objective\nrevisión\n",
    );
    await writeFile(
      join(root, RUN.plan),
      [
        "# Plan 051",
        "> Standalone: prueba",
        "> Límite de ejecución: checkout",
        "## Tasks",
        ...[1, 2].flatMap((n) => [
          `### F${n} — fase`,
          "> Estado: pendiente",
          "> Fuentes: workspace",
          `- [ ] T${n}.1 — trabajo _(fuentes: workspace)_`,
        ]),
        "",
        "## Execution batches",
        "- B1 · isolated · F1",
        "- B2 · isolated · F2",
        "",
      ].join("\n"),
    );
    walk = planExecWalk(
      { fs, paths, env: new FakeEnv(root, root), git: new RecordingGit() },
      { sources: ["workspace"] },
    );
    await walk.walkTo(RUN, REVIEW);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function answer(review: unknown) {
    const { resolved } = await walk.current(RUN.folder);
    const result = await submitFlow(fs, paths, {
      code: RUN.code,
      approval: null,
      executor: walk.executor(),
      raw: JSON.stringify({ input_digest: resolved.seal, decisions: { review } }),
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.directive;
  }

  it.each([
    undefined,
    { ...batchReview(), reviewer: { kind: "person", id: "author" } },
    { ...batchReview(), reviewer: { kind: "clean-reread", id: "author" } },
    { ...batchReview(), findings: [{ id: "R1", detail: "error", resolution: "fixed" }] },
  ])("rechaza revisión ausente, autor o corrección sin revisión (%j)", async (review) => {
    expect((await answer(review)).error?.code).toBe("PLAN_EXEC_BATCH_REVIEW_INVALID");
    expect((await walk.current(RUN.folder)).state.batches?.[0]?.review).toBeUndefined();
    expect(await readFile(join(root, RUN.plan), "utf8")).not.toContain("[x]");
  });

  it("admite la relectura limpia explícita sin subagentes", async () => {
    const review = {
      ...batchReview(),
      reviewer: { kind: "clean-reread", id: "author", no_subagents: true },
    };
    expect((await answer(review)).error).toBeNull();
    expect((await walk.current(RUN.folder)).state.batches?.[0]?.review).toEqual(review);
  });

  it("cada corrección exige un revisor que no implementó ni el lote ni la corrección", async () => {
    const review = {
      ...batchReview(),
      findings: [{ id: "R1", detail: "error", resolution: "fixed" }],
      corrections: [
        {
          findings: ["R1"],
          implementers: ["fixer"],
          reviewer: { kind: "subagent", id: "fixer" },
          detail: "corrección revisada",
        },
      ],
    };
    expect((await answer(review)).error?.code).toBe("PLAN_EXEC_BATCH_REVIEW_INVALID");
    review.corrections[0].reviewer.id = "second-reviewer";
    expect((await answer(review)).error).toBeNull();
  });

  it("batch-close no escribe sin revisión aunque ya tenga crédito", async () => {
    const { state } = await walk.current(RUN.folder);
    const before = await readFile(join(root, RUN.plan), "utf8");
    const result = await walk.executor()(
      { operation: "plan-exec.batch-close" },
      {
        session: RUN.folder,
        code: RUN.code,
        scope: state.scope,
        proposal: null,
        state_digest: state.digest,
      },
    );
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.output).code).toBe("PLAN_EXEC_BATCH_REVIEW_MISSING");
    expect(await readFile(join(root, RUN.plan), "utf8")).toBe(before);
  });

  it("agotamiento no salta la revisión; recover devuelve una frontera contestable", async () => {
    for (let n = 0; n < 3; n++) {
      await answer({
        ...batchReview(),
        detail: `intento ${n}`,
        reviewer: { kind: "person", id: "author" },
      });
    }
    const advanced = await advanceFlow(fs, paths, { code: RUN.code, executor: walk.executor() });
    if (!advanced.ok) throw new Error(JSON.stringify(advanced));
    expect(advanced.directive.boundary.transition).toBe(REVIEW);
    expect((await walk.current(RUN.folder)).state.skipped).not.toContain(REVIEW);
    await recoverFlowBoundary(fs, paths, { code: RUN.code });
    expect((await answer(batchReview())).error).toBeNull();
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("continúa un cierre v13 (omitida: %s, cerrada y reabierta: %s)", async (omitted, closed) => {
    const { state } = await walk.current(RUN.folder);
    let passed = withBoundary(applyTransition(state, REVIEW), "plan-exec.batch-close");
    if (closed) {
      passed = withBoundary(
        applyTransition(
          withReentry(passed, {
            kind: "close",
            transition: "plan-exec.batch-close",
            occurrence: 1,
            from: null,
          }),
          "chassis.finalize",
        ),
        null,
      );
    }
    const { digest: _digest, ...body } = passed;
    const legacy = sealRunState({
      ...body,
      version: 13,
      journey_base: body.journey_base?.filter((id) => !id.startsWith("plan-exec.batch-commit")),
      skipped: omitted ? [...body.skipped, REVIEW] : body.skipped,
    });
    await writeFile(locateRun(paths, RUN.folder).statePath, serializeRunState(legacy));
    if (closed) expect((await reopenRun(fs, locateRun(paths, RUN.folder))).ok).toBe(true);
    const advanced = await advanceFlow(fs, paths, { code: RUN.code, executor: walk.executor() });
    if (!advanced.ok) throw new Error(JSON.stringify(advanced));
    expect(advanced.directive.boundary.transition).toBe(REVIEW);
    const aligned = (await walk.current(RUN.folder)).state;
    expect(aligned.applied.filter((id) => !id.startsWith("plan-exec.batch-commit"))).toEqual(
      passed.applied,
    );
    expect(aligned.skipped).toEqual(
      expect.arrayContaining([
        "plan-exec.batch-commit-proposal",
        "plan-exec.batch-commit-authorization",
        "plan-exec.batch-commit",
      ]),
    );
    expect((await answer(batchReview())).error).toBeNull();
    expect(await readFile(join(root, RUN.plan), "utf8")).toContain("[x] T1.1");
  });

  it("dos lotes conservan revisiones propias y publican sus tareas", async () => {
    expect((await answer(batchReview("reviewer-1"))).error).toBeNull();
    await walk.walkTo(RUN, REVIEW);
    const midway = (await walk.current(RUN.folder)).state.batches;
    expect(midway?.[0]?.review?.reviewer.id).toBe("reviewer-1");
    expect(midway?.[1]?.review).toBeUndefined();
    expect((await answer(batchReview("reviewer-2"))).error).toBeNull();
    expect(
      (await walk.current(RUN.folder)).state.batches?.map((b) => b.review?.reviewer.id),
    ).toEqual(["reviewer-1", "reviewer-2"]);
    await walk.walkTo(RUN, "plan-exec.final-validation");
    expect(await readFile(join(root, RUN.plan), "utf8")).toContain("[x] T2.1");
  });
});
