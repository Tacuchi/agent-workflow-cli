import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitCliAdapter } from "../../src/adapters/git-cli.js";
import { NodeProcess } from "../../src/adapters/node-process.js";
import { noteIndexPath } from "../../src/application/decision-note-service.js";
import { awaitingCliRerun, resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import {
  type InternalActionExecutor,
  internalActionExecutor,
  planDonePrecondition,
} from "../../src/application/flow/internal-actions.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { flowCommand } from "../../src/cli/commands/flow.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import {
  FLOW_DECISIONS,
  INTERNAL_ACTION_OPERATIONS,
  INTERNAL_OPERATION_EFFECTS,
  actionOf,
  effectsOf,
  internalActionOf,
  journeyForState,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import {
  FLOW_RUN_STATE_FILE,
  type FlowRunState,
  MAX_BOUNDARY_ATTEMPTS,
  attemptsAt,
  currentBatchIteration,
  newRunState,
  parseRunState,
  sealRunState,
  serializeRunState,
  withAttempt,
  withProposal,
} from "../../src/domain/flow/run-state.js";
import { sealProposal } from "../../src/domain/proposal.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { acceptAdaptiveRoute } from "../helpers/accept-adaptive-route.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";
import { MemFs } from "../helpers/mem-fs.js";
import { planExecWalk } from "../helpers/plan-exec-walk.js";
import {
  OWING_PLAN,
  OWING_TEXT,
  seedExecutedPlanOwingCompensation,
} from "../helpers/plan-obligation-fixtures.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * Lo que el CLI hace por su cuenta, y lo que sigue sin hacer.
 *
 * Dos mitades que se sostienen entre sí. La primera es el inventario: toda acción
 * del registro declara quién la materializa, con una unión cerrada, y esa
 * declaración es coherente con los efectos que la operación puede aplicar de
 * verdad. La segunda es el recorrido real: una operación interna corre en proceso,
 * su salida real decide, la transición se aplica y el avance sigue hasta la
 * primera frontera que sí es de otro — sin devolverle trabajo mecánico a nadie.
 */

const SESSION = "001-prueba-plan-exec";
const fs = new NodeFileSystem();

const WITH_ACTION = FLOW_DECISIONS.filter((decision) => actionOf(decision) !== null);

describe("inventario de acciones — toda entrada declara quién la ejecuta", () => {
  it("no queda ninguna acción sin clasificar y la unión está cerrada", () => {
    expect(WITH_ACTION.length).toBeGreaterThan(0);
    for (const decision of WITH_ACTION) {
      const execution = actionOf(decision)?.execution;
      expect(execution, decision.id).toBeDefined();
      if (execution === undefined) continue;
      expect(["internal", "external"], decision.id).toContain(execution.kind);
      if (execution.kind === "internal") {
        expect(INTERNAL_ACTION_OPERATIONS, decision.id).toContain(execution.operation);
      } else {
        // Un `external` sin causa es una frontera que dice "corré esto" sin decir
        // por qué el CLI no lo hace: el mismo callejón sin salida que un bloqueo
        // sin motivo.
        expect(execution.reason.trim().length, decision.id).toBeGreaterThan(0);
      }
    }
  });

  it("una fila interna sólo declara efectos que su operación puede aplicar", () => {
    for (const decision of WITH_ACTION) {
      const plan = internalActionOf(decision);
      if (plan === null) continue;
      const capable = INTERNAL_OPERATION_EFFECTS[plan.operation];
      for (const effect of effectsOf(decision)) {
        // Sin esta coherencia la fila sería insatisfacible en ejecución: el
        // veredicto exigiría un efecto que la operación nunca aplica y la
        // transición quedaría pendiente para siempre. Enterarse acá es enterarse
        // a tiempo.
        expect(capable, `${decision.id} · ${effect}`).toContain(effect);
      }
    }
  });

  it("toda acción interna es repetible, con evidencia y con recuperación", () => {
    for (const decision of WITH_ACTION) {
      const action = actionOf(decision);
      if (action === null || internalActionOf(decision) === null) continue;
      // La reentrada tras una caída vuelve a correr la operación: una que no
      // fuera repetible se aplicaría dos veces, y eso no se deshace.
      expect(action.idempotent, decision.id).toBe(true);
      expect(action.evidence.length, decision.id).toBeGreaterThan(0);
      expect(action.recovery.trim().length, decision.id).toBeGreaterThan(0);
    }
  });

  it("el ejecutor interno no conoce procesos, workers ni comandos", async () => {
    for (const file of ["internal-actions.ts", "internal-drive.ts"]) {
      const raw = await readFile(join(process.cwd(), "src/application/flow", file), "utf8");
      // El CÓDIGO, sin sus comentarios: la prosa de esos archivos explica
      // justamente que acá no se lanza nada, y un guardián que se dispara con su
      // propia explicación se termina desactivando.
      const body = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // Estructural a propósito: que el camino determinista no lance nada es más
      // fuerte como ausencia de dependencia que como regla de estilo. Ni el port
      // de procesos, ni child_process, ni un spawn, ni un worker.
      expect(body, file).not.toContain("ports/process");
      expect(body, file).not.toContain("child_process");
      expect(body, file).not.toContain("ProcessPort");
      expect(body, file).not.toContain("worker");
      expect(/\bspawn/.test(body), file).toBe(false);
      // Y el `program`/`args` de la fila nunca se leen para decidir qué corre.
      expect(body, file).not.toContain("invocation.program");
      expect(body, file).not.toContain("invocation.args");
    }
  });
});

describe("ejecución interna — el recorrido avanza sin trabajo del host", () => {
  let workdir: string;
  let paths: PathsService;
  let executor: InternalActionExecutor;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-internal-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await seedSession(
      "# SESSION — prueba\n\n## Objective\nprobar\n\n## Success criteria\n- [ ] uno\n",
    );
    executor = internalActionExecutor({
      fs,
      env: new FakeEnv(workdir, workdir),
      paths,
      git: new RecordingGit(),
    });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const seedSession = (body: string): Promise<void> =>
    writeFile(join(paths.cwdSessionsDir(), SESSION, "SESSION.md"), body, "utf8");

  const statePath = (): string => join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE);

  async function state(): Promise<FlowRunState> {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return read.state;
  }

  async function advance(over?: InternalActionExecutor) {
    const result = await advanceFlow(fs, paths, {
      code: "001",
      flow: "plan-exec",
      adopt: true,
      executor: over ?? executor,
    });
    if (!result.ok) throw new Error(`esperaba una directiva: ${JSON.stringify(result)}`);
    const routed = await acceptAdaptiveRoute(fs, paths, SESSION, { executor: over ?? executor });
    if (routed === null) return result.directive;
    return routed;
  }

  it("la lectura de artefactos se resuelve en proceso y el avance sigue hasta la frontera real", async () => {
    const directive = await advance();
    // El paso interno se aplicó dentro de la MISMA invocación: nadie tuvo que
    // correr `aw session-artifacts` y devolver su salida.
    const applied = directive.applied.map((step) => step.transition);
    expect(applied).toContain("plan-exec.session");
    // Y se detuvo en la primera que de verdad no es del CLI: el gate de entrada,
    // externo porque su veredicto es un juicio sobre el plan.
    expect(directive.boundary.transition).toBe("plan-exec.entry-gate");
    expect(directive.boundary.kind).toBe("execution");
    expect(directive.action?.invocation.args).toEqual(["status", "--json"]);
    const current = await state();
    expect(current.applied).toContain("plan-exec.session");
    expect(current.pending_action?.transition).toBe("plan-exec.entry-gate");
    // La acción externa emitida todavía no se empezó: la marca es del que ejecuta.
    expect(current.pending_action?.attempted).toBe(false);
  });

  it("el evento material dice qué corrió, con qué evidencia y con qué sello", async () => {
    await advance();
    const events = (await state()).events;
    expect(events).toHaveLength(1);
    const event = events[0];
    if (event === undefined || event.kind !== "executed") throw new Error("esperaba un ejecutado");
    expect(event.transition).toBe("plan-exec.session");
    expect(event.operation).toBe("session.artifacts");
    expect(event.effects).toContain("local_additive");
    expect(event.evidence).toEqual(["plan.session-present"]);
    // El sello prueba QUÉ bytes volvieron; el resumen es del propio output.
    expect(event.output_digest.length).toBeGreaterThan(0);
    expect(event.summary).toContain(SESSION);
  });

  it("una lectura que no encuentra lo que la transición exige no acredita nada", async () => {
    await rm(join(paths.cwdSessionsDir(), SESSION, "SESSION.md"));
    const directive = await advance();
    expect(directive.boundary.transition).toBe("plan-exec.session");
    // AC-10: the refusal says what to repair, not which evidence to return.
    expect(directive.error?.code).toBe("FLOW_INTERNAL_ACTION_REFUSED");
    // The cause the operation found, and the row's recovery.
    expect(directive.error?.message).toContain("SESSION");
    expect(directive.error?.action).toContain("session-create");
    expect(directive.next_action).not.toContain("devolvé cada validación");
    // La recuperación de la fila viaja con el rechazo: nunca un callejón.
    expect(directive.next_action).toContain("session-create");
    const current = await state();
    expect(current.applied).not.toContain("plan-exec.session");
    const failed = current.events.at(-1);
    if (failed === undefined || failed.kind !== "failed") throw new Error("esperaba un fallo");
    expect(failed.operation).toBe("session.artifacts");
    expect(failed.recovery.length).toBeGreaterThan(0);
  });

  it("si el estado se movió mientras corría la operación, no se pisa: se vuelve a avanzar", async () => {
    // El ejecutor es el punto de interleaving real: mientras "corre", otra
    // invocación deja el archivo en otro estado. El CAS del cierre es lo único
    // que separa eso de un last-writer-wins.
    const racing: InternalActionExecutor = async (plan, run) => {
      const current = await state();
      const { digest: _seal, ...rest } = current;
      await writeFile(
        statePath(),
        serializeRunState(
          sealRunState({
            ...rest,
            authorizations: [{ digest: "otra-corrida", destinations: [], classes: ["read_only"] }],
          }),
        ),
        "utf8",
      );
      return executor(plan, run);
    };
    const adopted = await advanceFlow(fs, paths, {
      code: "001",
      flow: "plan-exec",
      adopt: true,
      executor: racing,
    });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    // La primera acción interna la corre el submit que acepta la ruta: la carrera
    // pasa ahí, y el helper convierte el rechazo en un error con su código.
    await expect(acceptAdaptiveRoute(fs, paths, SESSION, { executor: racing })).rejects.toThrow(
      "FLOW_RUN_STALE",
    );
    const current = await state();
    expect(current.applied).not.toContain("plan-exec.session");
  });

  it("una caída después de anotar la intención reingresa y confirma sin duplicar", async () => {
    // Primera pasada: el driver anota la intención y el proceso muere antes del
    // veredicto. Lo que queda en disco es el estado que el driver persistió justo
    // antes de correr la operación — exactamente lo que sobrevive a esa caída.
    let marked: string | null = null;
    const dying: InternalActionExecutor = async () => {
      marked = await readFile(statePath(), "utf8");
      throw new Error("el proceso murió");
    };
    const adopted = await advanceFlow(fs, paths, {
      code: "001",
      flow: "plan-exec",
      adopt: true,
      executor: dying,
    });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    await acceptAdaptiveRoute(fs, paths, SESSION, { executor: dying });
    if (marked === null) throw new Error("la operación nunca corrió");
    await writeFile(statePath(), marked, "utf8");
    const before = await state();
    expect(before.pending_action?.attempted).toBe(true);
    expect(before.events).toEqual([]);

    const directive = await advance();
    // Reentrada interna: la operación es repetible, así que se vuelve a correr y
    // se confirma. Un solo evento, una sola aplicación.
    expect(directive.applied.map((step) => step.transition)).toContain("plan-exec.session");
    const after = await state();
    expect(after.applied.filter((id) => id === "plan-exec.session")).toHaveLength(1);
    expect(after.events.filter((event) => event.kind === "executed")).toHaveLength(1);
  });

  it("el cierre corre en proceso, aplica su efecto real y repetirlo no reabre nada", async () => {
    const first = await executor({ operation: "session.close" }, { session: SESSION, code: "001" });
    expect(first.ok).toBe(true);
    // El efecto que `chassis.finalize` declara sale de acá, observado y no
    // afirmado: si el cierre no confirma, la lista queda vacía y nada se acredita.
    expect(first.effects).toContain("mutate_overwrite");
    expect(first.summary).toContain("cerrada");

    // Reentrada: la misma operación otra vez es el camino de recuperación cuando
    // el proceso cayó entre la intención y la confirmación. Una sesión ya cerrada
    // vuelve a decir que lo está — no se reabre ni se rompe.
    const again = await executor({ operation: "session.close" }, { session: SESSION, code: "001" });
    expect(again.ok).toBe(true);
    expect(again.effects).toEqual(first.effects);
  });

  it("un criterio de éxito vacío es la plantilla, no una condición de terminado", async () => {
    const dump = { operation: "session.artifacts", dump: ["objetivo"] } as const;
    // Lo que `aw session-create` deja: la casilla existe y no dice nada. Contarla
    // como criterio daría por sembrado el gate que este paso hace verificable.
    await seedSession("# SESSION — prueba\n\n## Objective\nprobar\n\n## Success criteria\n- [ ]\n");
    const bare = await executor(dump, { session: SESSION, code: "001" });
    expect(bare.ok).toBe(false);
    expect(bare.summary).toContain("criterio de éxito escrito");
    expect(bare.effects).toEqual([]);

    await seedSession(
      "# SESSION — prueba\n\n## Objective\nprobar\n\n## Success criteria\n- [ ] la suite queda verde\n",
    );
    expect((await executor(dump, { session: SESSION, code: "001" })).ok).toBe(true);
  });

  it("el tablero se proyecta adentro y su resumen sale de los propios contadores", async () => {
    const outcome = await executor(
      { operation: "workspace.board" },
      { session: SESSION, code: "001" },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.effects).toEqual(["read_only"]);
    expect(outcome.summary).toMatch(/^tablero: \d+ specs/);
    // La salida es la del propio comando, no una glosa: es lo que el veredicto
    // juzga y lo que el sello del evento identifica.
    expect(JSON.parse(outcome.output)).toHaveProperty("counts");
  });

  it("un cierre que no confirma no acredita su efecto ni deja la corrida por finalizada", async () => {
    // La sesión que el cierre nombra no existe: la operación corre igual y vuelve
    // diciendo que no cerró, con la lista de efectos vacía. Un `mutate_overwrite`
    // reportado acá sería la transición aplicándose sobre un cierre que no ocurrió.
    const outcome = await executor(
      { operation: "session.close" },
      { session: SESSION, code: "999" },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.effects).toEqual([]);
    expect(outcome.summary).toContain("no cerró");
  });

  it("el comando avanza con un port de procesos que estalla al primer uso", async () => {
    // El espía es un port que no admite NINGUNA llamada: si el camino determinista
    // lanzara un worker, un subagente, un `aw` o cualquier comando, esta corrida
    // moriría en vez de avanzar. Estructuralmente el ejecutor no lo recibe; esto
    // lo prueba desde el comando real, que sí lo tiene a mano.
    const exploding = new Proxy(
      {},
      {
        get: (_target, name) => () => {
          throw new Error(`el camino interno no puede usar el port de procesos (${String(name)})`);
        },
      },
    );
    const ctx = {
      fs,
      env: new FakeEnv(workdir, workdir),
      git: new RecordingGit(),
      process: exploding,
      paths,
      runtime: undefined,
    } as unknown as CliContext;
    const args = {
      rest: ["advance"],
      flags: new Set(["--adopt"]),
      values: new Map([
        ["session", "001"],
        ["flow", "plan-exec"],
      ]),
      valuesMulti: new Map(),
      plugin: {},
    } as unknown as ParsedArgs;

    const adopted = await flowCommand.execute(args, ctx);
    expect(adopted.ok).toBe(true);
    // Aceptar la ruta ya corre la primera acción interna. Acá se la difiere sin
    // efectos para que la corra el comando real, que es lo que esta prueba fija.
    const deferring: InternalActionExecutor = async (plan) => ({
      ok: false,
      summary: `${plan.operation}: diferida al comando`,
      output: "",
      effects: [],
    });
    await acceptAdaptiveRoute(fs, paths, SESSION, { executor: deferring });
    const result = await flowCommand.execute(args, ctx);
    expect(result.ok).toBe(true);
    expect(result.data?.applied.map((step) => step.transition)).toContain("plan-exec.session");
  });

  it("el estado persistido sigue siendo legible y sellado tras la ejecución interna", async () => {
    await advance();
    const raw = await readFile(statePath(), "utf8");
    const read = parseRunState(raw);
    expect(read.ok).toBe(true);
  });
});

// F4 · T4.4 — el rechazo del sello sale de la misma derivación que el titular del
// tablero y la acción del pipeline. Lo que se fija es lo que este texto tenía
// mal por su cuenta: prescribía publicar una nota sustituta —un remedio que la
// corrida no podía alcanzar desde donde estaba— y no nombraba `aw settle`.
describe("plan-done — el rechazo por reconciliación nombra una salida ejecutable", () => {
  const OWING_SESSION = "144-deuda-plan-exec";

  function owingWorkspace(): { deps: Parameters<typeof planDonePrecondition>[0]; mem: MemFs } {
    const mem = new MemFs();
    mem.file("/cwd/.workflow/sessions/.keep", "");
    seedExecutedPlanOwingCompensation(mem);
    return {
      mem,
      deps: {
        fs: mem,
        env: new FakeEnv("/home", "/cwd"),
        paths: new PathsService(normalizeNamespace("workflow"), "/home", "/cwd"),
        git: new RecordingGit(),
      },
    };
  }

  it("no es el rechazo de los contadores: el plan está entero y aun así no cierra", async () => {
    const { deps } = owingWorkspace();

    const failure = await planDonePrecondition(deps, OWING_PLAN, OWING_SESSION);

    expect(failure?.code).toBe("PLAN_EXEC_DONE_RECONCILIATION_PENDING");
    expect(failure?.message).toContain("COMPENSACIÓN VIGENTE por DEC-001");
    expect(failure?.message).toContain(OWING_TEXT);
  });

  it("con el linaje ilegible nombra la reparación, que es lo único que sirve", async () => {
    const { deps, mem } = owingWorkspace();
    // La cadena corrompida: sin contrato que componer, el tramo de saldo se
    // saltea solo —no hay nota que sustituir— y el rechazo del cierre queda como
    // el único texto de todo el recorrido que puede decir qué hacer.
    mem.file(`/cwd/${noteIndexPath("docs/decisions", "043", "deuda")}`, "{ esto no es json");

    const failure = await planDonePrecondition(deps, OWING_PLAN, OWING_SESSION);

    expect(failure?.code).toBe("PLAN_EXEC_DONE_RECONCILIATION_PENDING");
    expect(failure?.message).toContain("LINAJE ILEGIBLE");
    // La reparación va PRIMERO. Mandar a avanzar antes de eso es el bucle: el
    // tramo de saldo se saltea —no hay nota que sustituir—, el cierre vuelve a
    // rechazar acá, y ningún texto del recorrido nombra lo que hay que hacer.
    expect(failure?.action.startsWith("el índice de decisiones es un documento sellado")).toBe(
      true,
    );
    expect(failure?.action.indexOf("reparalo a mano")).toBeLessThan(
      failure?.action.indexOf("aw flow advance"),
    );
    expect(failure?.message).not.toContain("retomá en");
  });

  it("nombra las dos salidas y ninguna es una fase ya validada", async () => {
    const { deps } = owingWorkspace();

    const failure = await planDonePrecondition(deps, OWING_PLAN, OWING_SESSION);

    // La corrida propia primero, porque `plan-done` corre adentro de una…
    expect(failure?.action).toContain(`aw flow advance --code ${OWING_SESSION}`);
    // …y la otra mitad, para la corrida que ya pasó la frontera de saldo: el
    // cursor sólo crece, así que ésa no puede volver.
    expect(failure?.action).toContain(`aw settle prepare ${OWING_PLAN}`);
    // Y el punto: la nota grabó F1/T1.1 al nacer y F1 está VALIDADA, así que el
    // punto vigente es el cierre. Mandar a F1/T1.1 es mandar a trabajo hecho.
    expect(failure?.message).toContain("retomá en el cierre del plan");
    expect(`${failure?.message} ${failure?.action}`).not.toContain("F1/T1.1");
  });
});

/**
 * AC-03 of spec 052: no failed write leaves the run behind its effect.
 *
 * The run's own write fails right AFTER an internal operation applied its
 * effect — the Windows EPERM on the rename, after the retry gave up. The next
 * `aw flow advance` must recognize the effect and move on, charging nothing, even
 * when that mismatch had exhausted the boundary.
 */
describe("la escritura del registro falla después del efecto", () => {
  const PLAN = "docs/plans/090-plan-dos-fases.md";
  const RUN = { code: "420", folder: "420-dos-fases-plan-exec", plan: PLAN };
  const PLAN_TEXT = [
    "# Plan 090 — dos fases",
    "",
    "> Standalone: prueba de re-entrada",
    "> Límite de ejecución: checkout",
    "",
    "## Tasks",
    "",
    "### F1 — uno",
    "> Estado: pendiente",
    "> Fuentes: workspace",
    "",
    "- [ ] T1.1 — uno _(fuentes: workspace)_",
    "",
    "### F2 — dos",
    "> Estado: pendiente",
    "> Fuentes: workspace",
    "",
    "- [ ] T2.1 — dos _(fuentes: workspace)_",
    "",
    "## Execution batches",
    "- B1 · isolated · F1",
    "- B2 · isolated · F2",
    "",
  ].join("\n");
  const WORKSPACE_BLOCK = [
    "<!-- AGENT-WORKFLOW-PROJECT-START -->",
    "## Proyecto",
    "",
    "Re-entrada de acciones internas.",
    "",
    "## Fuentes",
    "",
    "| Alias | Path | Rama principal |",
    "|---|---|---|",
    "| acme | {{ACME}} | main |",
    "<!-- AGENT-WORKFLOW-PROJECT-END -->",
    "",
  ].join("\n");

  /** Fails the next write of the run's own state file once armed — nothing else. */
  class FailingRunWrite extends NodeFileSystem {
    armed = false;
    constructor(private readonly statePath: () => string) {
      super();
    }
    override async writeText(path: string, content: string): Promise<void> {
      if (this.armed && path === this.statePath()) {
        this.armed = false;
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
          code: "EPERM",
        });
      }
      return super.writeText(path, content);
    }
  }

  let workdir: string;
  let paths: PathsService;
  let deps: { fs: NodeFileSystem; env: FakeEnv; git: GitCliAdapter; paths: PathsService };
  let failing: FailingRunWrite;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-reentry-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    deps = {
      fs,
      env: new FakeEnv(workdir, workdir),
      git: new GitCliAdapter(new NodeProcess()),
      paths,
    };
    failing = new FailingRunWrite(() => locateRun(paths, RUN.folder).statePath);
    const dir = join(paths.cwdSessionsDir(), RUN.folder);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SESSION.md"), "# SESSION\n\n## Objective\nprobar\n", "utf8");
    await mkdir(join(workdir, "docs", "plans"), { recursive: true });
    // A real repository behind the declared source: closing a session lists its
    // units through Git, and a path that does not exist fails that listing.
    const acme = join(workdir, "acme");
    await mkdir(acme, { recursive: true });
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: acme });
    await writeFile(join(workdir, "CLAUDE.md"), WORKSPACE_BLOCK.replace("{{ACME}}", acme), "utf8");
    await writeFile(join(workdir, PLAN), PLAN_TEXT, "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const walk = () => planExecWalk(deps, { sources: ["workspace"] });

  async function current() {
    const read = await readRun(fs, locateRun(paths, RUN.folder));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return read.state;
  }

  const occurrences = (state: FlowRunState, transition: string) =>
    state.applied.filter((id) => id === transition).length;

  /**
   * Walk the real run, answering every boundary, until `operation` has run its
   * `nth` time — and fail the run's write right after it. Returns the transition
   * the operation belongs to.
   */
  async function failWriteAfter(operation: string, nth = 1): Promise<string> {
    const real = internalActionExecutor({ ...deps, fs: failing });
    let seen = 0;
    let transition: string | null = null;
    const armed: InternalActionExecutor = async (plan, run) => {
      const outcome = await real(plan, run);
      if (plan.operation === operation && transition === null) {
        seen += 1;
        if (seen === nth) {
          const read = await readRun(fs, locateRun(paths, RUN.folder));
          if (!read.ok) throw new Error(read.failure.code);
          transition = resolveBoundary(read.state, journeyForState(read.state)).stopped?.id ?? null;
          failing.armed = true;
        }
      }
      return outcome;
    };
    await driveUntil(armed, () => transition !== null);
    if (transition === null) throw new Error(`'${operation}' nunca corrió en el recorrido`);
    return transition;
  }

  /** Our injected EPERM is expected; anything else is a real failure. */
  const swallowOurs = (error: unknown) => {
    if (!(error instanceof Error) || !error.message.startsWith("EPERM")) throw error;
  };

  /** Adopt, accept the route and answer every boundary until `done()` holds. */
  async function driveUntil(executor: InternalActionExecutor, done: () => boolean) {
    await advanceFlow(failing, paths, {
      code: RUN.code,
      flow: "plan-exec",
      adopt: true,
      executor,
    }).catch(swallowOurs);
    if (!done()) {
      await acceptAdaptiveRoute(failing, paths, RUN.folder, { executor }).catch(swallowOurs);
    }
    const helper = walk();
    for (let step = 0; step < 80 && !done(); step += 1) {
      const state = await current();
      const resolved = resolveBoundary(state, journeyForState(state));
      if (resolved.stopped === null) return;
      const approval =
        resolved.kind === "authorization"
          ? effectApprovalDigest(resolved.stopped.id, resolved.authorization?.planned ?? [])
          : null;
      await submitFlow(failing, paths, {
        code: RUN.code,
        raw: JSON.stringify(
          approval === null
            ? helper.bodyFor(RUN, resolved)
            : { input_digest: resolved.seal, choice: "Autorizar el efecto" },
        ),
        approval,
        executor,
      }).catch(swallowOurs);
    }
  }

  /** The advance the person runs next, with the ordinary file system. */
  async function advanceAgain() {
    const result = await advanceFlow(fs, paths, {
      code: RUN.code,
      adopt: false,
      executor: internalActionExecutor(deps),
    });
    if (!result.ok) throw new Error(`esperaba avanzar: ${JSON.stringify(result)}`);
    return result.directive;
  }

  async function expectRecognized(transition: string) {
    const stuck = await current();
    const before = occurrences(stuck, transition);
    const spent = attemptsAt(stuck, transition);
    expect(resolveBoundary(stuck, journeyForState(stuck)).stopped?.id).toBe(transition);

    const directive = await advanceAgain();
    const after = await current();
    expect(occurrences(after, transition)).toBe(before + 1);
    // Nothing charged: no attempt row was added, and the count never grew.
    expect(after.attempts).toHaveLength(stuck.attempts.length);
    expect(attemptsAt(after, transition)).toBeLessThanOrEqual(spent);
    expect(after.skipped.filter((id) => id === transition)).toHaveLength(0);
    expect(directive.boundary.transition).not.toBe(transition);
    return after;
  }

  for (const [operation, nth] of [
    ["session.artifacts", 1],
    ["plan-exec.batch-infer", 1],
    ["worktree.ensure", 1],
    ["plan-exec.batch-close", 1],
    ["plan-exec.plan-done", 1],
  ] as const) {
    it(`${operation}: el siguiente advance reconoce el efecto y avanza sin cobrar`, async () => {
      await expectRecognized(await failWriteAfter(operation, nth));
    });
  }

  it("batch-close del último lote (batch_loop ya en pending:false, el caso de qtc-selva) pasa a la validación final", async () => {
    const transition = await failWriteAfter("plan-exec.batch-close", 2);
    const stuck = await current();
    expect(stuck.batch_loop).toEqual({ pending: false, iteration: null });
    const plan = await readFile(join(workdir, PLAN), "utf8");
    expect(plan).not.toContain("> Estado: pendiente");
    const after = await expectRecognized(transition);
    expect(after.applied).toContain("plan-exec.settlement-authoring");
  });

  it("batch-close agotado por el desfase pasa al lote siguiente sin mover el contador", async () => {
    const transition = await failWriteAfter("plan-exec.batch-close", 1);
    // The mismatch as the 25.6.1 engine left it: every attempt spent on a close
    // whose ticks and `validada` were already in the plan.
    const stuck = await current();
    const { digest: _seal, ...rest } = stuck;
    const attempts = [...stuck.attempts];
    const iteration = currentBatchIteration(stuck, transition);
    for (let n = 1; n <= MAX_BOUNDARY_ATTEMPTS; n += 1) {
      attempts.push({
        invocation_id: `sello-agotado-${n}`,
        attempt: 1,
        request_digest: `pedido-${n}`,
        parent_request_digest: null,
        transition,
        // Keyed the way the engine charged it: after the publication the close
        // counts under the loop's CURRENT iteration.
        ...(iteration === null ? {} : { batch_iteration: iteration }),
      });
    }
    await writeFile(
      locateRun(paths, RUN.folder).statePath,
      serializeRunState(sealRunState({ ...rest, attempts })),
      "utf8",
    );
    const exhausted = await current();
    expect(attemptsAt(exhausted, transition)).toBeGreaterThanOrEqual(MAX_BOUNDARY_ATTEMPTS);

    const after = await expectRecognized(transition);
    expect(
      after.batches?.filter((batch) => batch.published_plan_digest !== undefined),
    ).toHaveLength(1);
    // The mismatch's charges sat on the key the NEXT batch's close reads; the
    // recognized re-run gave them back, so that close starts with its budget.
    expect(attemptsAt(after, transition)).toBe(0);
    expect(after.attempt_grants?.[`${transition}@batch-2`] ?? 0).toBeGreaterThanOrEqual(
      MAX_BOUNDARY_ATTEMPTS,
    );
    // Standing on the next batch's first boundary.
    expect(resolveBoundary(after, journeyForState(after)).stopped?.id).toBe(
      "plan-exec.batch-eligibility-signal",
    );
  });

  /**
   * The two operations no plan-exec run walks, re-run where the driver would:
   * the second call must recognize what the first applied instead of refusing.
   */
  it("workspace.board y proposal.publish reconocen su efecto ya aplicado al repetirse", async () => {
    const executor = internalActionExecutor(deps);
    const coordinates = { session: RUN.folder, code: RUN.code, scope: null };
    const board = await executor({ operation: "workspace.board" }, coordinates);
    expect(board.ok).toBe(true);
    expect((await executor({ operation: "workspace.board" }, coordinates)).ok).toBe(true);

    const proposal = sealProposal({
      operation: "plan-new.publication",
      artifacts: [
        { path: "docs/plans/091-plan-nuevo.md", content: "# Plan 091\n", overwrite: false },
      ],
      effects: ["local_additive"],
      requiresApproval: [],
    });
    const run = { ...coordinates, proposal };
    const first = await executor({ operation: "proposal.publish" }, run);
    expect(first.ok).toBe(true);
    const again = await executor({ operation: "proposal.publish" }, run);
    expect(again.ok).toBe(true);
    expect(again.summary).toContain("ya estaba aplicada");
    expect(again.effects).toEqual(first.effects);
  });

  it("session.close: con la sesión ya cerrada y el cursor en chassis.finalize, termina la corrida", async () => {
    const transition = await failWriteAfter("session.close", 1);
    expect(transition).toBe("chassis.finalize");
    const directive = await advanceAgain();
    const after = await current();
    expect(after.applied.at(-1)).toBe("chassis.finalize");
    expect(attemptsAt(after, transition)).toBe(0);
    expect(directive.boundary.kind).toBe("final");
  });
});

