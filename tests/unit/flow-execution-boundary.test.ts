import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionDigest, resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { DelegatedAction, FlowDecision } from "../../src/domain/flow/authority.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import {
  FLOW_RUN_STATE_FILE,
  type FlowRunState,
  attemptsAt,
  newRunState,
  sealRunState,
  serializeRunState,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { decidedState } from "../helpers/decided-state.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * A delegated effect advances the run ONLY with a verifiable result.
 *
 * The journey below is a controlled executor, isolated from the production
 * registry on purpose: no live row declares a delegated action yet — that is its
 * tranche's job — and running this against the live rows would test the migration
 * instead of the contract. What is under test is the contract itself: the engine
 * names an invocation and stops, and nothing is credited until real output comes
 * back for exactly that invocation.
 */

vi.mock("../../src/domain/flow/authority.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/domain/flow/authority.js")>();
  const document = "loops/quick-loop/LOOP.md";
  const journey: FlowDecision[] = [
    {
      id: "fixture.observe",
      scope: "quick",
      title: "reconocer las señales del objetivo",
      authority: "agent",
      ownership: "cli-owned",
      document,
      signals: ["fixture.senal-a", "fixture.senal-b"],
    },
    {
      id: "fixture.seed",
      scope: "quick",
      title: "sembrar los artefactos de la sesión",
      authority: "cli",
      ownership: "cli-owned",
      document,
      // `local_authorizable` on purpose: this row stops at the EXECUTION boundary,
      // never at an authorization one, so the delegated contract is what is being
      // exercised and not the effect gate.
      effects: ["local_additive"],
      action: {
        invocation: {
          program: "aw",
          args: ["session-create", "--type", "quick", "--name", "prueba"],
          target: ".workflow/sessions",
          input: null,
        },
        evidence: ["sesion-creada"],
        idempotent: false,
        recovery: "revisá si la carpeta quedó a medias, borrala y volvé a sembrar",
      },
    },
    {
      id: "fixture.after-seed",
      scope: "quick",
      title: "derivar el tramo de la corrida",
      authority: "cli",
      ownership: "cli-owned",
      document,
    },
    {
      id: "fixture.validate",
      scope: "quick",
      title: "correr las validaciones proporcionales",
      authority: "cli",
      ownership: "cli-owned",
      document,
      // Not self-authorizable: the run has to be approved BEFORE the invocation is
      // ever named — which is the ordering this file also pins.
      effects: ["execute"],
      action: {
        invocation: { program: "npm", args: ["test"], target: ".", input: null },
        evidence: ["suite"],
        idempotent: true,
        recovery: "corregí lo que falló y volvé a correr la suite completa",
      },
    },
  ];
  // The fixture IS the whole journey here, transversal steps included: this
  // file is about what an execution boundary does, not about composition.
  return { ...real, journeyOfFlow: () => journey };
});

const SESSION = "001-prueba-quick";
const fs = new NodeFileSystem();

