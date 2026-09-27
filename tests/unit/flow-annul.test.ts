import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { applyAnnulment, prepareAnnulment } from "../../src/application/flow/annul-service.js";
import { internalActionExecutor } from "../../src/application/flow/internal-actions.js";
import { parsePhases } from "../../src/application/parsers/phases.js";
import { parseTasks } from "../../src/application/parsers/tasks.js";
import { PathsService } from "../../src/application/paths-service.js";
import { preparePlanExecAnnulment } from "../../src/application/plan-exec-batch-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { planExecWalk } from "../helpers/plan-exec-walk.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * AC-07 of spec 052: a batch accredited without changes is annulled with an
 * approval.
 *
 * The motos-v2 case: F3 to F6 were closed as `validada` over a checkout nobody
 * changed. Annulling from F3's batch previews exactly those phases and tasks
 * without writing anything; only that preview's digest applies it; the plan and
 * the new run then show them open, the trace names the annulment, and the
 * source's HEAD never moves.
 */

const fs = new NodeFileSystem();
const PLAN = "docs/plans/002-plan-motos.md";
const RUN = { code: "004", folder: "004-motos-plan-exec", plan: PLAN };
const PHASES = [1, 2, 3, 4, 5, 6];

function planText(): string {
  return [
    "# Plan 002 — motos",
    "",
    "> Standalone: el caso de motos-v2",
    "> Estado: open",
    "> Límite de ejecución: checkout",
    "",
    "## Tasks",
    "",
    ...PHASES.flatMap((n) => [
      `### F${n} — fase ${n}`,
      "> Estado: pendiente",
      "> Fuentes: workspace",
      "",
      `- [ ] T${n}.1 — tarea ${n} _(fuentes: workspace)_`,
      "",
    ]),
    "## Execution batches",
    ...PHASES.map((n) => `- B${n} · isolated · F${n}`),
    "",
  ].join("\n");
}

