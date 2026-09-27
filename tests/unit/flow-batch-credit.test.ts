import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow, restartFlow } from "../../src/application/flow/flow-service.js";
import { internalActionExecutor } from "../../src/application/flow/internal-actions.js";
import { proveFlowBoundary } from "../../src/application/flow/prove.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { type FlowDecision, effectsOf, journeyForState } from "../../src/domain/flow/authority.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import { batchCreditVerdict } from "../../src/domain/flow/execution-result.js";
import type { FlowRunState, PlanExecBatch } from "../../src/domain/flow/run-state.js";
import { SOURCE_BOUNDED_EVIDENCE } from "../../src/domain/source-boundary.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { batchReview } from "../helpers/batch-review.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { planExecWalk } from "../helpers/plan-exec-walk.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * Un lote sólo se acredita con la prueba propia de su checkout (plan 049, F2 ·
 * spec 052 AC-01).
 *
 * Sobre un hub real: el workspace vive DENTRO de un repositorio git más grande,
 * al lado de un proyecto vecino, y su `.gitignore` NO ignora la carpeta de
 * sesiones. Es el caso que más fácil acreditaría un lote sin trabajo: un cambio
 * del vecino o un CHECKPOINT moverían una huella de todo el repo.
 */

const fs = new NodeFileSystem();
const PLAN = "docs/plans/051-plan-credito.md";
const RUN = { code: "501", folder: "501-credito-plan-exec", plan: PLAN };
const VALIDATION = "plan-exec.validation-execution";
const PLAN_TEXT = [
  "# Plan 051 — crédito",
  "",
  "> Standalone: prueba de acreditación por lote",
  "> Límite de ejecución: checkout",
  "",
  "## Tasks",
  "",
  "### F3 — tres",
  "> Estado: pendiente",
  "> Fuentes: workspace",
  "",
  "- [ ] T3.1 — tres _(fuentes: workspace)_",
  "",
  "### F4 — cuatro",
  "> Estado: pendiente",
  "> Fuentes: workspace",
  "",
  "- [ ] T4.1 — cuatro _(fuentes: workspace)_",
  "",
].join("\n");

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

