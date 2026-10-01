import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import {
  advanceFlow,
  recoverFlowBoundary,
  restartFlow,
} from "../../src/application/flow/flow-service.js";
import { internalActionExecutor } from "../../src/application/flow/internal-actions.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import { runSessionCreate } from "../../src/application/session-create-service.js";
import { readCustody } from "../../src/application/session-custody-service.js";
import { flowCommand } from "../../src/cli/commands/flow.js";
import { commandHelpText } from "../../src/cli/help-groups.js";
import {
  FLOW_RUN_STATE_VERSION,
  type FlowRunState,
  MAX_BOUNDARY_ATTEMPTS,
  newRunState,
  sealRunState,
  serializeRunState,
  withAttempt,
  withEvent,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { planExecWalk } from "../helpers/plan-exec-walk.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * AC-06 of spec 052: every stuck run leaves through one CLI verb.
 *
 * `aw flow restart` archives the registry and its counter inside the session,
 * re-adopts the same flow and says so in the new run's trace and in custody —
 * so nobody has to move `.flow-run.json` by hand, which a host's own safety
 * classifier may not even allow.
 */

const SESSION = "001-prueba-quick";
const CODE = "001";
const fs = new NodeFileSystem();

describe("aw flow restart — los siete estados trabados salen por el verbo", () => {
  let workdir: string;
  let paths: PathsService;
  const executor = () =>
    internalActionExecutor({
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
      git: new GitCliAdapter(new NodeProcess()),
    });

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-restart-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    // Created the way production creates it, so it is born with its custody.
    const created = await runSessionCreate(fs, paths, {
      type: "quick",
      name: "prueba-quick",
      objetivo: "probar la salida",
    });
    if ("error" in created) throw new Error(`esperaba crear la sesión: ${created.error}`);
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida quick");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const location = () => locateRun(paths, SESSION);

  async function seated(): Promise<FlowRunState> {
    const read = await readRun(fs, location());
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return read.state;
  }

  /** A sealed v12 state standing where the adopted run stands, altered by `change`. */
  async function rewrite(change: (state: FlowRunState) => FlowRunState): Promise<void> {
    await writeFile(location().statePath, serializeRunState(change(await seated())), "utf8");
  }

  /** The older on-disk shape `version` had, sealed the way its own writer sealed it. */
  async function writeVersion(version: number): Promise<void> {
    const { digest: _seal, journey_base: _base, ...rest } = await seated();
    const older = { ...rest, version };
    await writeFile(
      location().statePath,
      JSON.stringify({ ...older, digest: semanticDigest(older) }),
      "utf8",
    );
  }

  const exhaustedWithEffects = (state: FlowRunState): FlowRunState => {
    const boundary = state.boundary ?? "";
    let next = withEvent(state, {
      kind: "executed",
      transition: boundary,
      operation: "prueba.efecto",
      summary: "escribió un archivo",
      output_digest: "sello",
      effects: ["local_additive"],
      evidence: [],
    });
    for (let n = 1; n <= MAX_BOUNDARY_ATTEMPTS; n += 1) {
      next = withAttempt(next, {
        invocation_id: `sello-${n}`,
        attempt: 1,
        request_digest: `pedido-${n}`,
        parent_request_digest: null,
        transition: boundary,
      });
    }
    return next;
  };

  const STUCK: readonly [string, string, () => Promise<void>][] = [
    [
      "frontera agotada que ya ejerció efectos",
      "FLOW_BOUNDARY_EXHAUSTED",
      () => rewrite(exhaustedWithEffects),
    ],
    [
      "registro ilegible",
      "FLOW_RUN_INVALID",
      () => writeFile(location().statePath, "{ esto no es json", "utf8"),
    ],
    [
      "registro sellado mal",
      "FLOW_RUN_TAMPERED",
      async () => {
        const state = await seated();
        await writeFile(
          location().statePath,
          JSON.stringify({ ...state, applied: [...state.applied, "a.mano"] }),
          "utf8",
        );
      },
    ],
    ["registro v10", "FLOW_RUN_LEGACY_ADOPTION_REQUIRED", () => writeVersion(10)],
    ["registro v6", "FLOW_RUN_VERSION_UNSUPPORTED", () => writeVersion(6)],
    [
      "contador de intentos ilegible",
      "FLOW_RUN_COUNTER_INVALID",
      async () => {
        await mkdir(join(location().countersPath, ".."), { recursive: true });
        await writeFile(location().countersPath, "{ roto", "utf8");
      },
    ],
    [
      "contador de intentos revertido",
      "FLOW_RUN_COUNTER_ROLLED_BACK",
      () =>
        rewrite(({ digest: _seal, ...state }) =>
          sealRunState({ ...state, attempt_floor: { [state.boundary ?? ""]: 2 } }),
        ),
    ],
  ];

  for (const [name, code, stick] of STUCK) {
    it(`${name}: archiva, re-adopta y lo deja en la traza`, async () => {
      await stick();
      const before = await readFile(location().statePath, "utf8");

      const restarted = await restartFlow(fs, paths, { code: CODE, executor: executor() });
      if (!restarted.ok) throw new Error(`esperaba reiniciar: ${JSON.stringify(restarted)}`);

      const fresh = await seated();
      expect(fresh.version).toBe(FLOW_RUN_STATE_VERSION);
      expect(fresh.flow).toBe("quick");
      const first = fresh.events[0];
      if (first?.kind !== "restarted") throw new Error("la corrida nueva nace nombrando la salida");
      expect(first.cause).toContain(code);

      // The old bytes survive, whole, inside the session and nowhere else.
      const names = await readdir(location().dir);
      expect(names).toContain(first.archive);
      const archived = JSON.parse(await readFile(join(location().dir, first.archive), "utf8"));
      expect(archived.state).toBe(before);
      expect(archived.cause).toBe(first.cause);
      // The counter left with it: the new run starts with every attempt.
      expect(fresh.attempts).toEqual([]);
      if (code === "FLOW_RUN_COUNTER_INVALID") expect(archived.counters).toBe("{ roto");

      // Custody says what was archived and which flow the session is now.
      const custody = await readCustody(fs, join(paths.cwdSessionsDir(), SESSION));
      const kinds = custody.status === "present" ? custody.custody.effects.map((e) => e.kind) : [];
      expect(kinds).toContain("flow_restarted");
      expect(kinds.at(-1)).toBe("flow_adopted");

      // And the run is alive again: the next advance just works.
      const next = await advanceFlow(fs, paths, { code: CODE, adopt: false });
      expect(next.ok).toBe(true);
    });
  }

  it("el rechazo de recover sobre una frontera con efectos nombra el verbo", async () => {
    await rewrite(exhaustedWithEffects);
    const refused = await recoverFlowBoundary(fs, paths, { code: CODE });
    if (refused.ok || "session" in refused) throw new Error("recover debía negarse");
    expect(refused.failure.code).toBe("FLOW_RECOVERY_EFFECTS_APPLIED");
    expect(refused.failure.action).toContain(`aw flow restart --session ${SESSION}`);
  });

  it("un --flow que contradice el registro se rechaza sin archivar nada", async () => {
    const before = await readFile(location().statePath, "utf8");
    const refused = await restartFlow(fs, paths, { code: CODE, flow: "plan-exec" });
    if (refused.ok || "session" in refused) throw new Error("un flow ajeno no se adopta");
    expect(refused.failure.code).toBe("FLOW_ADOPTION_FLOW_MISMATCH");
    expect(await readFile(location().statePath, "utf8")).toBe(before);
    expect((await readdir(location().dir)).some((name) => name.includes(".archived-"))).toBe(false);
  });

  it("sin registro legible ni custodia, el flow sale de --flow", async () => {
    await writeFile(location().statePath, "{ roto", "utf8");
    await rm(join(location().dir, ".custody.json"), { force: true });
    const missing = await restartFlow(fs, paths, { code: CODE });
    if (missing.ok || "session" in missing) throw new Error("sin flow no se re-adopta");
    expect(missing.failure.code).toBe("FLOW_ADOPTION_FLOW_MISSING");
    const named = await restartFlow(fs, paths, { code: CODE, flow: "quick" });
    expect(named.ok).toBe(true);
    expect((await seated()).flow).toBe("quick");
  });

  it("aw flow restart está en la ayuda con su uso", () => {
    expect(commandHelpText(flowCommand)).toContain("restart");
    expect(commandHelpText(flowCommand, "restart")).toContain("Usage: aw flow restart");
  });
});

/**
 * The qtc-selva session 003: a run written before v11 over a plan whose phases
 * are all `validada`. After the restart the new run re-infers from the plan,
 * reaches its final validation without redoing anything, and passing it seals
 * the plan `done` and closes the session.
 */
describe("aw flow restart — el caso de qtc-selva llega a la validación final", () => {
  const PLAN = "docs/plans/003-plan-selva.md";
  const RUN = { code: "003", folder: "003-selva-plan-exec", plan: PLAN };
  let workdir: string;
  let deps: { fs: NodeFileSystem; env: FakeEnv; git: GitCliAdapter; paths: PathsService };

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-restart-selva-"));
    const paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    deps = {
      fs,
      env: new FakeEnv(workdir, workdir),
      git: new GitCliAdapter(new NodeProcess()),
      paths,
    };
    const acme = join(workdir, "acme");
    await mkdir(acme, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: acme });
    await writeFile(
      join(workdir, "CLAUDE.md"),
      [
        "<!-- AGENT-WORKFLOW-HUB-START -->",
        "## Fuentes",
        "",
        "| Alias | Path | Rama principal |",
        "|---|---|---|",
        `| acme | ${acme} | main |`,
        "<!-- AGENT-WORKFLOW-HUB-END -->",
        "",
      ].join("\n"),
      "utf8",
    );
    await mkdir(join(workdir, "docs", "plans"), { recursive: true });
    await writeFile(
      join(workdir, PLAN),
      [
        "# Plan 003 — selva",
        "",
        "> Standalone: el caso de qtc-selva",
        "> Estado: open",
        "> Límite de ejecución: checkout",
        "",
        "## Tasks",
        "",
        "### F1 — uno",
        "> Estado: validada",
        "> Fuentes: hub",
        "",
        "- [x] T1.1 — uno _(fuentes: hub)_",
        "",
        "### F2 — dos",
        "> Estado: validada",
        "> Fuentes: hub",
        "",
        "- [x] T2.1 — dos _(fuentes: hub)_",
        "",
      ].join("\n"),
      "utf8",
    );
    const dir = join(paths.cwdSessionsDir(), RUN.folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SESSION.md"), "# SESSION\n\n## Objective\ncerrar\n", "utf8");
    // What the 25.x engine left behind: a sealed v9 registry, readable and not
    // continuable by any build since v11.
    const { digest: _seal, journey_base: _base, ...rest } = newRunState("plan-exec", RUN.folder);
    const v9 = { ...rest, version: 9 };
    await writeFile(
      join(dir, ".flow-run.json"),
      JSON.stringify({ ...v9, digest: semanticDigest(v9) }),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("re-adopta, llega a final-validation sin rehacer fases, y al pasarla cierra todo", async () => {
    const restarted = await restartFlow(fs, deps.paths, {
      code: RUN.code,
      executor: internalActionExecutor(deps),
    });
    if (!restarted.ok) throw new Error(`esperaba reiniciar: ${JSON.stringify(restarted)}`);

    const reread = await readRun(fs, locateRun(deps.paths, RUN.folder));
    if (!reread.ok) throw new Error(reread.failure.code);
    const first = reread.state.events[0];
    if (first?.kind !== "restarted") throw new Error("la corrida nueva nace nombrando la salida");
    expect(first.cause).toContain("FLOW_RUN_LEGACY_ADOPTION_REQUIRED");

    const walk = planExecWalk(deps, { sources: ["hub"] });
    await walk.walkTo(RUN, "plan-exec.final-validation");
    const { state, resolved } = await walk.current(RUN.folder);
    expect(resolved.stopped?.id).toBe("plan-exec.final-validation");
    // No batch was walked: the plan was already validated.
    expect(state.applied).not.toContain("plan-exec.implementation");

    await walk.walkTo(RUN, "(el final)");
    const plan = await readFile(join(workdir, PLAN), "utf8");
    expect(plan).toContain("> Estado: done");
    const closed = await readRun(fs, locateRun(deps.paths, RUN.folder));
    if (!closed.ok) throw new Error(closed.failure.code);
    expect(closed.state.applied.at(-1)).toBe("chassis.finalize");
  });
});