describe("frontera de ejecución — nada se acredita sin resultado", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-execution-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — prueba\n\n## Objective\nprobar\n",
      "utf8",
    );
    const adopted = await advanceFlow(fs, paths, { code: "001", flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const statePath = (): string => join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE);
  // The decided part only: a refused answer spends an attempt now, and that count
  // is the mechanism behind the boundary cap. See `tests/helpers/decided-state.ts`.
  //
  // The TRACE leaves with it, and only in this file, because only an execution
  // boundary can produce one on a rejection: a refused result that declared
  // applied effects still moved the world, and the trace is the only record of
  // it. That it is written — and that nothing is credited for it — is asserted
  // on its own below, so it is checked rather than merely excluded.
  const bytes = async (): Promise<string> => {
    const { events: _trace, ...decided } = decidedState(
      await readFile(statePath(), "utf8"),
    ) as Record<string, unknown>;
    return JSON.stringify(decided);
  };

  async function state(): Promise<FlowRunState> {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return read.state;
  }

  async function seal(): Promise<string> {
    const current = await state();
    const { journeyOfFlow } = await import("../../src/domain/flow/authority.js");
    return resolveBoundary(current, journeyOfFlow(current.flow)).seal;
  }

  async function submit(raw: string, approval: string | null = null): Promise<FlowDirective> {
    const result = await submitFlow(fs, paths, { code: "001", raw, approval });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true, no ok:false");
    return result.directive;
  }

  /** Answer the semantic row so the run reaches the delegated one. */
  async function reachSeed(): Promise<FlowDirective> {
    return submit(JSON.stringify({ input_digest: await seal(), signals: ["fixture.senal-a"] }));
  }

  /** Put the run back where `beforeEach` left it, attempts included. */
  async function reseed(): Promise<void> {
    await rm(statePath());
    const adopted = await advanceFlow(fs, paths, { code: "001", flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba re-adoptar la corrida");
  }

  /** A well-formed result for the seeding action, tweakable per case. */
  function seedResult(
    digest: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      input_digest: digest,
      outcome: "completed",
      invocation: {
        program: "aw",
        args: ["session-create", "--type", "quick", "--name", "prueba"],
        target: ".workflow/sessions",
        input: null,
      },
      validations: [
        {
          id: "sesion-creada",
          passed: true,
          detail: "created .workflow/sessions/002-prueba-quick",
        },
      ],
      effects: { planned: ["local_additive"], approved: [], applied: ["local_additive"] },
      ...overrides,
    };
  }

  it("la directiva nombra la invocación exacta y no aplica nada todavía", async () => {
    const directive = await reachSeed();
    expect(directive.boundary.kind).toBe("execution");
    expect(directive.boundary.transition).toBe("fixture.seed");
    const action = directive.action as DelegatedAction;
    expect(action.invocation.program).toBe("aw");
    expect(action.invocation.args).toContain("session-create");
    expect(action.evidence).toEqual(["sesion-creada"]);
    expect(action.recovery.length).toBeGreaterThan(0);
    // The exact call, projected — not a description of it.
    expect(directive.next_action).toContain("aw session-create --type quick --name prueba");
    expect(directive.next_action).toContain("sesion-creada");

    // Decided, NOT applied: the transition is still pending and its effect never
    // reached the ledger.
    const current = await state();
    expect(current.applied).toEqual(["fixture.observe"]);
    expect(current.effects.applied).not.toContain("local_additive");
    expect(directive.pending).toContain("fixture.seed");
    // And the run says what it is waiting on, sealed.
    expect(current.pending_action?.transition).toBe("fixture.seed");
    expect(current.pending_action?.digest).toBe(actionDigest(action));
  });

  it("si la acción cambió bajo una corrida en vuelo, el resultado se rechaza diciendo eso", async () => {
    await reachSeed();
    const run = await state();
    // What a CLI upgraded mid-run looks like from the state's side: the emitted
    // action is no longer the one the registry builds today. Re-sealed on purpose
    // — a hand-edited file would die as tampered and prove nothing about this.
    const { digest: _seal, ...rest } = run;
    await writeFile(
      statePath(),
      serializeRunState(
        sealRunState({
          ...rest,
          pending_action: {
            transition: "fixture.seed",
            digest: "sello-de-otra-accion",
            attempted: false,
          },
        }),
      ),
      "utf8",
    );
    const before = await bytes();
    const directive = await submit(JSON.stringify(seedResult(await seal())));
    expect(directive.error?.code).toBe("FLOW_ACTION_CHANGED");
    expect(directive.error?.action).toContain("aw flow advance");
    expect(await bytes()).toBe(before);
  });

  it("la señal declarada queda persistida para la regla que la consume después", async () => {
    await reachSeed();
    const current = await state();
    expect(current.observations).toEqual([
      { transition: "fixture.observe", signals: ["fixture.senal-a"] },
    ]);
  });

  it("una confirmación booleana no es un resultado", async () => {
    await reachSeed();
    const before = await bytes();
    const directive = await submit(JSON.stringify({ input_digest: await seal(), confirmed: true }));
    expect(directive.error?.code).toBe("FLOW_RESULT_INVALID");
    expect(directive.boundary.kind).toBe("execution");
    expect(await bytes()).toBe(before);
  });

  /**
   * Un campo ausente y un valor fuera del vocabulario son fallas DISTINTAS.
   *
   * Compartían una sola frase y la frase describía nada más que la segunda. El
   * costo se midió en el probe multihost: un host que había anidado todo su
   * resultado bajo `execution` leyó «'outcome' tiene que ser uno de …», corrigió
   * el VALOR exactamente como se le pedía, conservó el envoltorio, recibió el
   * mismo mensaje y quemó los intentos que le quedaban hasta abandonar la sesión.
   * Un diagnóstico que nombra el campo equivocado convierte a un ejecutor
   * obediente en un bucle.
   */
  it("un 'outcome' fuera del vocabulario lo dice, que es el único caso donde esa frase es cierta", async () => {
    await reachSeed();
    const before = await bytes();
    const directive = await submit(
      JSON.stringify(seedResult(await seal(), { outcome: "success" })),
    );
    expect(directive.error?.code).toBe("FLOW_RESULT_INVALID");
    expect(directive.error?.message).toContain("tiene que ser uno de");
    expect(await bytes()).toBe(before);
  });

  it("un 'outcome' anidado en otro objeto se nombra por su envoltorio, no por su valor", async () => {
    await reachSeed();
    const before = await bytes();
    const { outcome: _fuera, ...resto } = seedResult(await seal());
    const directive = await submit(
      JSON.stringify({ input_digest: await seal(), execution: { ...resto, outcome: "completed" } }),
    );
    expect(directive.error?.code).toBe("FLOW_RESULT_INVALID");
    expect(directive.error?.message).toContain("'execution'");
    expect(directive.error?.message).toContain("nivel superior");
    // Lo que rompía: mandar a revisar el vocabulario cuando el valor era correcto.
    expect(directive.error?.message).not.toContain("tiene que ser uno de");
    expect(await bytes()).toBe(before);
  });

  it("un 'outcome' simplemente ausente dice que falta, sin inventarle un culpable", async () => {
    await reachSeed();
    const before = await bytes();
    const { outcome: _fuera, ...resto } = seedResult(await seal());
    const directive = await submit(JSON.stringify({ ...resto, input_digest: await seal() }));
    expect(directive.error?.code).toBe("FLOW_RESULT_INVALID");
    expect(directive.error?.message).toContain("no trae 'outcome'");
    expect(directive.error?.message).not.toContain("tiene que ser uno de");
    expect(await bytes()).toBe(before);
  });

  /**
   * El rechazo de `validations` nombra la forma, no un tipo de TypeScript.
   *
   * El mensaje anterior decía «la lista de ValidationOutcome del resultado»: un
   * nombre que no aparece en ningún documento que el host pueda leer, sin las tres
   * claves ni los ids que la frontera exige. Costó ONCE sesiones descartables a un
   * host —objetivo declarado: «descubrir el contrato de aw flow submit»— y otro
   * host, por separado, hizo la misma conjetura equivocada: `name` donde va `id` y
   * `evidence` donde va `detail`. Lo que corta el bucle es que el mensaje diga qué
   * claves TRAJO la entrada, porque convierte una búsqueda en un renombre.
   */
  it("una validación con las claves equivocadas dice cuáles trajo y cuál falta", async () => {
    await reachSeed();
    const before = await bytes();
    const directive = await submit(
      JSON.stringify(
        seedResult(await seal(), {
          // La forma exacta que mandaron los dos hosts del probe.
          validations: [{ name: "sesion-creada", passed: true, evidence: "creada" }],
        }),
      ),
    );

    expect(directive.error?.code).toBe("FLOW_RESULT_INVALID");
    expect(directive.error?.message).toContain("no trae 'id'");
    expect(directive.error?.message).toContain("name");
    expect(directive.error?.message).toContain("evidence");
    // Y ya no nombra un tipo que el host no puede leer en ningún lado.
    expect(directive.error?.message).not.toContain("ValidationOutcome");
    expect(await bytes()).toBe(before);
  });

  it("una lista que no es lista nombra la forma y los ids que la frontera pide", async () => {
    await reachSeed();
    const before = await bytes();
    const directive = await submit(
      JSON.stringify(seedResult(await seal(), { validations: "todo bien" })),
    );

    expect(directive.error?.code).toBe("FLOW_RESULT_INVALID");
    expect(directive.error?.message).toContain("{id, passed, detail}");
    // Los ids no se describen en abstracto: son los que ESTA frontera declaró.
    expect(directive.error?.message).toContain("sesion-creada");
    expect(await bytes()).toBe(before);
  });

  it("un resultado que no declara qué se ejecutó no avanza", async () => {
    await reachSeed();
    const before = await bytes();
    const payload = seedResult(await seal());
    // biome-ignore lint/performance/noDelete: the case IS the absent field.
    delete payload.invocation;
    const directive = await submit(JSON.stringify(payload));
    expect(directive.error?.code).toBe("FLOW_RESULT_INVALID");
    expect(directive.error?.message).toContain("invocación");
    expect(await bytes()).toBe(before);
  });

  it("una invocación distinta de la sellada no avanza", async () => {
    await reachSeed();
    const before = await bytes();
    const directive = await submit(
      JSON.stringify(
        seedResult(await seal(), {
          invocation: {
            program: "aw",
            args: ["session-create", "--type", "exec", "--name", "prueba"],
            target: ".workflow/sessions",
            input: null,
          },
        }),
      ),
    );
    expect(directive.error?.code).toBe("FLOW_ACTION_MISMATCH");
    expect(directive.error?.action).toContain("aw session-create --type quick");
    expect(await bytes()).toBe(before);
    expect((await state()).applied).toEqual(["fixture.observe"]);
  });

  it("una salida fallida conserva la transición pendiente y devuelve recuperación", async () => {
    await reachSeed();
    const before = await bytes();
    const directive = await submit(
      JSON.stringify(seedResult(await seal(), { outcome: "failed", validations: [] })),
    );
    expect(directive.error?.code).toBe("FLOW_EXECUTION_NOT_COMPLETED");
    expect(directive.outcome).toBe("failed");
    expect(directive.next_action).toContain("borrala y volvé a sembrar");
    expect(directive.boundary.transition).toBe("fixture.seed");
    expect(await bytes()).toBe(before);
  });

  it("sin la evidencia exigida —o con una vacía— no aplica", async () => {
    for (const validations of [
      [],
      [{ id: "sesion-creada", passed: false, detail: "no se pudo crear" }],
      [{ id: "sesion-creada", passed: true, detail: "  " }],
      [{ id: "otra-cosa", passed: true, detail: "algo" }],
    ]) {
      // A fresh run per shape: four refused results in a row at ONE boundary is
      // not four ways of failing evidence, it is the loop the attempts cap stops,
      // and the third would degrade the boundary before the fourth arrived.
      await reseed();
      await reachSeed();
      const before = await bytes();
      const directive = await submit(JSON.stringify(seedResult(await seal(), { validations })));
      expect(directive.error?.code, JSON.stringify(validations)).toBe("FLOW_EVIDENCE_MISSING");
      expect(directive.error?.message).toContain("sesion-creada");
      expect(await bytes()).toBe(before);
    }
  });

  /**
   * El sobre no gasta intentos; el resultado evaluado sí.
   *
   * Es la mitad medida del defecto: los mismos dos mensajes que este archivo
   * documenta —el `outcome` anidado, las claves de `validations`— se descubrían
   * quemando el techo de la frontera, así que dos typos del sobre más un intento
   * real la agotaban antes de haberla podido contestar una sola vez.
   */
  it("un sobre que no es un resultado no gasta intento; una invocación distinta sí", async () => {
    await reachSeed();
    await submit(JSON.stringify({ input_digest: await seal(), confirmed: true }));
    expect(attemptsAt(await state(), "fixture.seed")).toBe(0);
    const { outcome: _fuera, ...resto } = seedResult(await seal());
    await submit(JSON.stringify({ ...resto, input_digest: await seal() }));
    expect(attemptsAt(await state(), "fixture.seed")).toBe(0);

    // Y lo que sí llegó a evaluarse: el resultado dice haber corrido otra cosa.
    await submit(
      JSON.stringify(
        seedResult(await seal(), {
          invocation: {
            program: "aw",
            args: ["session-create", "--type", "exec", "--name", "prueba"],
            target: ".workflow/sessions",
            input: null,
          },
        }),
      ),
    );
    expect(attemptsAt(await state(), "fixture.seed")).toBe(1);
  });

  /**
   * Lo que NADIE ejecutó no se degrada solo, ni siquiera agotado.
   *
   * El límite del tratamiento acotado que esta fase le dio a una ejecución
   * fallida: degradar una fila delegada da por hecha una siembra, una escritura
   * o un chequeo, y acá la corrida no tiene una sola prueba de que algo haya
   * corrido —ningún evento en la traza—. Sigue bloqueada, y el bloqueo enseña la
   * salida en vez de ser un callejón.
   */
  it("agotada sin haberse ejecutado nunca, la frontera bloquea y nombra su salida", async () => {
    await reachSeed();
    for (let turn = 0; turn < 3; turn += 1) {
      await submit(
        JSON.stringify(
          seedResult(await seal(), {
            outcome: "failed",
            validations: [{ id: "sesion-creada", passed: false, detail: `intento ${turn}` }],
            // Y no declara haber aplicado nada: es la premisa del caso. Un
            // resultado que SÍ declara efectos deja su rastro en la traza, que
            // es lo que la prueba de abajo cubre.
            effects: { planned: ["local_additive"], approved: [], applied: [] },
          }),
        ),
      );
    }
    const current = await state();
    expect(attemptsAt(current, "fixture.seed")).toBe(3);
    expect(current.events).toEqual([]);

    const advanced = await advanceFlow(fs, paths, { code: "001", adopt: false });
    if (!advanced.ok) throw new Error("esperaba una directiva");
    expect(advanced.directive.boundary.kind).toBe("blocked");
    expect(advanced.directive.error?.code).toBe("FLOW_BOUNDARY_EXHAUSTED");
    expect(advanced.directive.error?.action).toContain(`aw flow recover --session ${SESSION}`);
    // No se degradó: nada se dio por hecho.
    const after = await state();
    expect(after.skipped).not.toContain("fixture.seed");
    expect(after.degraded ?? []).toEqual([]);
  });

  /**
   * Un resultado rechazado no es un resultado sobre nada.
   *
   * El ejecutor pudo haber corrido el comando y escrito el archivo y volver con
   * una evidencia que la frontera no aceptó: el efecto llegó al mundo igual. La
   * traza sólo la escribía el ejecutor interno, así que eso no quedaba
   * registrado en ningún lado — y `aw flow recover`, cuya única guarda es
   * justamente esa traza, devolvía como contestable una frontera que ya había
   * aplicado algo.
   */
  it("un resultado rechazado que declaró efectos deja su rastro, sin acreditar nada", async () => {
    await reachSeed();
    const directive = await submit(
      JSON.stringify(
        seedResult(await seal(), {
          validations: [{ id: "sesion-creada", passed: false, detail: "quedó a medias" }],
        }),
      ),
    );
    expect(directive.error?.code).toBe("FLOW_EVIDENCE_MISSING");
    const after = await state();
    const trace = after.events.filter((event) => event.transition === "fixture.seed");
    expect(trace).toHaveLength(1);
    const only = trace[0];
    if (only === undefined || only.kind !== "failed") throw new Error("esperaba un evento fallido");
    expect(only.effects).toEqual(["local_additive"]);
    expect(only.operation).toContain("aw session-create");
    // Rastro no es crédito: el ledger de efectos de la corrida no se mueve, y la
    // transición sigue sin aplicarse.
    expect(after.effects.applied).not.toContain("local_additive");
    expect(after.applied).not.toContain("fixture.seed");
  });

  it("un resultado vencido no avanza", async () => {
    await reachSeed();
    const before = await bytes();
    const directive = await submit(JSON.stringify(seedResult("0".repeat(64))));
    expect(directive.error?.code).toBe("FLOW_ANSWER_STALE");
    expect(await bytes()).toBe(before);
  });

  it("un efecto parcial queda pendiente con acción de reconciliación", async () => {
    await reachSeed();
    const before = await bytes();
    const directive = await submit(
      JSON.stringify(
        seedResult(await seal(), {
          effects: { planned: ["local_additive"], approved: [], applied: [] },
        }),
      ),
    );
    expect(directive.error?.code).toBe("FLOW_EFFECT_PARTIAL");
    expect(directive.error?.message).toContain("local_additive");
    expect(directive.next_action).toContain("borrala y volvé a sembrar");
    expect(directive.boundary.transition).toBe("fixture.seed");
    expect(await bytes()).toBe(before);
  });

  it("una salida que se declara parcial no aplica, aunque el outcome diga completada", async () => {
    await reachSeed();
    const before = await bytes();
    const directive = await submit(
      JSON.stringify(
        seedResult(await seal(), {
          output: { value: null, reference: null, completeness: "partial" },
        }),
      ),
    );
    expect(directive.error?.code).toBe("FLOW_EFFECT_PARTIAL");
    expect(directive.next_action).toContain("borrala y volvé a sembrar");
    expect(await bytes()).toBe(before);
  });

  it("una salida completada con su evidencia aplica exactamente una vez y sigue avanzando", async () => {
    await reachSeed();
    const payload = JSON.stringify(seedResult(await seal()));
    const directive = await submit(payload);
    expect(directive.error).toBeNull();
    // The delegated step applied, and the deterministic one after it too — one
    // invocation exhausts what it owns, as ever.
    expect(directive.applied.map((step) => step.transition)).toEqual([
      "fixture.seed",
      "fixture.after-seed",
    ]);
    const after = await state();
    expect(after.applied).toEqual(["fixture.observe", "fixture.seed", "fixture.after-seed"]);
    expect(after.effects.applied).toContain("local_additive");
    expect(after.pending_action).toBeNull();

    // Exactly once: the SAME payload resent — what a retry after a lost response
    // looks like — is recognised as already applied instead of running twice.
    const bytesAfter = await bytes();
    const resent = await submit(payload);
    expect(resent.error?.code).toBe("FLOW_ANSWER_RESENT");
    expect(await bytes()).toBe(bytesAfter);
    expect((await state()).applied.filter((id) => id === "fixture.seed")).toHaveLength(1);
  });
});

