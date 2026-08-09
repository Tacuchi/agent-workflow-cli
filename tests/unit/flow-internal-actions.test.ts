import { readFile } from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import {
  type InternalActionExecutor,
  internalActionExecutor,
} from "../../src/application/flow/internal-actions.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
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
} from "../../src/domain/flow/authority.js";
import {
  FLOW_RUN_STATE_FILE,
  type FlowRunState,
  parseRunState,
  sealRunState,
  serializeRunState,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";
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
    return result.directive;
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

  it("sin ejecutor la acción interna vuelve a ser la frontera que siempre fue", async () => {
    const directive = await advanceFlow(fs, paths, { code: "001", flow: "plan-exec", adopt: true });
    if (!directive.ok) throw new Error("esperaba una directiva");
    // Degrada el MECANISMO, nunca el contrato: nada se acredita y la invocación
    // viaja para que la corra quien pueda.
    expect(directive.directive.boundary.transition).toBe("plan-exec.session");
    expect(directive.directive.boundary.kind).toBe("execution");
    expect((await state()).applied).not.toContain("plan-exec.session");
  });

  it("una lectura que no encuentra lo que la transición exige no acredita nada", async () => {
    await rm(join(paths.cwdSessionsDir(), SESSION, "SESSION.md"));
    const directive = await advance();
    expect(directive.boundary.transition).toBe("plan-exec.session");
    expect(directive.error?.code).toBe("FLOW_EVIDENCE_MISSING");
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
        serializeRunState(sealRunState({ ...rest, authorizations: ["read_only"] })),
        "utf8",
      );
      return executor(plan, run);
    };
    const result = await advanceFlow(fs, paths, {
      code: "001",
      flow: "plan-exec",
      adopt: true,
      executor: racing,
    });
    if (result.ok) throw new Error("una carrera perdida no puede devolver una directiva aplicada");
    expect("failure" in result && result.failure.code).toBe("FLOW_RUN_STALE");
    const current = await state();
    expect(current.applied).not.toContain("plan-exec.session");
  });

  it("una caída después de anotar la intención reingresa y confirma sin duplicar", async () => {
    // Primera pasada: emite la frontera interna sin ejecutarla (sin ejecutor) y
    // deja anotado que ya se empezó — exactamente el estado que sobrevive a una
    // caída entre la intención y el efecto.
    await advanceFlow(fs, paths, { code: "001", flow: "plan-exec", adopt: true });
    const before = await state();
    const { digest: _seal, ...rest } = before;
    const pending = before.pending_action;
    if (pending === null) throw new Error("esperaba una acción pendiente");
    await writeFile(
      statePath(),
      serializeRunState(sealRunState({ ...rest, pending_action: { ...pending, attempted: true } })),
      "utf8",
    );

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