describe("un lote se acredita sólo con la prueba propia de su checkout", () => {
  let root: string;
  let hub: string;
  let workspace: string;
  let paths: PathsService;
  let deps: { fs: NodeFileSystem; env: FakeEnv; git: GitCliAdapter; paths: PathsService };
  let walk: ReturnType<typeof planExecWalk>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "aw-batch-credit-"));
    hub = join(root, "hub");
    workspace = join(hub, "ws");
    const home = join(root, "home");
    await mkdir(join(workspace, "docs", "plans"), { recursive: true });
    await mkdir(join(hub, "vecino"), { recursive: true });
    await mkdir(home, { recursive: true });
    paths = new PathsService(normalizeNamespace("agent-workflow"), home, workspace);
    deps = {
      fs,
      env: new FakeEnv(home, workspace),
      git: new GitCliAdapter(new NodeProcess()),
      paths,
    };
    walk = planExecWalk(deps, { sources: ["workspace"] });
    await writeFile(join(workspace, PLAN), PLAN_TEXT, "utf8");
    await writeFile(join(workspace, "docs", "nota.md"), "# nota\n", "utf8");
    await writeFile(join(hub, "vecino", "README.md"), "# vecino\n", "utf8");
    git(hub, "init", "--quiet", "--initial-branch=main");
    git(hub, "config", "user.email", "t@example.com");
    git(hub, "config", "user.name", "T");
    git(hub, "add", "-A");
    git(hub, "commit", "--quiet", "-m", "inicial");
    const session = join(paths.cwdSessionsDir(), RUN.folder);
    await mkdir(session, { recursive: true });
    await writeFile(
      join(session, "SESSION.md"),
      "# SESSION\n\n## Objective\nprobar\n\n## Success criteria\n- [ ] uno\n",
      "utf8",
    );
    await writeFile(join(session, "CHECKPOINT.md"), "# CHECKPOINT\n\n## Completed\n", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function current(): Promise<{
    state: FlowRunState;
    resolved: ReturnType<typeof resolveBoundary>;
  }> {
    const read = await readRun(fs, locateRun(paths, RUN.folder));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return {
      state: read.state,
      resolved: resolveBoundary(read.state, journeyForState(read.state)),
    };
  }

  /**
   * Answer the phase validation standing now, with the REAL proof of the checkout
   * as it is at this moment and the given `detail` — the same thing an agent
   * would paste after `aw flow prove`.
   */
  async function validate(detail: string): Promise<FlowDirective> {
    const { resolved } = await current();
    expect(resolved.stopped?.id).toBe(VALIDATION);
    const proved = await proveFlowBoundary(fs, paths, { code: RUN.code, git: deps.git });
    if (!proved.ok) throw new Error(`esperaba una prueba: ${JSON.stringify(proved)}`);
    const stopped = resolved.stopped as FlowDecision;
    const result = await submitFlow(fs, paths, {
      code: RUN.code,
      raw: JSON.stringify({
        input_digest: resolved.seal,
        outcome: "completed",
        invocation: resolved.action?.invocation,
        validations: [
          { id: "plan.validaciones-de-fase-verdes", passed: true, detail },
          {
            id: SOURCE_BOUNDED_EVIDENCE,
            passed: true,
            detail: "prueba del checkout del lote",
            proof: proved.receipt.proof,
          },
        ],
        effects: {
          planned: [...effectsOf(stopped)],
          approved: [...effectsOf(stopped)],
          applied: [...effectsOf(stopped)],
        },
      }),
      approval: null,
      executor: internalActionExecutor(deps),
      git: deps.git,
    });
    if (!result.ok)
      throw new Error(`un rechazo de negocio viaja ok:true: ${JSON.stringify(result)}`);
    return result.directive;
  }

  /** Close the batch that was just credited and stand on the next phase validation. */
  async function nextBatch(): Promise<void> {
    await walk.walkTo(RUN, "plan-exec.batch-eligibility-signal");
    await walk.walkTo(RUN, VALIDATION);
  }

  const touch = (relative: string, body: string) =>
    writeFile(join(workspace, relative), body, "utf8");

  it("submit lee los rojos de la fase del lote, nunca los de la fase siguiente", async () => {
    const baseline =
      '> Rojos previos: [{"file":"tests/a.test.ts","case":"one"},{"file":"tests/a.test.ts","case":"two"}]';
    await touch(
      PLAN,
      PLAN_TEXT.replace("### F3 — tres", `### F3 — tres\n${baseline}`).replace(
        "### F4 — cuatro",
        '### F4 — cuatro\n> Rojos previos: [{"file":"tests/a.test.ts","case":"three"}]',
      ),
    );
    await walk.walkTo(RUN, VALIDATION);
    await touch("docs/nota.md", "# cambios F3\n");
    const old = "FAIL tests/a.test.ts > one\nFAIL tests/a.test.ts > two\nTests 2 failed (2)";
    expect((await validate(`${old}\nFAIL tests/a.test.ts > three`)).error?.code).toBe(
      "PLAN_TEST_FAILURE_NEW",
    );
    expect((await validate(old)).error).toBeNull();
    await nextBatch();
    await touch("docs/nota.md", "# cambios F4\n");
    expect((await validate(old)).error?.code).toBe("PLAN_TEST_FAILURE_NEW");
  });

  it("sobre reciclado de otra fase: F4 con el detail de F3 y sin cambios se rechaza y queda abierta", async () => {
    await walk.walkTo(RUN, VALIDATION);
    await touch("docs/nota.md", "# nota\n\nF3 escribió esto.\n");
    const credited = await validate("tsc: 0 errores");
    expect(credited.error).toBeNull();
    await nextBatch();

    // Nada cambió desde la base de F4. Lo único posterior a F3 es el plan que su
    // cierre publicó, y eso ya estaba en la base: no es trabajo de F4.
    const refused = await validate("tsc: 0 errores");
    expect(refused.error?.code).toBe("PLAN_EXEC_BATCH_UNCHANGED");
    expect(refused.error?.message).toContain("batch-2");
    expect(refused.error?.message).toContain("el cierre del batch anterior");
    expect(refused.error?.message).toContain("'workspace' no cambió");
    const { state, resolved } = await current();
    expect(resolved.stopped?.id).toBe(VALIDATION);
    const batch = state.batches?.find((entry) => entry.iteration === 2);
    expect(batch?.credit).toBeUndefined();
    const plan = await readFile(join(workspace, PLAN), "utf8");
    expect(plan).toContain("- [ ] T4.1");
    expect(plan).toMatch(/### F4 — cuatro\n> Estado: pendiente/);
  });

  it("dos lotes legítimos con la misma salida se acreditan los dos", async () => {
    await walk.walkTo(RUN, VALIDATION);
    await touch("docs/nota.md", "# nota\n\nF3.\n");
    expect((await validate("tsc: 0 errores")).error).toBeNull();
    await nextBatch();
    await touch("docs/otra.md", "# otra\n\nF4.\n");
    expect((await validate("tsc: 0 errores")).error).toBeNull();
    const { state } = await current();
    const credits = (state.batches ?? []).map((batch) => batch.credit?.workspace);
    expect(credits).toHaveLength(2);
    expect(credits.every((digest) => typeof digest === "string")).toBe(true);
    expect(credits[0]).not.toBe(credits[1]);
  });

  it("el primer lote sin cambios desde el inicio de la corrida no se acredita", async () => {
    await walk.walkTo(RUN, VALIDATION);
    const refused = await validate("sin cambios");
    expect(refused.error?.code).toBe("PLAN_EXEC_BATCH_UNCHANGED");
    expect(refused.error?.message).toContain("el inicio de la corrida");
    await touch("docs/nota.md", "# nota\n\nahora sí.\n");
    expect((await validate("con cambios")).error).toBeNull();
  });

  it("un lote que sólo toca la sesión no se acredita aunque el .gitignore no la ignore; uno que toca docs/ sí", async () => {
    // La premisa: git ve la carpeta de sesiones como no rastreada, no ignorada.
    const namespace = relative(workspace, paths.cwdSessionsDir()).split(sep)[0];
    expect(git(hub, "status", "--porcelain")).toContain(`ws/${namespace}/`);
    await walk.walkTo(RUN, VALIDATION);
    await writeFile(
      join(paths.cwdSessionsDir(), RUN.folder, "CHECKPOINT.md"),
      "# CHECKPOINT\n\n## Completed\n- F3 hecha\n",
      "utf8",
    );
    expect((await validate("sólo la sesión")).error?.code).toBe("PLAN_EXEC_BATCH_UNCHANGED");
    await touch("docs/nota.md", "# nota\n\nF3 en docs.\n");
    expect((await validate("docs")).error).toBeNull();
  });

  it("un cambio en un proyecto vecino del mismo repo no acredita un lote del workspace", async () => {
    await walk.walkTo(RUN, VALIDATION);
    await writeFile(join(hub, "vecino", "README.md"), "# vecino\n\notro trabajo\n", "utf8");
    await writeFile(join(hub, "vecino", "nuevo.md"), "nuevo\n", "utf8");
    expect((await validate("vecino")).error?.code).toBe("PLAN_EXEC_BATCH_UNCHANGED");
  });

  it("la ruta no puede omitir la validación de fase: la propuesta se rechaza como gate duro", async () => {
    const adopted = await advanceFlow(fs, paths, {
      code: RUN.code,
      flow: "plan-exec",
      adopt: true,
      executor: internalActionExecutor(deps),
    });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    const { resolved } = await current();
    expect(resolved.stopped?.id).toBe("chassis.route-evaluation");
    const proposed = await submitFlow(fs, paths, {
      code: RUN.code,
      raw: JSON.stringify({
        input_digest: resolved.seal,
        decisions: {
          route: {
            summary: { finding: "f", diagnosis: "d", solution: "s" },
            basis: { intention: "i", checkout: "c", conventions: "v", adopted_decisions: "a" },
            controls: [{ transition: VALIDATION, disposition: "omit", reason: "sin pruebas" }],
          },
        },
      }),
      approval: null,
      executor: internalActionExecutor(deps),
    });
    if (!proposed.ok) throw new Error("un rechazo de negocio viaja ok:true");
    expect(proposed.directive.error?.code).toBe("FLOW_ROUTE_HARD_GATE");
    expect(proposed.directive.error?.message).toContain("no admite 'omit'");
    expect((await current()).state.route_proposal).toBeNull();
  });

  it("tras 'aw flow restart' el lote re-inferido hereda su base: el trabajo ya hecho sigue contando", async () => {
    await walk.walkTo(RUN, VALIDATION);
    const before = (await current()).state.batches?.[0]?.base;
    await touch("docs/nota.md", "# nota\n\ntrabajo de F3 antes del reinicio\n");
    const restarted = await restartFlow(fs, paths, {
      code: RUN.code,
      executor: internalActionExecutor(deps),
    });
    if (!restarted.ok) throw new Error(`esperaba reiniciar: ${JSON.stringify(restarted)}`);
    await walk.walkTo(RUN, VALIDATION);
    const { state } = await current();
    expect(state.inherited_bases?.[0]).toEqual({ phases: [3], base: before });
    expect(state.batches?.[0]?.base).toEqual(before);
    expect((await validate("tsc: 0 errores")).error).toBeNull();
  });

  it("una fuente que es repo pero git no puede medir no sella su base: la adquisición se niega", async () => {
    class Unmeasurable extends GitCliAdapter {
      override async scopedFingerprint(): Promise<string> {
        throw new Error("index.lock: otro proceso de git está corriendo");
      }
    }
    const broken = { ...deps, git: new Unmeasurable(new NodeProcess()) };
    const brokenWalk = planExecWalk(broken, { sources: ["workspace"] });
    await expect(brokenWalk.walkTo(RUN, VALIDATION)).rejects.toThrow(
      "no se pudo medir 'workspace'",
    );
    const { state, resolved } = await current();
    expect(resolved.stopped?.id).toBe("plan-exec.unit-acquisition");
    expect(state.batches?.[0]?.base).toBeUndefined();
    // Resuelta la causa, la misma frontera sella la base real.
    await walk.walkTo(RUN, VALIDATION);
    expect((await current()).state.batches?.[0]?.base?.workspace).toMatch(/^sha256:/);
  });

  it("la base se sella al adquirir las unidades del lote y no se mueve al reintentar", async () => {
    await walk.walkTo(RUN, VALIDATION);
    const { state } = await current();
    const base = state.batches?.[0]?.base;
    expect(Object.keys(base ?? {})).toEqual(["workspace"]);
    expect(base?.workspace).toMatch(/^sha256:/);
    // Con trabajo ya en el árbol, una re-adquisición que volviera a medir daría
    // otra huella: la base tiene que seguir siendo la de antes del trabajo.
    await touch("docs/nota.md", "# nota\n\ncambio\n");
    const again = await internalActionExecutor(deps)(
      { operation: "worktree.ensure" },
      {
        session: RUN.folder,
        code: RUN.code,
        scope: state.scope,
        proposal: null,
        state_digest: state.digest,
      },
    );
    expect(again.ok).toBe(true);
    expect((await current()).state.batches?.[0]?.base).toEqual(base);
  });
});