describe("la acción viaja sellada: cambiar cualquier campo vuelve stale el resultado", () => {
  const base: DelegatedAction = {
    // Deliberately not a `docs/` path: the run is `quick`, which may write none,
    // so a docs target would block the boundary before its seal is the subject.
    invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
    evidence: ["busqueda"],
    idempotent: true,
    recovery: "volvé a correr la búsqueda",
  };

  function rowWith(action: DelegatedAction): FlowDecision[] {
    return [
      {
        id: "fixture.sellada",
        scope: "quick",
        title: "buscar lo que ya existe",
        authority: "cli",
        ownership: "cli-owned",
        document: "loops/quick-loop/LOOP.md",
        action,
      },
    ];
  }

  const mutations: Array<[string, DelegatedAction]> = [
    ["el programa", { ...base, invocation: { ...base.invocation, program: "rg" } }],
    ["un argumento", { ...base, invocation: { ...base.invocation, args: ["status"] } }],
    ["el target", { ...base, invocation: { ...base.invocation, target: "otra/carpeta" } }],
    ["el input", { ...base, invocation: { ...base.invocation, input: "algo" } }],
    ["la evidencia exigida", { ...base, evidence: ["otra"] }],
  ];

  it.each(mutations)("cambiar %s cambia el sello de la frontera", (_what, mutated) => {
    const state = newRunState("quick", SESSION);
    const before = resolveBoundary(state, rowWith(base)).seal;
    const after = resolveBoundary(state, rowWith(mutated)).seal;
    expect(after).not.toBe(before);
    expect(actionDigest(mutated)).not.toBe(actionDigest(base));
  });

  it("una acción que no cambió conserva su sello", () => {
    const state = newRunState("quick", SESSION);
    expect(resolveBoundary(state, rowWith({ ...base })).seal).toBe(
      resolveBoundary(state, rowWith(base)).seal,
    );
  });
});

