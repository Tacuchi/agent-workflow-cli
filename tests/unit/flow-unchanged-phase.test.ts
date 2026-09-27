import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { applyAnnulment, prepareAnnulment } from "../../src/application/flow/annul-service.js";
import { proveFlowBoundary } from "../../src/application/flow/prove.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  APPROVE_UNCHANGED_PHASE,
  UNCHANGED_PHASE_CONSENT,
} from "../../src/domain/flow/unchanged-phase.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { planExecWalk } from "../helpers/plan-exec-walk.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

const RUN = {
  code: "501",
  folder: "501-unchanged-phase-plan-exec",
  plan: "docs/plans/051-plan-unchanged-phase.md",
};
const VALIDATE = "plan-exec.validation-execution";
const PLAN = [
  "# Plan 051",
  "> Standalone: integración de validación sin cambios",
  "> Estado: open",
  "> Límite de ejecución: checkout",
  "## Tasks",
  "### F2 — fase pendiente con trabajo ya hecho",
  "> Estado: pendiente",
  "> Fuentes: workspace",
  "- [x] T2.1 — trabajo previo _(fuentes: workspace)_",
  "### F3 — trabajo nuevo",
  "> Estado: pendiente",
  "> Fuentes: workspace",
  "- [ ] T3.1 — nuevo trabajo _(fuentes: workspace)_",
  "",
].join("\n");