describe("batch-close se niega sin acreditación", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-batch-uncredited-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(workdir, "docs", "plans"), { recursive: true });
    await writeFile(join(workdir, PLAN), PLAN_TEXT, "utf8");
    await mkdir(join(paths.cwdSessionsDir(), RUN.folder), { recursive: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function standAtClose(batch: Partial<PlanExecBatch>): Promise<FlowRunState> {
    const { inferPlanExecBatch } = await import("../../src/application/plan-exec-batch-service.js");
    const { newRunState, sealRunState, serializeRunState, FLOW_RUN_STATE_FILE } = await import(
      "../../src/domain/flow/run-state.js"
    );
    const inferred = inferPlanExecBatch(PLAN_TEXT, {
      id: "batch-1",
      iteration: 1,
      mode: "continuous",
      phases: [3],
    });
    if (!inferred.ok) throw new Error(inferred.failure.message);
    const { digest: _seal, ...fresh } = newRunState("plan-exec", RUN.folder);
    const state = sealRunState({
      ...fresh,
      scope: { plan: PLAN, sources: ["workspace"] },
      batches: [{ ...inferred.batch, stage: "reviewing", ...batch }],
    });
    await writeFile(
      join(paths.cwdSessionsDir(), RUN.folder, FLOW_RUN_STATE_FILE),
      serializeRunState(state),
      "utf8",
    );
    return state;
  }

  const close = (state: FlowRunState) =>
    internalActionExecutor({
      fs,
      env: new FakeEnv(workdir, workdir),
      git: new GitCliAdapter(new NodeProcess()),
      paths,
    })(
      { operation: "plan-exec.batch-close" },
      { session: RUN.folder, code: RUN.code, scope: state.scope, proposal: null },
    );

  it("un lote heredado sin base cierra sin crédito, con su revisión registrada", async () => {
    const outcome = await close(await standAtClose({ review: batchReview() }));
    expect(outcome.ok).toBe(true);
    expect(await readFile(join(workdir, PLAN), "utf8")).toContain("- [x] T3.1");
  });

  it("un lote que nació con base y llega al cierre sin crédito no publica el plan", async () => {
    const outcome = await close(await standAtClose({ base: { workspace: "sha256:base" } }));
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toContain("no tiene acreditación");
    expect(outcome.output).toContain("PLAN_EXEC_BATCH_UNCREDITED");
    expect(await readFile(join(workdir, PLAN), "utf8")).toBe(PLAN_TEXT);
  });
});