/**
 * The CLI's re-run window opens only on a row the CLI can run NOW. One still
 * waiting on an authorization stands as that authorization, and the window
 * would refuse the only answer that unblocks it.
 */
describe("la vuelta del CLI sobre una frontera agotada", () => {
  const PUBLICATION = FLOW_DECISIONS.find((decision) => decision.id === "plan-new.publication");

  function exhaustedPublication(): FlowRunState {
    let state = withProposal(
      newRunState("plan-new", "003-prueba-plan-new"),
      sealProposal({
        operation: "plan-new.publication",
        artifacts: [{ path: "docs/plans/092-plan-x.md", content: "# x\n", overwrite: true }],
        effects: ["mutate_overwrite"],
        requiresApproval: ["mutate_overwrite"],
      }),
    );
    for (let n = 1; n <= MAX_BOUNDARY_ATTEMPTS; n += 1) {
      state = withAttempt(state, {
        invocation_id: `sello-${n}`,
        attempt: 1,
        request_digest: `pedido-${n}`,
        parent_request_digest: null,
        transition: "plan-new.publication",
      });
    }
    return state;
  }

  it("no se abre mientras falta la autorización, y se abre cuando está", () => {
    if (PUBLICATION === undefined) throw new Error("falta la fila de publicación");
    const waiting = exhaustedPublication();
    expect(awaitingCliRerun(waiting, PUBLICATION)).toBe(false);

    const proposal = waiting.proposal;
    if (proposal === null) throw new Error("esperaba la propuesta sellada");
    const { digest: _seal, ...unsealed } = waiting;
    const granted = sealRunState({
      ...unsealed,
      authorizations: [
        {
          digest: proposal.digest,
          destinations: proposal.artifacts.map((artifact) => artifact.path),
          classes: ["mutate_overwrite"],
        },
      ],
    });
    expect(awaitingCliRerun(granted, PUBLICATION)).toBe(true);
  });
});
