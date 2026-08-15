import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow, recoverFlowBoundary } from "../../src/application/flow/flow-service.js";
import type { InternalActionExecutor } from "../../src/application/flow/internal-actions.js";
import {
  applyUnderLock,
  locateRun,
  readRun,
} from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { semanticDigest } from "../../src/application/semantic-operation/protocol.js";
import { flowCommand } from "../../src/cli/commands/flow.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { FLOW_ANSWER_REJECTIONS, spendsAttempt } from "../../src/domain/flow/answer.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import {
  FLOW_RUN_STATE_FILE,
  FLOW_RUN_STATE_VERSION,
  type FlowRunState,
  MAX_BOUNDARY_ATTEMPTS,
  attemptsAt,
  parseRunState,
  withActionAttempted,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { RecordingGit } from "../helpers/fake-git.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * Un recorrido trabado tiene salida, y su contabilidad no se puede rebobinar.
 *
 * Cuatro defectos del mismo ledger, verificados sobre v21.10.1 y cubiertos acá:
 * un payload rechazado por FORMA gastaba intento —dos typos del sobre más un
 * intento real agotaban la frontera—; una ejecución interna que fallaba no
 * registraba nada, así que ni agotaba ni degradaba y quedaba colgada para
 * siempre; restaurar una copia byte a byte anterior del estado devolvía los
 * intentos consumidos, que era además el único reset que existía; y el contador
 * que se agregó para resistir eso vivía dentro de la misma carpeta que
 * protegía, sin sello, así que se lo llevaba un `cp -r` y se lo editaba a mano.
 *
 * El recorrido de abajo es un ejecutor controlado, aislado del registro de
 * producción a propósito: lo que se prueba es el contrato del ledger, no la
 * migración de ninguna fila real.
 */

vi.mock("../../src/domain/flow/authority.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/domain/flow/authority.js")>();
  const journey: FlowDecision[] = [
    {
      id: "fixture.entry",
      scope: "quick",
      title: "abrir el tramo",
      authority: "cli",
      ownership: "cli-owned",
      document: "loops/quick-loop/LOOP.md",
    },
    {
      id: "fixture.observe",
      scope: "quick",
      title: "reconocer las señales del objetivo",
      authority: "agent",
      ownership: "cli-owned",
      document: "loops/quick-loop/LOOP.md",
      signals: ["fixture.senal-a", "fixture.senal-b"],
    },
    {
      id: "fixture.board",
      scope: "quick",
      title: "proyectar el tablero del workspace",
      authority: "cli",
      ownership: "cli-owned",
      document: "loops/quick-loop/LOOP.md",
      // `read_only` es auto-autorizable: la fila se detiene en la frontera de
      // EJECUCIÓN y nunca en una de autorización, que es lo que este archivo
      // necesita ejercitar. Y es lo que la hace degradable: saltear una lectura
      // no acredita nada — la fila que ESCRIBE se prueba aparte.
      effects: ["read_only"],
      action: {
        invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
        evidence: ["tablero"],
        idempotent: true,
        recovery: "revisá el bloque WORKSPACE y volvé a proyectar el tablero",
        execution: { kind: "internal", operation: "workspace.board" },
      },
    },
    {
      id: "fixture.wrap",
      scope: "quick",
      title: "cerrar el tramo",
      authority: "cli",
      ownership: "cli-owned",
      document: "loops/quick-loop/LOOP.md",
    },
  ];
  return { ...real, journeyOfFlow: () => journey };
});

const SESSION = "001-prueba-quick";
const CODE = "001";
const fs = new NodeFileSystem();

/**
 * La lista COMPLETA y explícita, para que agregar un código obligue a decidir.
 *
 * El corte no es una preferencia de estilo: el techo de tres existe para que un
 * gap deje de re-dispararse, y cobrarle un intento a quien todavía no pudo
 * ENTREGAR una decisión le cobra el sobre, no la respuesta.
 */