/** The judgment itself, over several sources and prior credits. */
describe("batchCreditVerdict — una prueba por fuente, y basta un cambio propio", () => {
  const batch = (overrides: Partial<PlanExecBatch>): PlanExecBatch => ({
    id: "batch-2",
    iteration: 2,
    mode: "continuous",
    phases: [2],
    tasks: ["T2.1"],
    plan_digest: "sha256:plan",
    stage: "validating",
    ...overrides,
  });
  const proof = (source: string, digest: string) => ({
    id: SOURCE_BOUNDED_EVIDENCE,
    passed: true,
    detail: `prueba de ${source}`,
    proof: {
      kind: "command" as const,
      source,
      relative_cwd: ".",
      checkout_digest: digest,
      invocation: { program: "aw", args: ["session-artifacts"] },
    },
  });
  const result = (...validations: ReturnType<typeof proof>[]) => ({
    outcome: "completed" as const,
    invocation: { program: "aw", args: [], target: ".", input: null },
    validations,
    effects: { planned: [], approved: [], applied: [] },
    output: null,
  });
  const sources = ["workspace", "acme"];
  const base = { workspace: "sha256:w0", acme: "sha256:a0" };

  it("un lote de dos fuentes con una sola cambiada se acredita", () => {
    const current = batch({ base });
    const verdict = batchCreditVerdict(
      result(proof("workspace", "d-w"), proof("acme", "d-a")),
      {
        batch: current,
        batches: [current],
        sources,
        scoped: { workspace: "sha256:w0", acme: "sha256:a1" },
      },
      "recuperá",
    );
    expect(verdict).toEqual({ ok: true, credit: { workspace: "d-w", acme: "d-a" } });
  });

  it("falta la prueba de una fuente: se nombra cuál", () => {
    const current = batch({ base });
    const verdict = batchCreditVerdict(
      result(proof("workspace", "d-w")),
      {
        batch: current,
        batches: [current],
        sources,
        scoped: { workspace: "sha256:w1", acme: "sha256:a0" },
      },
      "recuperá",
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal.detail.code).toBe("WORKLINE_CHECKOUT_PROOF_MISSING");
    expect(verdict.refusal.message).toContain("'acme'");
  });

  it("una prueba que ya acreditó otro lote no cuenta como cambio propio", () => {
    const previous = batch({
      id: "batch-1",
      iteration: 1,
      credit: { workspace: "d-w", acme: "d-a" },
    });
    const current = batch({ base });
    // Cambió `acme`, pero su prueba es la misma que ya acreditó batch-1.
    const verdict = batchCreditVerdict(
      result(proof("workspace", "d-w2"), proof("acme", "d-a")),
      {
        batch: current,
        batches: [previous, current],
        sources,
        scoped: { workspace: "sha256:w0", acme: "sha256:a1" },
      },
      "recuperá",
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal.detail.code).toBe("PLAN_EXEC_BATCH_UNCHANGED");
    expect(verdict.refusal.message).toContain("ya acreditó batch-1");
  });

  it("todas las pruebas recicladas de otro lote se rechazan aunque el lote no tenga base", () => {
    const previous = batch({
      id: "batch-1",
      iteration: 1,
      credit: { workspace: "d-w", acme: "d-a" },
    });
    const current = batch({});
    const verdict = batchCreditVerdict(
      result(proof("workspace", "d-w"), proof("acme", "d-a")),
      { batch: current, batches: [previous, current], sources, scoped: null },
      "recuperá",
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal.detail.code).toBe("PLAN_EXEC_PROOF_REUSED");
  });

  it("un lote en curso al actualizar, sin base, se juzga sólo contra las acreditaciones", () => {
    const current = batch({});
    const verdict = batchCreditVerdict(
      result(proof("workspace", "d-w"), proof("acme", "d-a")),
      {
        batch: current,
        batches: [current],
        sources,
        scoped: { workspace: "sha256:w0", acme: "sha256:a0" },
      },
      "recuperá",
    );
    expect(verdict.ok).toBe(true);
  });

  it("una fuente que no se pudo observar al empezar el lote no demuestra cambio", () => {
    const current = batch({ base: { workspace: null, acme: "sha256:a0" } });
    const verdict = batchCreditVerdict(
      result(proof("workspace", "d-w"), proof("acme", "d-a")),
      {
        batch: current,
        batches: [current],
        sources,
        scoped: { workspace: "sha256:w1", acme: "sha256:a0" },
      },
      "recuperá",
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal.message).toContain(
      "'workspace' no se pudo observar al empezar el batch",
    );
  });
});