describe("fase sin tareas abiertas: consentimiento, prueba real y crédito anulable", () => {
  const fs = new NodeFileSystem();
  let root: string;
  let cwd: string;
  let paths: PathsService;
  let deps: { fs: NodeFileSystem; paths: PathsService; env: FakeEnv; git: GitCliAdapter };
  let walk: ReturnType<typeof planExecWalk>;
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-unchanged-phase-"));
    cwd = join(root, "workspace");
    const home = join(root, "home");
    paths = new PathsService(normalizeNamespace("workflow"), home, cwd);
    await mkdir(join(cwd, "docs/plans"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(cwd, RUN.plan), PLAN);
    git("init", "--quiet", "--initial-branch=main");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "base",
    );
    await mkdir(join(paths.cwdSessionsDir(), RUN.folder), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), RUN.folder, "SESSION.md"),
      "# SESSION\n\n## Objective\nvalidar fase\n",
    );
    deps = { fs, paths, env: new FakeEnv(home, cwd), git: new GitCliAdapter(new NodeProcess()) };
    walk = planExecWalk(deps, { sources: ["workspace"] });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function answer(choice: string) {
    const { resolved } = await walk.current(RUN.folder);
    const result = await submitFlow(fs, paths, {
      code: RUN.code,
      approval: null,
      executor: walk.executor(),
      raw: JSON.stringify({ input_digest: resolved.seal, choice }),
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.directive;
  }
  async function validate(detail = "Tests 1 passed (1)") {
    const { resolved } = await walk.current(RUN.folder);
    expect(resolved.stopped?.id).toBe(VALIDATE);
    const proof = await proveFlowBoundary(fs, paths, { code: RUN.code, git: deps.git });
    if (!proof.ok) throw new Error(JSON.stringify(proof));
    const result = await submitFlow(fs, paths, {
      code: RUN.code,
      approval: null,
      executor: walk.executor(),
      git: deps.git,
      raw: JSON.stringify({
        input_digest: resolved.seal,
        outcome: "completed",
        invocation: resolved.action?.invocation,
        validations: [
          { id: "plan.validaciones-de-fase-verdes", passed: true, detail },
          {
            id: "workline.source-bounded",
            passed: true,
            detail: "checkout sin cambios",
            proof: proof.receipt.proof,
          },
        ],
        effects: { planned: ["execute"], approved: ["execute"], applied: ["execute"] },
      }),
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.directive;
  }
  async function approve() {
    await walk.walkTo(RUN, UNCHANGED_PHASE_CONSENT);
    const { state, resolved } = await walk.current(RUN.folder);
    expect(state.plan_exec_entry?.phases_without_open_tasks).toEqual([2]);
    expect(resolved.kind).toBe("human");
    expect((await answer(APPROVE_UNCHANGED_PHASE)).error).toBeNull();
  }

  it("sin consentimiento no empieza; la fase aprobada no se reimplementa y F3 sigue exigiendo cambios", async () => {
    await walk.walkTo(RUN, UNCHANGED_PHASE_CONSENT);
    await answer("Compactar");
    expect((await walk.current(RUN.folder)).state.batches ?? []).toEqual([]);
    expect(await readFile(join(cwd, RUN.plan), "utf8")).toBe(PLAN);
    await answer(APPROVE_UNCHANGED_PHASE);
    await walk.walkTo(RUN, VALIDATE);
    const { state } = await walk.current(RUN.folder);
    expect(state.batches?.[0]).toMatchObject({ kind: "validation-only", phases: [2], tasks: [] });
    expect(state.skipped).toContain("plan-exec.implementation");
    expect((await validate()).error).toBeNull();
    await walk.walkTo(RUN, "plan-exec.batch-eligibility-signal");
    const credited = (await walk.current(RUN.folder)).state.batches?.[0];
    expect(credited?.credit).toBeDefined();
    expect(credited?.published_plan_digest).toBeDefined();
    expect(await readFile(join(cwd, RUN.plan), "utf8")).toContain("- [x] T2.1");
    await walk.walkTo(RUN, VALIDATE);
    expect((await validate()).error?.code).toBe("PLAN_EXEC_BATCH_UNCHANGED");
    expect(await readFile(join(cwd, RUN.plan), "utf8")).toContain("- [ ] T3.1");
  });

  it("tener aprobación no permite acreditar una suite vacía", async () => {
    await approve();
    await walk.walkTo(RUN, VALIDATE);
    expect((await validate("No test files found, exiting with code 1")).error?.code).toBe(
      "PLAN_TEST_RUN_NOT_EXECUTED",
    );
    expect((await walk.current(RUN.folder)).state.batches?.[0]?.credit).toBeUndefined();
  });

  it("sin fases así no aparece consentimiento y una tarea abierta nunca queda exenta", async () => {
    await writeFile(join(cwd, RUN.plan), PLAN.replace("[x] T2.1", "[ ] T2.1"));
    await walk.walkTo(RUN, VALIDATE);
    const { state } = await walk.current(RUN.folder);
    expect(state.skipped).toContain(UNCHANGED_PHASE_CONSENT);
    expect(state.batches?.[0]?.kind).toBeUndefined();
    expect((await validate()).error?.code).toBe("PLAN_EXEC_BATCH_UNCHANGED");
  });

  it("una tarea reabierta después de inferir el lote invalida la excepción", async () => {
    await approve();
    await walk.walkTo(RUN, VALIDATE);
    await writeFile(join(cwd, RUN.plan), PLAN.replace("[x] T2.1", "[ ] T2.1"));
    expect((await validate()).error?.code).toBe("PLAN_VALIDATION_ONLY_NOT_APPROVED");
  });

  it("annul muestra el tipo, reabre sólo el estado de F2 y no sus tareas previas ni git", async () => {
    await approve();
    await walk.walkTo(RUN, VALIDATE);
    await validate();
    await walk.walkTo(RUN, "plan-exec.batch-eligibility-signal");
    const head = git("rev-parse", "HEAD");
    const input = { code: RUN.code, from: "1", env: deps.env, executor: walk.executor() };
    const preview = await prepareAnnulment(fs, paths, input);
    if (!preview.ok) throw new Error(JSON.stringify(preview));
    expect(preview.preview.batches).toEqual([
      { id: "batch-1", kind: "validation-only", phases: [2], tasks: [] },
    ]);
    expect(
      (await applyAnnulment(fs, paths, { ...input, approval: preview.preview.digest })).ok,
    ).toBe(true);
    const plan = await readFile(join(cwd, RUN.plan), "utf8");
    expect(plan).toContain("### F2 — fase pendiente con trabajo ya hecho\n> Estado: pendiente");
    expect(plan).toContain("- [x] T2.1");
    expect(git("rev-parse", "HEAD")).toBe(head);
  });
});