describe("el corte entre un rechazo por forma y una respuesta evaluada", () => {
  it("cada código cae de un lado declarado, y la tabla es la lista entera", () => {
    expect(FLOW_ANSWER_REJECTIONS).toEqual({
      // Nada se pesó: no llegó payload, no se pudo leer, contesta otra frontera,
      // o llegó sin el canal que ESTA frontera usa para decidir.
      FLOW_ANSWER_MISSING: "envelope",
      FLOW_ANSWER_INVALID: "envelope",
      FLOW_ANSWER_STALE: "envelope",
      FLOW_ANSWER_NOT_EXPECTED: "envelope",
      FLOW_RESULT_INVALID: "envelope",
      FLOW_ARTIFACTS_MISSING: "envelope",
      FLOW_ARTIFACTS_NOT_EXPECTED: "envelope",
      SEMANTIC_PATH_REJECTED: "envelope",
      SEMANTIC_RESPONSE_INVALID: "envelope",
      FLOW_ACTION_CHANGED: "envelope",
      // La decisión llegó y no resolvió el gap: eso es lo que el techo cuenta.
      FLOW_ANSWER_AMBIGUOUS: "evaluated",
      FLOW_SIGNAL_UNKNOWN: "evaluated",
      FLOW_CHOICE_UNKNOWN: "evaluated",
      FLOW_APPROVAL_MISSING: "evaluated",
      FLOW_APPROVAL_MISMATCH: "evaluated",
      FLOW_ACTION_MISMATCH: "evaluated",
      FLOW_EXECUTION_NOT_COMPLETED: "evaluated",
      FLOW_EVIDENCE_MISSING: "evaluated",
      FLOW_EFFECT_PARTIAL: "evaluated",
      FLOW_SCOPE_INVALID: "evaluated",
      FLOW_SCOPE_UNKNOWN_SOURCE: "evaluated",
      FLOW_SCOPE_NOT_IN_PLAN: "evaluated",
      FLOW_SCOPE_PLAN_UNREADABLE: "evaluated",
      FLOW_PROPOSAL_BEYOND_CONTRACT: "evaluated",
      FLOW_PROPOSAL_DESTINATION_UNOBSERVED: "evaluated",
      FLOW_PROPOSAL_BASE_UNREADABLE: "evaluated",
      // Una respuesta real que no aplica nada, o la misma dos veces.
      FLOW_BOUNDARY_PAUSED: "control",
      FLOW_BOUNDARY_DECLINED: "control",
      FLOW_ANSWER_RESENT: "control",
    });
  });

  /**
   * El guardián que obliga a decidir: un código nuevo en el parser, en el
   * veredicto o en `submit` no puede quedar sin lado. Sin esto la tabla
   * envejece en silencio y el default —gastar— se lo traga; y `submit` es
   * justamente donde seis rechazos vivieron fuera de la tabla y fuera del
   * cobro, dejando un bucle sin techo en la frontera de scope.
   */
  it("ningún código que el parser, el veredicto o submit emiten queda sin clasificar", async () => {
    /**
     * Lo que no es un rechazo de frontera, uno por uno y con su motivo.
     *
     * Declarado acá y no en el código: agregar un código nuevo obliga a
     * clasificarlo o a excluirlo a mano, y las dos cosas son una decisión
     * visible en el diff.
     */
    const notARejection = new Set([
      // No hay corrida: no hay frontera a la cual cobrarle nada.
      "FLOW_RUN_ABSENT",
    ]);
    const sources = [
      "src/domain/flow/answer.ts",
      "src/domain/flow/execution-result.ts",
      "src/application/flow/submit.ts",
    ];
    const emitted = new Set<string>();
    for (const file of sources) {
      const raw = await readFile(join(process.cwd(), file), "utf8");
      for (const match of raw.matchAll(/code:\s*"([A-Z][A-Z_]+)"/g)) {
        const code = match[1];
        if (code !== undefined && !notARejection.has(code)) emitted.add(code);
      }
    }
    expect(emitted.size).toBeGreaterThan(0);
    for (const code of emitted) {
      expect(Object.keys(FLOW_ANSWER_REJECTIONS), code).toContain(code);
    }
  });

  it("un código que nadie clasificó gasta: el techo no se desactiva por omisión", () => {
    expect(spendsAttempt("FLOW_ANSWER_INVALID")).toBe(false);
    expect(spendsAttempt("FLOW_BOUNDARY_PAUSED")).toBe(false);
    expect(spendsAttempt("FLOW_SIGNAL_UNKNOWN")).toBe(true);
    expect(spendsAttempt("FLOW_SCOPE_UNKNOWN_SOURCE")).toBe(true);
    expect(spendsAttempt("FLOW_CODIGO_QUE_NO_EXISTE")).toBe(true);
  });
});