describe("autorización y ejecución son dos actos distintos", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-execution-auth-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — prueba\n\n## Objective\nprobar\n",
      "utf8",
    );
    await advanceFlow(fs, paths, { code: "001", flow: "quick", adopt: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function current(): Promise<FlowRunState> {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error("esperaba leer la corrida");
    return read.state;
  }

  async function seal(): Promise<string> {
    const { journeyOfFlow } = await import("../../src/domain/flow/authority.js");
    const run = await current();
    return resolveBoundary(run, journeyOfFlow(run.flow)).seal;
  }

  async function submit(raw: string, approval: string | null = null): Promise<FlowDirective> {
    const result = await submitFlow(fs, paths, { code: "001", raw, approval });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true, no ok:false");
    return result.directive;
  }

  /** Walk to the row whose effect nobody authorized yet. */
  async function reachValidate(): Promise<FlowDirective> {
    await submit(JSON.stringify({ input_digest: await seal(), signals: ["fixture.senal-a"] }));
    return submit(
      JSON.stringify({
        input_digest: await seal(),
        outcome: "completed",
        invocation: {
          program: "aw",
          args: ["session-create", "--type", "quick", "--name", "prueba"],
          target: ".workflow/sessions",
          input: null,
        },
        validations: [{ id: "sesion-creada", passed: true, detail: "created" }],
        effects: { planned: ["local_additive"], approved: [], applied: ["local_additive"] },
      }),
    );
  }

  it("un efecto sin autorizar se pregunta ANTES de nombrar la invocación", async () => {
    const directive = await reachValidate();
    expect(directive.boundary.kind).toBe("authorization");
    expect(directive.boundary.transition).toBe("fixture.validate");
    // No invocation is handed out while its effect is unapproved, and the run does
    // not claim to be waiting on one.
    expect(directive.action).toBeNull();
    expect((await current()).pending_action).toBeNull();
  });

  it("aprobar el efecto NO ejecuta la acción: la frontera pasa a ser de ejecución", async () => {
    const asked = await reachValidate();
    const approval = asked.next_action.match(/--approval ([a-z0-9:]+)/)?.[1];
    expect(approval).toBeDefined();

    const directive = await submit(
      JSON.stringify({ input_digest: asked.state_digest, choice: "Autorizar el efecto" }),
      approval ?? null,
    );
    expect(directive.error).toBeNull();
    expect(directive.boundary.kind).toBe("execution");
    expect(directive.boundary.transition).toBe("fixture.validate");
    expect(directive.action?.invocation.program).toBe("npm");
    // The approval was recorded and NOTHING was applied by it.
    expect(directive.applied).toEqual([]);
    const run = await current();
    expect(run.authorizations.flatMap((grant) => grant.classes)).toContain("execute");
    expect(run.effects.applied).not.toContain("execute");
    expect(run.applied).not.toContain("fixture.validate");
    expect(run.pending_action?.transition).toBe("fixture.validate");
  });

  it("la autorización previa no reemplaza la salida: recién el resultado cierra el recorrido", async () => {
    const asked = await reachValidate();
    const approval = asked.next_action.match(/--approval ([a-z0-9:]+)/)?.[1];
    await submit(
      JSON.stringify({ input_digest: asked.state_digest, choice: "Autorizar el efecto" }),
      approval ?? null,
    );

    const done = await submit(
      JSON.stringify({
        input_digest: await seal(),
        outcome: "completed",
        invocation: { program: "npm", args: ["test"], target: ".", input: null },
        validations: [{ id: "suite", passed: true, detail: "196 files, 2880 tests passed" }],
        effects: { planned: ["execute"], approved: ["execute"], applied: ["execute"] },
      }),
    );
    expect(done.error).toBeNull();
    expect(done.boundary.kind).toBe("final");
    expect(done.outcome).toBe("completed");
    expect(done.pending).toEqual([]);
    const run = await current();
    expect(run.applied).toContain("fixture.validate");
    expect(run.effects.applied).toContain("execute");
    expect(run.pending_action).toBeNull();
  });
});