describe("aw flow annul — el caso de motos-v2", () => {
  let workdir: string;
  let acme: string;
  let deps: { fs: NodeFileSystem; env: FakeEnv; git: GitCliAdapter; paths: PathsService };

  const git = (...args: string[]) => execFileSync("git", args, { cwd: acme, encoding: "utf8" });

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-annul-"));
    const paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    deps = {
      fs,
      env: new FakeEnv(workdir, workdir),
      git: new GitCliAdapter(new NodeProcess()),
      paths,
    };
    acme = join(workdir, "acme");
    await mkdir(acme, { recursive: true });
    git("init", "--quiet", "--initial-branch=main");
    git(
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=T",
      "commit",
      "--allow-empty",
      "-qm",
      "inicial",
    );
    await writeFile(
      join(workdir, "CLAUDE.md"),
      [
        "<!-- AGENT-WORKFLOW-PROJECT-START -->",
        "## Fuentes",
        "",
        "| Alias | Path | Rama principal |",
        "|---|---|---|",
        `| acme | ${acme} | main |`,
        "<!-- AGENT-WORKFLOW-PROJECT-END -->",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(workdir, "docs", "plans"), { recursive: true });
    await writeFile(join(workdir, PLAN), planText(), "utf8");
    const dir = join(paths.cwdSessionsDir(), RUN.folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SESSION.md"), "# SESSION\n\n## Objective\nmotos\n", "utf8");
    // Every phase accredited, one batch each, without touching the source.
    await planExecWalk(deps, { sources: ["workspace"] }).walkTo(RUN, "plan-exec.final-validation");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const annul = (extra: { approval?: string } = {}) => ({
    code: RUN.code,
    from: "batch-3",
    env: deps.env,
    executor: internalActionExecutor(deps),
    ...extra,
  });

  const runFile = () => join(deps.paths.cwdSessionsDir(), RUN.folder, ".flow-run.json");

  it("la vista previa nombra F3 a F6 y sus tareas, y no escribe nada", async () => {
    const before = await readFile(join(workdir, PLAN), "utf8");
    const runBefore = await readFile(runFile(), "utf8");
    const sessionsBefore = await readdir(deps.paths.cwdSessionsDir());
    const prepared = await prepareAnnulment(fs, deps.paths, {
      ...annul(),
      contextId: "conversacion-de-prueba",
    });
    if (!prepared.ok) throw new Error(`esperaba la vista previa: ${JSON.stringify(prepared)}`);
    const { preview } = prepared;
    expect(preview.batches.map((batch) => batch.id)).toEqual([
      "batch-3",
      "batch-4",
      "batch-5",
      "batch-6",
    ]);
    expect(preview.phases).toEqual([3, 4, 5, 6]);
    expect(preview.tasks).toEqual(["T3.1", "T4.1", "T5.1", "T6.1"]);
    expect(preview.next).toContain(`--approval ${preview.digest}`);
    expect(await readFile(join(workdir, PLAN), "utf8")).toBe(before);
    // Nothing else either: not the registry, not the conversation's binding.
    expect(await readFile(runFile(), "utf8")).toBe(runBefore);
    expect(await readdir(deps.paths.cwdSessionsDir())).toEqual(sessionsBefore);
  });

  it("un digest ajeno se rechaza sin tocar nada", async () => {
    const before = await readFile(join(workdir, PLAN), "utf8");
    const refused = await applyAnnulment(fs, deps.paths, annul({ approval: "f".repeat(64) }));
    if (refused.ok || "session" in refused) throw new Error("un digest ajeno no aplica");
    expect(refused.failure.code).toBe("FLOW_ANNUL_APPROVAL_MISMATCH");
    expect(await readFile(join(workdir, PLAN), "utf8")).toBe(before);
    const dir = join(deps.paths.cwdSessionsDir(), RUN.folder);
    expect((await readdir(dir)).some((name) => name.includes(".archived-"))).toBe(false);
  });

  it("aprobada, el plan y la corrida nueva las reabren, la traza lo dice y el HEAD no se mueve", async () => {
    const head = git("rev-parse", "HEAD").trim();
    const prepared = await prepareAnnulment(fs, deps.paths, annul());
    if (!prepared.ok) throw new Error("esperaba la vista previa");

    const applied = await applyAnnulment(
      fs,
      deps.paths,
      annul({ approval: prepared.preview.digest }),
    );
    if (!applied.ok) throw new Error(`esperaba anular: ${JSON.stringify(applied)}`);

    const plan = await readFile(join(workdir, PLAN), "utf8");
    const states = new Map(parsePhases(plan).items.map((phase) => [phase.n, phase.state]));
    expect([1, 2].map((n) => states.get(n))).toEqual(["validada", "validada"]);
    expect([3, 4, 5, 6].map((n) => states.get(n))).toEqual(Array(4).fill("pendiente"));
    expect(parseTasks(plan).open).toBe(4);

    const walk = planExecWalk(deps, { sources: ["workspace"] });
    const { state } = await walk.current(RUN.folder);
    expect(state.events.map((event) => event.kind).slice(0, 2)).toEqual(["restarted", "annulled"]);
    const annulled = state.events[1];
    if (annulled?.kind !== "annulled") throw new Error("esperaba el evento de anulación");
    expect(annulled.batches).toEqual(["batch-3", "batch-4", "batch-5", "batch-6"]);
    expect(annulled.digest).toBe(prepared.preview.digest);

    // The new run infers the reopened work again, starting at F3.
    await walk.walkTo(RUN, "plan-exec.implementation");
    const reinferred = await walk.current(RUN.folder);
    expect(reinferred.state.batches?.at(-1)?.phases).toEqual([3]);
    expect(git("rev-parse", "HEAD").trim()).toBe(head);
  });

  it("el digest de otro rango no aplica este, aunque la vista previa fuera real", async () => {
    const other = await prepareAnnulment(fs, deps.paths, { ...annul(), from: "batch-4" });
    if (!other.ok) throw new Error("esperaba la vista previa de batch-4");
    const before = await readFile(join(workdir, PLAN), "utf8");
    const refused = await applyAnnulment(fs, deps.paths, annul({ approval: other.preview.digest }));
    if (refused.ok || "session" in refused) throw new Error("el digest de otro rango no aplica");
    expect(refused.failure.code).toBe("FLOW_ANNUL_APPROVAL_MISMATCH");
    expect(await readFile(join(workdir, PLAN), "utf8")).toBe(before);
  });

  it("un lote que la corrida no cerró se rechaza nombrando los que sí", async () => {
    const refused = await prepareAnnulment(fs, deps.paths, { ...annul(), from: "batch-9" });
    if (refused.ok || "session" in refused) throw new Error("un lote inexistente no se anula");
    expect(refused.failure.code).toBe("FLOW_ANNUL_BATCH_UNKNOWN");
    expect(refused.failure.action).toContain("batch-3");
  });
});

describe("la reescritura del plan al anular", () => {
  it("retira el sello done, porque done con trabajo abierto es incoherente", () => {
    const done = [
      "# Plan 003",
      "",
      "> Estado: done",
      "> Cierre: 2026-09-01 · sesión 004",
      "> Assurance: verified",
      "> Límite de ejecución: checkout",
      "",
      "## Tasks",
      "",
      "### F1 — uno",
      "> Estado: validada",
      "",
      "- [x] T1.1 — uno",
      "",
    ].join("\n");
    const rewrite = preparePlanExecAnnulment(done, { plan: "p.md", tasks: ["T1.1"], phases: [1] });
    if (!rewrite.ok) throw new Error(rewrite.failure.code);
    expect(rewrite.prepared.unsealed).toBe(true);
    expect(rewrite.prepared.content).toContain("> Estado: open");
    expect(rewrite.prepared.content).not.toContain("> Cierre:");
    expect(rewrite.prepared.content).not.toContain("> Assurance:");
    expect(rewrite.prepared.content).toContain("### F1 — uno\n> Estado: pendiente");
    expect(rewrite.prepared.content).toContain("- [ ] T1.1 — uno");
    expect(rewrite.prepared.content).toContain("> Límite de ejecución: checkout");
  });
});