describe("intentos, agotamiento y recuperación sobre un workspace real", () => {
  let workdir: string;
  let paths: PathsService;
  /** Lo que la operación interna devuelve en este caso de prueba. */
  let board: () => Awaited<ReturnType<InternalActionExecutor>>;
  const executor: InternalActionExecutor = async () => board();

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-recovery-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — prueba\n\n## Objective\nprobar\n",
      "utf8",
    );
    board = () => ({
      ok: false,
      summary: "el tablero no se pudo proyectar: falta el bloque WORKSPACE",
      output: "",
      effects: [],
    });
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const sessionDir = (): string => join(paths.cwdSessionsDir(), SESSION);
  const statePath = (): string => join(sessionDir(), FLOW_RUN_STATE_FILE);
  const counterPath = (): string => locateRun(paths, SESSION).countersPath;

  async function state(): Promise<FlowRunState> {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return read.state;
  }

  async function readFailure(): Promise<string> {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (read.ok) throw new Error("se esperaba una lectura rechazada");
    return read.failure.code;
  }

  async function seal(): Promise<string> {
    const current = await state();
    const { journeyOfFlow } = await import("../../src/domain/flow/authority.js");
    return resolveBoundary(current, journeyOfFlow(current.flow)).seal;
  }

  async function submit(raw: string): Promise<FlowDirective> {
    const result = await submitFlow(fs, paths, { code: CODE, raw, approval: null, executor });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true, no ok:false");
    return result.directive;
  }

  async function advance(): Promise<FlowDirective> {
    const result = await advanceFlow(fs, paths, { code: CODE, adopt: false, executor });
    if (!result.ok) throw new Error("esperaba una directiva del avance");
    return result.directive;
  }

  /** Contestar la frontera semántica con una señal que sí existe. */
  async function answerObserve(): Promise<FlowDirective> {
    return submit(JSON.stringify({ input_digest: await seal(), signals: ["fixture.senal-a"] }));
  }

  /** Una respuesta que la frontera EVALÚA y rechaza: gasta intento. */
  let tried = 0;
  async function refuseObserve(): Promise<FlowDirective> {
    tried += 1;
    return submit(
      JSON.stringify({ input_digest: await seal(), signals: [`fixture.inventada-${tried}`] }),
    );
  }

  describe("un intento es una respuesta evaluada, no un error de tipeo del sobre", () => {
    it("tres sobres malformados dejan la frontera contestable", async () => {
      const envelopes: Array<[string, string]> = [
        ["", "FLOW_ANSWER_MISSING"],
        ["{", "FLOW_ANSWER_INVALID"],
        [JSON.stringify({ signals: ["fixture.senal-a"] }), "FLOW_ANSWER_INVALID"],
      ];
      for (const [raw, code] of envelopes) {
        const directive = await submit(raw);
        expect(directive.error?.code, raw.slice(0, 30)).toBe(code);
        expect(directive.boundary.transition, raw.slice(0, 30)).toBe("fixture.observe");
      }
      // Ninguno llegó al veredicto de la frontera, así que ninguno la gastó.
      expect(attemptsAt(await state(), "fixture.observe")).toBe(0);

      // Y la prueba de que sigue contestable: se contesta y aplica.
      const applied = await answerObserve();
      expect(applied.boundary.transition).toBe("fixture.board");
      expect((await state()).applied).toContain("fixture.observe");
    });

    it("una respuesta evaluada e insuficiente sí gasta, y a las tres agota", async () => {
      expect((await refuseObserve()).error?.code).toBe("FLOW_SIGNAL_UNKNOWN");
      expect(attemptsAt(await state(), "fixture.observe")).toBe(1);
      await refuseObserve();
      const last = await refuseObserve();
      expect(last.error?.code).toBe("FLOW_BOUNDARY_EXHAUSTED");
      expect(attemptsAt(await state(), "fixture.observe")).toBe(MAX_BOUNDARY_ATTEMPTS);
    });
  });

  describe("una ejecución que falla no se cuelga: agota o degrada con causa", () => {
    /** Dejar la corrida parada en la fila delegada, ya ejecutada y fallida. */
    async function reachBoard(): Promise<FlowDirective> {
      const stopped = await answerObserve();
      expect(stopped.boundary.transition).toBe("fixture.board");
      return stopped;
    }

    it("la acción se ejecutó y falló: cada ejecución registra su intento y termina degradando", async () => {
      const failed = await reachBoard();
      expect(failed.error?.code).toBe("FLOW_EVIDENCE_MISSING");
      // El defecto medido: cero filas en el ledger para esa frontera, para
      // siempre. Ahora la ejecución que vuelve a fallar es el intento — cobrado
      // donde la acción corre, no al entrar al avance.
      expect(attemptsAt(await state(), "fixture.board")).toBe(1);
      for (const expected of [2, 3]) {
        await advance();
        expect(attemptsAt(await state(), "fixture.board")).toBe(expected);
      }

      const degraded = await advance();
      const after = await state();
      expect(attemptsAt(after, "fixture.board")).toBe(MAX_BOUNDARY_ATTEMPTS);
      // Degrada CON CAUSA, y el recorrido sigue en vez de quedar trabado.
      expect(after.skipped).toContain("fixture.board");
      const declared = (after.degraded ?? []).find((one) => one.transition === "fixture.board");
      expect(declared?.cause).toContain("se ejecutó y falló");
      expect(declared?.cause).toContain("FLOW_EVIDENCE_MISSING");
      expect(declared?.cause).toContain("Open questions");
      expect(after.applied).toContain("fixture.wrap");
      expect(degraded.boundary.kind).toBe("final");
      // Y la directiva final NO dice "no queda trabajo pendiente": nombra lo que
      // el recorrido dejó degradado, que es la mitad que un lector se perdía.
      expect(degraded.next_action).toContain("fixture.board");
      expect(degraded.next_action).not.toContain("no queda trabajo pendiente");
    });

    /**
     * El intento lo gasta la acción al volver a fallar, no el avance al entrar.
     *
     * Cobrar en la entrada le cobraba un intento a quien no ejecutó nada: la
     * pausa que el propio CLI recomienda —"volvé con `aw flow advance`"— salía
     * un tercio del techo, y quien arreglaba la causa recibía la degradación en
     * vez de su tercer intento real.
     */
    it("un avance que no ejecuta nada no gasta intento", async () => {
      await reachBoard();
      expect(attemptsAt(await state(), "fixture.board")).toBe(1);
      // Sin ejecutor no se materializa nada: la fila delegada se emite como
      // cualquier frontera externa y la acción no vuelve a correr.
      const looked = await advanceFlow(fs, paths, { code: CODE, adopt: false });
      if (!looked.ok) throw new Error("esperaba una directiva");
      expect(looked.directive.boundary.kind).toBe("execution");
      expect(attemptsAt(await state(), "fixture.board")).toBe(1);
    });

    it("arreglar la causa devuelve la ejecución, no una degradación", async () => {
      await reachBoard();
      await advance();
      expect(attemptsAt(await state(), "fixture.board")).toBe(2);
      // El usuario arregla lo que faltaba y vuelve a avanzar.
      board = () => ({
        ok: true,
        summary: "tablero proyectado",
        output: "{}",
        effects: ["read_only"],
      });
      const applied = await advance();
      const after = await state();
      expect(after.applied).toContain("fixture.board");
      expect(after.skipped).not.toContain("fixture.board");
      expect(after.degraded ?? []).toEqual([]);
      expect(applied.boundary.kind).toBe("final");
    });

    it("el estado final distingue contestada, agotada y salteada por condición", async () => {
      await answerObserve();
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await advance();
      const after = await state();

      // Contestada: está en el cursor y no está ni omitida ni degradada.
      expect(after.applied).toContain("fixture.observe");
      expect(after.skipped).not.toContain("fixture.observe");
      // Agotada: está en el cursor, está omitida, Y declara su degradación.
      expect(after.applied).toContain("fixture.board");
      expect(after.skipped).toContain("fixture.board");
      expect((after.degraded ?? []).map((one) => one.transition)).toEqual(["fixture.board"]);
      // Salteada por condición sería omitida SIN degradación: la diferencia que
      // un lector del estado no podía hacer, y que ahora es un campo.
      for (const one of after.degraded ?? []) expect(one.cause.trim().length).toBeGreaterThan(0);
    });

    it("una frontera que nadie ejecutó todavía no se degrada sola", async () => {
      await answerObserve();
      // La acción NUNCA corrió: el ejecutor no está, así que la fila se emite
      // como cualquier frontera externa. Tres avances no la degradan, porque
      // saltearla daría por hecho algo que nada corrió.
      await rm(statePath());
      await rm(counterPath(), { force: true });
      await advanceFlow(fs, paths, { code: CODE, flow: "quick", adopt: true });
      await submitFlow(fs, paths, {
        code: CODE,
        raw: JSON.stringify({ input_digest: await seal(), signals: ["fixture.senal-a"] }),
        approval: null,
      });
      const standing = await state();
      expect(standing.boundary).toBe("fixture.board");
      expect(standing.events).toEqual([]);
      const directive = await advanceFlow(fs, paths, { code: CODE, adopt: false });
      if (!directive.ok) throw new Error("esperaba una directiva");
      expect(directive.directive.boundary.kind).toBe("execution");
      expect(attemptsAt(await state(), "fixture.board")).toBe(0);
      expect((await state()).skipped).not.toContain("fixture.board");
    });
  });

  describe("el contador vive fuera del sello Y fuera de la carpeta de la sesión", () => {
    it("restaurar una copia previa del ledger no revive los intentos gastados", async () => {
      await refuseObserve();
      // La copia byte a byte que el sello acepta: la escribió este mismo CLI.
      const copia = await readFile(statePath(), "utf8");
      await refuseObserve();
      await refuseObserve();
      expect(attemptsAt(await state(), "fixture.observe")).toBe(MAX_BOUNDARY_ATTEMPTS);

      await writeFile(statePath(), copia, "utf8");
      const restored = parseRunState(await readFile(statePath(), "utf8"));
      if (!restored.ok) throw new Error("la copia restaurada tiene que ser legible y sellada");
      // El archivo dice uno —es el que se guardó— y el contador dice tres.
      expect(attemptsAt(restored.state, "fixture.observe")).toBe(1);
      expect(attemptsAt(await state(), "fixture.observe")).toBe(MAX_BOUNDARY_ATTEMPTS);

      // Y no es contabilidad decorativa: la frontera sigue agotada, así que
      // contestarla devuelve la causa del bloqueo en vez de aplicar nada.
      const answered = await answerObserve();
      expect(answered.error?.code).toBe("FLOW_BOUNDARY_EXHAUSTED");
      expect((await state()).applied).not.toContain("fixture.observe");
    });

    /**
     * La evasión que el contador no cubría por estar donde estaba.
     *
     * Con el contador adentro de la carpeta de la sesión, un `cp -r` de ida y
     * vuelta —un backup, que es una operación legítima y frecuente— se llevaba
     * el ledger Y su contador, y la frontera volvía a tener sus tres intentos.
     */
    it("restaurar la CARPETA entera de la sesión tampoco los revive", async () => {
      const backup = join(workdir, "backup-sesion");
      await cp(sessionDir(), backup, { recursive: true });
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await refuseObserve();
      expect(attemptsAt(await state(), "fixture.observe")).toBe(MAX_BOUNDARY_ATTEMPTS);

      await rm(sessionDir(), { recursive: true, force: true });
      await cp(backup, sessionDir(), { recursive: true });
      expect(await fs.exists(statePath())).toBe(true);
      expect(attemptsAt(await state(), "fixture.observe")).toBe(MAX_BOUNDARY_ATTEMPTS);
      const answered = await answerObserve();
      expect(answered.error?.code).toBe("FLOW_BOUNDARY_EXHAUSTED");
    });

    /**
     * Borrar el contador tampoco resetea: el estado lleva su piso adentro del
     * sello, y un piso sin contador es evidencia de cirugía, no un cero.
     */
    it("borrar el contador con un piso sellado falla cerrado, y no se reconstruye", async () => {
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await refuseObserve();
      await rm(counterPath());
      expect(await readFailure()).toBe("FLOW_RUN_COUNTER_ROLLED_BACK");
      // Y no avanza por otro camino: la lectura es la única puerta.
      const blocked = await advanceFlow(fs, paths, { code: CODE, adopt: false, executor });
      if (blocked.ok) throw new Error("no se avanza con la contabilidad rebobinada");
      if ("session" in blocked) throw new Error("no se esperaba un problema de sesión");
      expect(blocked.failure.code).toBe("FLOW_RUN_COUNTER_ROLLED_BACK");
    });

    it("editar el contador a mano se rechaza como cualquier otro archivo de la corrida", async () => {
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await refuseObserve();
      // Exactamente la edición que apagaba el techo: perdonar los tres intentos.
      await writeFile(
        counterPath(),
        JSON.stringify({
          version: 2,
          session: SESSION,
          attempts: { "fixture.observe": MAX_BOUNDARY_ATTEMPTS },
          granted: { "fixture.observe": MAX_BOUNDARY_ATTEMPTS },
        }),
        "utf8",
      );
      expect(await readFailure()).toBe("FLOW_RUN_COUNTER_INVALID");
    });

    it("un contador bien sellado que perdona más de lo que registró también se rechaza", async () => {
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await refuseObserve();
      const attempts = { "fixture.observe": MAX_BOUNDARY_ATTEMPTS };
      const granted = { "fixture.observe": 99 };
      await writeFile(
        counterPath(),
        JSON.stringify({
          version: 2,
          session: SESSION,
          attempts,
          granted,
          // Sellado de verdad: la coherencia se chequea aparte del sello, porque
          // un sello sin secreto lo recalcula cualquiera.
          digest: semanticDigest({ version: 2, session: SESSION, attempts, granted }),
        }),
        "utf8",
      );
      expect(await readFailure()).toBe("FLOW_RUN_COUNTER_INVALID");
    });

    /**
     * Compatibilidad hacia atrás, que es la otra mitad del cambio de versión.
     *
     * Un ledger escrito por la versión anterior no trae piso ni degradaciones, y
     * su ausencia es la lectura conservadora: la corrida sigue caminando, el
     * contador vigente sigue mandando, y la primera escritura la re-sella con la
     * versión que este CLI escribe.
     */
    it("un ledger de la versión anterior se lee, camina, y el contador sigue mandando", async () => {
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await refuseObserve();
      const raw = JSON.parse(await readFile(statePath(), "utf8")) as Record<string, unknown>;
      const legacy: Record<string, unknown> = { ...raw, version: 7 };
      // Los campos que la versión 7 no conocía, fuera — y su sello, rehecho.
      legacy.attempt_floor = undefined;
      legacy.attempt_grants = undefined;
      legacy.degraded = undefined;
      legacy.digest = undefined;
      const clean = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
      await writeFile(
        statePath(),
        JSON.stringify({ ...clean, digest: semanticDigest(clean) }),
        "utf8",
      );

      const read = await state();
      expect(read.version).toBe(FLOW_RUN_STATE_VERSION);
      // El ledger viejo no dice nada de intentos gastados; el contador sí.
      expect(attemptsAt(read, "fixture.observe")).toBe(MAX_BOUNDARY_ATTEMPTS);
      const answered = await answerObserve();
      expect(answered.error?.code).toBe("FLOW_BOUNDARY_EXHAUSTED");
    });
  });

  describe("aw flow recover — una frontera agotada tiene salida", () => {
    async function recover(
      transition?: string,
    ): Promise<
      | { ok: true; directive: FlowDirective }
      | { ok: false; failure: { code: string; message: string; action: string } }
    > {
      const result = await recoverFlowBoundary(fs, paths, {
        code: CODE,
        ...(transition === undefined ? {} : { transition }),
      });
      if (result.ok) return result;
      if ("session" in result) throw new Error("no se esperaba un problema de sesión");
      return result;
    }

    it("destraba la frontera y conserva todo lo ya aplicado", async () => {
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await refuseObserve();
      const before = await state();
      expect(before.applied).toEqual(["fixture.entry"]);

      const recovered = await recover();
      if (!recovered.ok) throw new Error(`esperaba recuperar: ${recovered.failure.code}`);
      // Vuelve a ser contestable, en la MISMA frontera y sin reiniciar nada.
      expect(recovered.directive.boundary.kind).toBe("semantic");
      expect(recovered.directive.boundary.transition).toBe("fixture.observe");
      const after = await state();
      expect(after.applied).toEqual(before.applied);
      expect(after.effects).toEqual(before.effects);
      expect(attemptsAt(after, "fixture.observe")).toBe(0);
      // Recuperar no es un borrado del contador: el intento sigue registrado y
      // lo que se anota es cuánto se devolvió, que también es monótono.
      expect(after.attempts.length).toBe(MAX_BOUNDARY_ATTEMPTS);
      expect(after.attempt_grants?.["fixture.observe"]).toBe(MAX_BOUNDARY_ATTEMPTS);

      // Y el recorrido sigue: la frontera se contesta y aplica.
      const applied = await answerObserve();
      expect(applied.boundary.transition).toBe("fixture.board");
      expect((await state()).applied).toContain("fixture.observe");
    });

    it("el verbo existe en la superficie del CLI y llega al servicio", async () => {
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await refuseObserve();
      const ctx = {
        fs,
        env: new FakeEnv(workdir, workdir),
        git: new RecordingGit(),
        paths,
        runtime: undefined,
      } as unknown as CliContext;
      const args = {
        rest: ["recover"],
        flags: new Set<string>(),
        values: new Map([["session", CODE]]),
        valuesMulti: new Map(),
        plugin: {},
      } as unknown as ParsedArgs;

      const result = await flowCommand.execute(args, ctx);
      expect(result.ok).toBe(true);
      expect(result.data?.boundary.transition).toBe("fixture.observe");
      expect(attemptsAt(await state(), "fixture.observe")).toBe(0);
      // Y está publicado donde se lee sin correr un recorrido.
      expect(flowCommand.describe).toContain("recover");
    });

    it("restaurar una copia vieja después de recuperar tampoco devuelve intentos", async () => {
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await refuseObserve();
      const recovered = await recover();
      expect(recovered.ok).toBe(true);
      const copia = await readFile(statePath(), "utf8");
      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) await refuseObserve();
      expect(attemptsAt(await state(), "fixture.observe")).toBe(MAX_BOUNDARY_ATTEMPTS);

      await writeFile(statePath(), copia, "utf8");
      // El piso subió a seis y el perdón quedó en tres: la resta sigue dando
      // agotada, que es lo que hace que la recuperación no sea un reset.
      expect(attemptsAt(await state(), "fixture.observe")).toBe(MAX_BOUNDARY_ATTEMPTS);
    });

    it("se niega cuando esa frontera ya ejerció efectos, y el estado queda igual", async () => {
      // Una ejecución que aplicó de menos: la invocación tocó el mundo y el
      // veredicto la rechaza igual. Es el caso que la guarda existe para cubrir.
      board = () => ({
        ok: true,
        summary: "el tablero se proyectó a medias",
        output: '{"parcial":true}',
        effects: [],
      });
      const failed = await answerObserve();
      expect(failed.error?.code).toBe("FLOW_EFFECT_PARTIAL");
      expect(attemptsAt(await state(), "fixture.board")).toBe(1);

      // Los dos intentos que faltan los gastan resultados externos evaluados,
      // sin avanzar: así la frontera llega agotada SIN que el avance la degrade.
      for (const turn of [2, 3]) {
        await submit(
          JSON.stringify({
            input_digest: await seal(),
            outcome: "failed",
            invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
            validations: [{ id: "tablero", passed: false, detail: `intento ${turn}` }],
            effects: { planned: ["read_only"], approved: [], applied: [] },
          }),
        );
      }
      expect(attemptsAt(await state(), "fixture.board")).toBe(MAX_BOUNDARY_ATTEMPTS);

      const before = await readFile(statePath(), "utf8");
      const denied = await recover();
      if (denied.ok) throw new Error("una frontera que ya ejerció efectos no se recupera");
      expect(denied.failure.code).toBe("FLOW_RECOVERY_EFFECTS_APPLIED");
      expect(denied.failure.message).toContain("workspace.board");
      expect(denied.failure.action.length).toBeGreaterThan(0);
      // Nunca toca el estado, ni los artefactos, ni el contador.
      expect(await readFile(statePath(), "utf8")).toBe(before);
      expect(await readFile(join(sessionDir(), "SESSION.md"), "utf8")).toContain("## Objective");
    });

    /**
     * La otra mitad de la guarda: una ejecución EXTERNA que declaró efectos.
     *
     * La traza sólo la escribía el ejecutor interno, así que un resultado
     * externo que decía haber aplicado efectos —rechazado por evidencia, pero
     * declarándolos— no dejaba rastro, y `recover` devolvía como contestable una
     * frontera que ya había tocado el mundo.
     */
    it("se niega cuando un resultado EXTERNO declaró efectos aplicados", async () => {
      // Sin ejecutor: la fila delegada se emite como frontera externa.
      await submitFlow(fs, paths, {
        code: CODE,
        raw: JSON.stringify({ input_digest: await seal(), signals: ["fixture.senal-a"] }),
        approval: null,
      });
      expect((await state()).boundary).toBe("fixture.board");

      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) {
        const answered = await submitFlow(fs, paths, {
          code: CODE,
          approval: null,
          raw: JSON.stringify({
            input_digest: await seal(),
            outcome: "completed",
            invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
            validations: [{ id: "tablero", passed: false, detail: `intento ${turn}` }],
            // El agente DECLARA que el efecto ya se aplicó en el mundo.
            effects: {
              planned: ["local_additive"],
              approved: ["local_additive"],
              applied: ["local_additive"],
            },
          }),
        });
        if (!answered.ok) throw new Error("un rechazo de negocio viaja ok:true");
      }
      const after = await state();
      expect(attemptsAt(after, "fixture.board")).toBe(MAX_BOUNDARY_ATTEMPTS);
      // Lo que declaró quedó en la traza, aunque su resultado fuera rechazado.
      expect(after.events.map((event) => event.transition)).toContain("fixture.board");

      const denied = await recover();
      if (denied.ok) throw new Error("no se recupera una frontera que declaró efectos");
      expect(denied.failure.code).toBe("FLOW_RECOVERY_EFFECTS_APPLIED");
      expect(denied.failure.message).toContain("aw status --json");
    });

    /**
     * Y la duda: la acción se anotó como iniciada y nunca dijo en qué terminó.
     *
     * Es el proceso que muere entre la marca y el veredicto. Nadie puede decir
     * si tocó el mundo, así que la recuperación se niega — pero con una salida
     * real, que es volver a avanzar para que la acción produzca su veredicto.
     */
    it("se niega cuando la acción se inició y nunca reportó, y enseña la salida", async () => {
      await submitFlow(fs, paths, {
        code: CODE,
        raw: JSON.stringify({ input_digest: await seal(), signals: ["fixture.senal-a"] }),
        approval: null,
      });
      // La misma escritura que hace el driver antes de correr la operación.
      const marked = await applyUnderLock(fs, locateRun(paths, SESSION), (current) => {
        if (current === null) throw new Error("esperaba la corrida");
        return { ok: true, state: withActionAttempted(current), value: null };
      });
      expect(marked.ok).toBe(true);

      for (let turn = 0; turn < MAX_BOUNDARY_ATTEMPTS; turn += 1) {
        await submitFlow(fs, paths, {
          code: CODE,
          approval: null,
          raw: JSON.stringify({
            input_digest: await seal(),
            outcome: "failed",
            invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
            validations: [{ id: "tablero", passed: false, detail: `intento ${turn}` }],
            effects: { planned: [], approved: [], applied: [] },
          }),
        });
      }
      const standing = await state();
      expect(standing.events).toEqual([]);
      expect(standing.pending_action?.attempted).toBe(true);

      const denied = await recover();
      if (denied.ok) throw new Error("una ejecución sin veredicto no se recupera");
      expect(denied.failure.code).toBe("FLOW_RECOVERY_EXECUTION_UNVERIFIED");
      expect(denied.failure.action).toContain("aw flow advance");
    });

    it("se niega cuando la frontera todavía se contesta, y cuando se nombra otra", async () => {
      const early = await recover();
      if (early.ok) throw new Error("recuperar no es una forma de saltear una frontera viva");
      expect(early.failure.code).toBe("FLOW_RECOVERY_NOT_NEEDED");
      expect(early.failure.message).toContain("fixture.observe");

      const elsewhere = await recover("fixture.wrap");
      if (elsewhere.ok) throw new Error("no se recupera una frontera que no está en curso");
      expect(elsewhere.failure.code).toBe("FLOW_RECOVERY_OTHER_BOUNDARY");
      expect(elsewhere.failure.action).toContain("fixture.observe");
    });
  });
});
