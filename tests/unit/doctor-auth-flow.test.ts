import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import { annotateRepairs } from "../../src/application/doctor/actions.js";
import { applyDoctorBatch } from "../../src/application/doctor/apply.js";
import { runDoctorAuthFlow } from "../../src/application/doctor/auth-flow.js";
import type { DoctorAuthCliProvider } from "../../src/application/doctor/auth-registry.js";
import { prepareDoctorBatch } from "../../src/application/doctor/prepare.js";
import { createToolsAuthProvider } from "../../src/application/doctor/provider-tools-auth.js";
import { type DoctorRunDeps, runDoctor } from "../../src/application/doctor/report.js";
import type { DoctorProviderInput } from "../../src/application/doctor/types.js";
import { PathsService } from "../../src/application/paths-service.js";
import { doctorCommand } from "../../src/cli/commands/doctor.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { EffectClass } from "../../src/domain/capability/effects.js";
import type { DoctorAuthCheck, DoctorAuthFlow } from "../../src/domain/doctor/auth.js";
import type { DoctorFinding } from "../../src/domain/doctor/model.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";

/**
 * El flujo declarado, de punta a punta y con UN solo doble en el medio.
 *
 * Ningún proveedor real declara un flujo —y una prueba hermana lo fija—, así que
 * la maquinaria se ejercita con un proveedor de fixture. Lo importante es qué NO
 * se dobla: el proveedor de diagnóstico, el anotador, el sellado, `apply` con su
 * candado, el adaptador de reparaciones y la recomprobación son los de
 * producción. Lo único doblado es el proveedor de autenticación y el puerto de
 * procesos, que es exactamente la frontera donde el CLI dejaría de tener el
 * control del secreto.
 *
 * Las cuatro salidas que fija, y por qué son cuatro y no dos:
 *
 *  - autorizado y la credencial queda puesta → `applied` + recomprobación
 *    `resolved`, y el lote `completed`;
 *  - corrió, salió 0 y la credencial SIGUE ausente → `pending`. Es el caso que
 *    prueba que el desenlace lo decide `verify` y no el código de salida: un
 *    programa que devuelve 0 y una credencial que funciona son dos hechos
 *    distintos;
 *  - la verificación no pudo concluir → `unverified`, jamás `resolved`;
 *  - sin aprobación → no corre NADA. Se cuentan las corridas del puerto y se
 *    exige cero, porque un rechazo que llega después de la primera ejecución no
 *    es un rechazo.
 */

const NS = normalizeNamespace("workflow");
const RUNTIME: ResolvedRuntime = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  source: "default",
};

/** El sujeto del doble: nombrado como una variable, para que la redacción lo toque. */
const SUBJECT = { id: "fixture:uno", label: "DB_FIXTURE_DSN" };
/** El archivo donde el doble dice que vive su credencial. */
const SUBJECT_LOCATOR = "/tmp/workline-fixture-credenciales.env";
const FINDING_ID = `workspace/tools-auth/${SUBJECT.id}`;
/** Valor inventado con forma de DSN: la premisa de las aserciones de redacción. */
const FAKE_DSN = "postgres://usuario:CLAVE-INVENTADA-9f3a@localhost:5432/fixture";
const ARGV = ["login-de-fixture", "--sujeto", "uno"];

/**
 * El proveedor de autenticación doble, con estado mutable a propósito.
 *
 * La recomprobación de `apply` es el MISMO proveedor releyendo, así que la única
 * forma honesta de distinguir `resolved` de `pending` es que el flujo cambie de
 * verdad lo que este doble reporta. Un doble de recomprobación aparte probaría
 * que dos dobles concuerdan.
 */
class FixtureAuth implements DoctorAuthCliProvider {
  readonly id: string;
  /** Cada nivel de autorización con el que se pidió verificar, en orden. */
  readonly verifications: EffectClass[][] = [];
  private authenticated = false;
  private verifyState: DoctorAuthCheck["state"] | null = null;

  constructor(
    private readonly declaredFlow: DoctorAuthFlow | null,
    id = "doble",
  ) {
    this.id = id;
  }

  /** Lo que el flujo logra cuando corre: el sujeto queda autenticado. */
  authenticate(): void {
    this.authenticated = true;
  }

  /** Fuerza el desenlace de `verify`, para el caso que no puede concluir. */
  verifiesAs(state: DoctorAuthCheck["state"]): void {
    this.verifyState = state;
  }

  subjects() {
    return [{ ...SUBJECT, locator: SUBJECT_LOCATOR }];
  }

  async check(): Promise<DoctorAuthCheck> {
    return this.observation();
  }

  flow(): DoctorAuthFlow | null {
    return this.declaredFlow;
  }

  /**
   * Su verificación es LOCAL, así que no exige ninguna clase extra.
   *
   * Es lo que hace que la recomprobación de un lote `execute` llame de verdad a
   * `verify`: un proveedor que declarara `network_external` vería su
   * verificación degradada a la lectura barata, que es la otra rama y se prueba
   * aparte.
   */
  verify = {
    authorization: null,
    run: async (
      _subject: { id: string },
      _ctx: CliContext,
      granted: readonly EffectClass[],
    ): Promise<DoctorAuthCheck> => {
      this.verifications.push([...granted]);
      if (this.verifyState !== null) {
        return { state: this.verifyState, evidence: ["la verificación no pudo concluir"] };
      }
      return this.observation();
    },
  };

  guidance(): string[] {
    // Nombra la variable entre paréntesis y el valor NUNCA: es la misma regla que
    // el proveedor real, y acá se ejercita contra la redacción del informe.
    return [`exportá la variable (${SUBJECT.label}) con la cadena de conexión`];
  }

  private observation(): DoctorAuthCheck {
    return this.authenticated
      ? { state: "present", evidence: [`variable (${SUBJECT.label}): presente`] }
      : { state: "absent", evidence: [`variable (${SUBJECT.label}): ausente`] };
  }
}

function flowOf(overrides: Partial<DoctorAuthFlow> = {}): DoctorAuthFlow {
  return { kind: "command", argv: ARGV, interactive: true, effects: ["execute"], ...overrides };
}

let root: string;
let home: string;
let proc: FakeProcess;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doctor-auth-flow-"));
  home = join(root, "home");
  mkdirSync(join(home, ".workflow", "dev"), { recursive: true });
  // Un registro de conexiones VACÍO: el `read_set` de cualquier lote lo lee, y así
  // el único sujeto de la corrida es el del doble.
  writeFileSync(
    join(home, ".workflow", "dev", "mcp-connections.json"),
    `${JSON.stringify({ version: 2, connections: [] })}\n`,
  );
  proc = new FakeProcess({ tty: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** El contexto real salvo el puerto de procesos: `apply` toma su candado de verdad. */
function makeCtx(): CliContext {
  return {
    fs: new NodeFileSystem(),
    env: new FakeEnv(home, home),
    process: proc,
    paths: new PathsService(NS, home, home),
    namespace: { namespace: NS, source: "default" },
    runtime: RUNTIME,
    skills: { roles: {}, source: "default" },
  } as unknown as CliContext;
}

function depsFor(auth: DoctorAuthCliProvider): DoctorRunDeps {
  return { providers: [createToolsAuthProvider({ providers: [auth] })] };
}

/** Sella el lote de ese único hallazgo y devuelve la propuesta. */
async function seal(ctx: CliContext, deps: DoctorRunDeps) {
  const prepared = await prepareDoctorBatch(ctx, { select: [FINDING_ID] }, deps);
  if (!prepared.ok || prepared.kind !== "sealed") {
    throw new Error(`no se pudo sellar: ${JSON.stringify(prepared)}`);
  }
  return prepared.proposal;
}

describe("un flujo de autenticación declarado, de punta a punta", () => {
  it("autorizado: corre el argv sellado, la recomprobación lo declara resuelto y el lote completa", async () => {
    const auth = new FixtureAuth(flowOf());
    const ctx = makeCtx();
    const deps = depsFor(auth);
    const proposal = await seal(ctx, deps);
    // El flujo hace lo que dice hacer: el sujeto queda autenticado.
    proc = new FakeProcess({
      tty: true,
      interactive: () => {
        auth.authenticate();
        return { code: 0 };
      },
    });

    const outcome = await applyDoctorBatch(
      makeCtx(),
      { approval: proposal.digest, select: [FINDING_ID] },
      deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.status).toBe("completed");
    expect(outcome.result.exit_code).toBe(0);
    const [action] = outcome.result.actions;
    expect(action.op).toBe("auth.flow");
    expect(action.status).toBe("applied");
    expect(action.recheck).toBe("resolved");
    // El programa que corrió es EXACTAMENTE el del argv sellado, separado, y desde
    // el workspace de la corrida.
    expect(proc.interactive).toEqual([
      { cmd: ARGV[0], args: ARGV.slice(1), cwd: makeCtx().paths.workspaceDir() },
    ]);
  });

  it("corrió y salió 0, pero la credencial sigue ausente: la recomprobación dice `pending`", async () => {
    // El defecto que atrapa: deducir el desenlace del código de salida. Un
    // programa que devuelve 0 sin dejar la credencial puesta dejaría el lote
    // `completed` y la persona creyendo que se resolvió.
    const auth = new FixtureAuth(flowOf());
    const ctx = makeCtx();
    const deps = depsFor(auth);
    const proposal = await seal(ctx, deps);

    const outcome = await applyDoctorBatch(
      makeCtx(),
      { approval: proposal.digest, select: [FINDING_ID] },
      deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.actions[0].status).toBe("applied");
    expect(outcome.result.actions[0].recheck).toBe("pending");
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.exit_code).toBe(1);
  });

  it("una verificación que no puede concluir queda `unverified`, nunca resuelta", async () => {
    const auth = new FixtureAuth(flowOf());
    const ctx = makeCtx();
    const deps = depsFor(auth);
    const proposal = await seal(ctx, deps);
    proc = new FakeProcess({
      tty: true,
      interactive: () => {
        auth.authenticate();
        auth.verifiesAs("unverified");
        return { code: 0 };
      },
    });

    const outcome = await applyDoctorBatch(
      makeCtx(),
      { approval: proposal.digest, select: [FINDING_ID] },
      deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.actions[0].recheck).toBe("unverified");
    expect(outcome.result.actions[0].recheck).not.toBe("resolved");
    expect(outcome.result.status).toBe("partial");
  });

  it("la recomprobación PIDE verificar, y con la autorización que dio la persona y nada más", async () => {
    // Dos cosas en una: que la recomprobación llame a `verify` —es lo que ata
    // `resolved` a la observación del proveedor en vez de al código de salida— y
    // que lo haga con un permiso VACÍO cuando la invocación no autorizó nada. Las
    // clases de la acción no se suman: una acción aprobada para salir de la
    // máquina autoriza a ESA acción, no a la relectura del entorno entero, y la
    // verificación de un informe no tiene alcance por sujeto.
    const auth = new FixtureAuth(flowOf({ effects: ["execute", "network_external"] }));
    const ctx = makeCtx();
    const deps = depsFor(auth);
    const proposal = await seal(ctx, deps);

    await applyDoctorBatch(makeCtx(), { approval: proposal.digest, select: [FINDING_ID] }, deps);

    expect(auth.verifications).toEqual([[]]);
  });

  it("sin aprobación no corre NADA: el puerto no registra ni una corrida", async () => {
    const auth = new FixtureAuth(flowOf());
    const deps = depsFor(auth);

    const outcome = await applyDoctorBatch(makeCtx(), { select: [FINDING_ID] }, deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.rejection.code).toBe("APPROVAL_REQUIRED");
    expect(proc.interactive).toEqual([]);
    expect(auth.verifications).toEqual([]);
  });

  it("sin terminal el flujo queda BLOQUEADO con su razón, y no se ejecuta", async () => {
    // `blocked` y no `failed`: nada corrió y el recurso quedó como estaba. El
    // secreto sólo puede ir de la persona al programa por la terminal.
    const auth = new FixtureAuth(flowOf());
    const ctx = makeCtx();
    const deps = depsFor(auth);
    const proposal = await seal(ctx, deps);
    proc = new FakeProcess({ tty: false });

    const outcome = await applyDoctorBatch(
      makeCtx(),
      { approval: proposal.digest, select: [FINDING_ID] },
      deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [action] = outcome.result.actions;
    expect(action.status).toBe("blocked");
    expect(action.reason).toContain("terminal");
    expect(action.recheck).toBe("blocked");
    expect(proc.interactive).toEqual([]);
  });

  it("un flujo que sale con código distinto de cero es una acción fallida con su código", async () => {
    const auth = new FixtureAuth(flowOf());
    const ctx = makeCtx();
    const deps = depsFor(auth);
    const proposal = await seal(ctx, deps);
    proc = new FakeProcess({ tty: true, interactive: () => ({ code: 3 }) });

    const outcome = await applyDoctorBatch(
      makeCtx(),
      { approval: proposal.digest, select: [FINDING_ID] },
      deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.actions[0].status).toBe("failed");
    expect(outcome.result.actions[0].reason).toContain("3");
    expect(outcome.result.status).toBe("failed");
  });

  it("la vista previa muestra los tokens exactos que se van a ejecutar", async () => {
    // Aprobar un lote que corre un comando sin ver sus tokens sería aprobar «un
    // flujo», no ESTE flujo.
    const proposal = await seal(makeCtx(), depsFor(new FixtureAuth(flowOf())));

    expect(proposal.preview.join("\n")).toContain(ARGV.join(" "));
    expect(proposal.batch.actions[0].argv).toEqual(ARGV);
    // Y `execute` no se autoriza solo: es lo que la aprobación habilita.
    expect(proposal.batch.requires_approval).toContain("execute");
  });

  it("los efectos del flujo se SUMAN a los de la operación antes de sellar", async () => {
    // El defecto que atrapa: un flujo que sale a la red bajo una aprobación que
    // sólo cubría `execute` sería una autorización que no autorizó lo que pasó.
    const proposal = await seal(
      makeCtx(),
      depsFor(new FixtureAuth(flowOf({ effects: ["network_external"] }))),
    );

    expect(proposal.batch.actions[0].effects.sort()).toEqual(["execute", "network_external"]);
    expect(proposal.batch.requires_approval).toContain("network_external");
  });

  it("el `read_set` nombra el registro del NAMESPACE vivo, no una ruta cableada", async () => {
    // El defecto que atrapa, y que estaba en produccion: el `read_set` armaba la
    // ruta del registro con un `join` propio hacia `~/.workflow/dev/…`. En
    // cualquier namespace que no sea `workflow` eso sella el digest de un archivo
    // que nadie lee, y entonces el compare-and-swap del lote no ataja nada: el
    // registro real puede cambiar entre la vista previa y la aprobacion sin mover
    // el digest.
    const other = normalizeNamespace("kimi-code");
    const ctx = {
      ...makeCtx(),
      paths: new PathsService(other, home, home),
      namespace: { namespace: other, source: "default" },
    } as unknown as CliContext;

    const prepared = await prepareDoctorBatch(
      ctx,
      { select: [FINDING_ID] },
      depsFor(new FixtureAuth(flowOf())),
    );
    if (!prepared.ok || prepared.kind !== "sealed") throw new Error("no se pudo sellar");

    const ids = prepared.proposal.read_set.map((entry) => entry.id);
    expect(ids).toContain(join(home, ".kimi-code", "dev", "mcp-connections.json"));
    expect(ids.join(" | ")).not.toContain(".workflow");
  });

  it("el `read_set` de un flujo lee el archivo que declaró el SUJETO, no uno por operación", async () => {
    // El defecto que atrapa: la operación cableaba `dsn.env`, el archivo del
    // único proveedor que declara `flow: null` y por lo tanto el único que NUNCA
    // puede producir esta acción. El compare-and-swap vigilaba bytes ajenos al
    // recurso mientras el archivo del recurso quedaba afuera del sello.
    const proposal = await seal(makeCtx(), depsFor(new FixtureAuth(flowOf())));

    const ids = proposal.read_set.map((entry) => entry.id);
    expect(ids).toContain(SUBJECT_LOCATOR);
    expect(ids.join(" | ")).not.toContain("dsn.env");
    // Y el locator del recurso entra al lote sellado: es parte de sobre QUÉ actúa.
    expect(proposal.batch.actions[0].locator).toBe(SUBJECT_LOCATOR);
  });

  it("cambiar un token del flujo cambia el digest: el argv es material", async () => {
    const uno = await seal(makeCtx(), depsFor(new FixtureAuth(flowOf())));
    const otro = await seal(
      makeCtx(),
      depsFor(new FixtureAuth(flowOf({ argv: [...ARGV, "--extra"] }))),
    );

    expect(otro.digest).not.toBe(uno.digest);
  });
});

describe("el ejecutor de flujos, en sus bordes", () => {
  /** La acción mínima que el ejecutor recibe. `argv` se pasa aparte. */
  function actionOf(argv?: readonly string[]) {
    return {
      finding_id: FINDING_ID,
      host: "workspace",
      resource: SUBJECT.label,
      op: "auth.flow",
      args: { provider: "doble", subject: SUBJECT.id },
      effects: ["execute"],
      depends_on: [],
      expected: "healthy",
      verb: "—",
      summary: "—",
      locator: SUBJECT_LOCATOR,
      ...(argv === undefined ? {} : { argv }),
    };
  }

  it("una acción sin programa sellado se declara FALLIDA y no corre nada", async () => {
    // La guarda fail-closed del ejecutor. Ningún camino de producción la alcanza
    // —la custodia ya rechaza un `argv` vacío antes de que exista la sugerencia—
    // pero es la última línea entre una acción malformada y correr algo
    // inventado, así que se prueba directo en vez de dejarla sin fijar: un
    // mutante que la borrara y usara un nombre por defecto no mataba ninguna
    // prueba.
    for (const argv of [undefined, [] as string[]]) {
      const outcome = await runDoctorAuthFlow(actionOf(argv), makeCtx());
      expect(outcome.status).toBe("failed");
      expect(outcome.detail).toContain("no lleva ningún programa");
      expect(proc.interactive).toEqual([]);
    }
  });

  it("corre desde el workspace, no desde el directorio de quien invocó", async () => {
    // El flujo hereda la terminal pero no el cwd de la persona: un login que
    // escribiera algo relativo lo haría en el workspace de la corrida.
    let seen: string | undefined;
    proc = new FakeProcess({
      tty: true,
      interactive: () => ({ code: 0 }),
    });
    const ctx = makeCtx();
    ctx.process.runInteractive = async (_cmd, _args, opts) => {
      seen = opts?.cwd;
      return { code: 0 };
    };

    await runDoctorAuthFlow(actionOf(ARGV), ctx);

    expect(seen).toBe(ctx.paths.workspaceDir());
  });
});

describe("lo que la recomprobación no puede declarar resuelto", () => {
  /**
   * Un proveedor que se cae en la TERCERA lectura, que es la de la recomprobación.
   *
   * Las dos primeras son el sellado y la recomputación bajo el candado: el lote
   * tiene que llegar a ejecutarse para que haya una recomprobación que juzgar. Si
   * se cayera antes, el rechazo sería otro —correcto, pero otro— y esta prueba no
   * tocaría la rama que persigue.
   */
  class Brittle extends FixtureAuth {
    private reads = 0;
    private observe(): DoctorAuthCheck {
      this.reads += 1;
      if (this.reads > 2) throw new Error("el registro quedó ilegible");
      return { state: "absent", evidence: [`variable (${SUBJECT.label}): ausente`] };
    }
    override async check(): Promise<DoctorAuthCheck> {
      return this.observe();
    }
    override verify = {
      authorization: null,
      run: async (): Promise<DoctorAuthCheck> => this.observe(),
    };
  }

  it("un proveedor que se cae durante la relectura deja `unverified`, NUNCA resuelto", async () => {
    // El defecto que atrapa: «el hallazgo ya no aparece» se leía como resuelto sin
    // mirar la cobertura. Cuando el proveedor que lo emitía LANZA, sus hallazgos
    // desaparecen TODOS y su categoría queda `unavailable` — así que un flujo que
    // corrió y no autenticó nada salía `completed` con salida 0 y la credencial
    // seguía ausente. Es la validación omitida presentada como superada que AC-12
    // prohíbe, y afecta a cualquier operación del catálogo.
    const auth = new Brittle(flowOf());
    const ctx = makeCtx();
    const deps = depsFor(auth);
    const proposal = await seal(ctx, deps);

    const outcome = await applyDoctorBatch(
      makeCtx(),
      { approval: proposal.digest, select: [FINDING_ID] },
      deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [action] = outcome.result.actions;
    expect(action.status).toBe("applied");
    expect(action.recheck).toBe("unverified");
    expect(action.recheck).not.toBe("resolved");
    // Y dice POR QUÉ no se puede concluir: la cobertura de esa categoría se cayó.
    expect(action.recheck_detail).toContain("nadie lo comprobó");
    expect(outcome.result.status).toBe("partial");
    expect(outcome.result.exit_code).toBe(1);
  });

  it("la recomprobación corre con el ALCANCE de la corrida, no con opciones inventadas", async () => {
    // El defecto que atrapa: `recheckOf` armaba sus opciones desde cero, así que
    // perdía `--skip-native` —el flag que existe porque inspeccionar los MCP
    // nativos LANZA los servidores del host— y volvía a hacer esa sonda una vez
    // por acción aplicada. Se observa en el propio input del proveedor.
    const auth = new FixtureAuth(flowOf());
    const seen: Array<{ skipNative: boolean; verify: readonly EffectClass[] | undefined }> = [];
    const spy = {
      category: "tools-auth" as const,
      run: async (input: DoctorProviderInput) => {
        seen.push({ skipNative: input.skipNative, verify: input.verifyAuthorization });
        return await createToolsAuthProvider({ providers: [auth] }).run(input);
      },
    };
    const deps = { providers: [spy] };
    const proposal = await prepareDoctorBatch(
      makeCtx(),
      { select: [FINDING_ID], skipNative: true, verify: ["network_external"] },
      deps,
    );
    if (!proposal.ok || proposal.kind !== "sealed") throw new Error("no se pudo sellar");
    seen.length = 0;

    await applyDoctorBatch(
      makeCtx(),
      {
        approval: proposal.proposal.digest,
        select: [FINDING_ID],
        skipNative: true,
        verify: ["network_external"],
      },
      deps,
    );

    // Dos corridas: la recomputación bajo el candado y la recomprobación. Las DOS
    // honran el opt-out, y las dos conservan —exactamente— la autorización que la
    // persona dio en la invocación.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    for (const run of seen) expect(run.skipNative).toBe(true);
    expect(seen[seen.length - 1]?.verify).toEqual(["network_external"]);
  });

  it("un recurso que se arregló a mano responde `already`, no un rechazo", async () => {
    // El defecto que atrapa: los proveedores emiten el hallazgo SANO en vez de
    // callarse, así que arreglar el recurso entre la vista previa y la aprobación
    // no lo hace desaparecer — lo vuelve `healthy`. `alreadySettled` cortaba en
    // «sigue presente» y la persona recibía SELECTION_NOT_ACTIONABLE con salida 1
    // sobre un recurso que ya estaba bien.
    const auth = new FixtureAuth(flowOf());
    const deps = depsFor(auth);
    const proposal = await seal(makeCtx(), deps);
    auth.authenticate();

    const outcome = await applyDoctorBatch(
      makeCtx(),
      { approval: proposal.digest, select: [FINDING_ID] },
      deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.status).toBe("already");
    expect(outcome.result.exit_code).toBe(0);
    expect(outcome.result.actions[0].recheck_detail).toContain("ya reporta sano");
    // Y nada corrió: `already` no es una corrida silenciosa.
    expect(proc.interactive).toEqual([]);
  });

  it("el detalle de una operación que LANZA pasa por el redactor", async () => {
    // El único texto del resultado que no viene del informe ya redactado es el
    // mensaje de una excepción, y el comando devuelve siempre `ok:true`, así que
    // la última línea de defensa del CLI —que sólo redacta la rama de error— no
    // lo cubre. Sin esto, un fallo cuyo mensaje trae una cadena de conexión la
    // publica íntegra por JSON y por texto.
    const auth = new FixtureAuth(flowOf());
    const deps = depsFor(auth);
    const proposal = await seal(makeCtx(), deps);

    const outcome = await applyDoctorBatch(
      makeCtx(),
      { approval: proposal.digest, select: [FINDING_ID] },
      {
        ...deps,
        executor: async () => {
          throw new Error(`fallo abriendo ${FAKE_DSN}`);
        },
      },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const [action] = outcome.result.actions;
    expect(action.status).toBe("failed");
    expect(action.reason).toContain("la operación lanzó");
    expect(action.reason).not.toContain("CLAVE-INVENTADA-9f3a");
    expect(JSON.stringify(outcome)).not.toContain("CLAVE-INVENTADA-9f3a");
  });
});

describe("la custodia bloquea antes de que exista un lote", () => {
  it("un flujo con la credencial en el argv deja el hallazgo BLOQUEANTE y sin acción", async () => {
    const auth = new FixtureAuth(flowOf({ argv: ["login", "--token", "abc123"] }));
    const report = await runDoctor(makeCtx(), {}, depsFor(auth));
    const [finding] = report.findings;

    expect(finding.state).toBe("blocking");
    expect(finding.remediation.kind).toBe("manual");
    expect(finding.remediation.action).toBeNull();
    expect(finding.evidence.join(" | ")).toContain("custodia");
    // Y el veredicto lo acusa: es un defecto del CLI, no del entorno.
    expect(report.verdict.exit_code).toBe(1);
  });

  it("ese hallazgo NO se puede sellar: `prepare` lo rechaza nombrándolo", async () => {
    const auth = new FixtureAuth(flowOf({ interactive: false }));
    const prepared = await prepareDoctorBatch(makeCtx(), { select: [FINDING_ID] }, depsFor(auth));

    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.rejection.code).toBe("SELECTION_NOT_ACTIONABLE");
    expect(prepared.rejection.candidates).toEqual([FINDING_ID]);
    expect(proc.interactive).toEqual([]);
  });

  it("un flujo con la credencial en el argv NO se vuelve acción, venga de la categoría que venga", () => {
    // El defecto que atrapa: la custodia la decidía sólo el proveedor de
    // `tools-auth`, que es UN productor de sugerencias. `flow` vive en la
    // sugerencia compartida, así que un proveedor de otra categoría podía
    // adjuntar uno y el anotador lo sellaba sin mirar la custodia — con el
    // secreto adentro del `argv`, impreso en la vista previa y ejecutado.
    const [annotated] = annotateRepairs([
      {
        id: "claude-code/mcps/entrada",
        host: "claude-code",
        category: "mcps",
        resource: { kind: "mcp-entry", name: "entrada", locator: null },
        state: "warning",
        summary: "algo",
        impact: "algo",
        evidence: [],
        ownership: "ours",
        remediation: { kind: "manual", action: null, guidance: [] },
        proposal: {
          op: "auth.flow",
          args: { provider: "ajeno" },
          flow: flowOf({ argv: ["login", "--token", "SECRETO"] }),
        },
      },
    ]);

    expect(annotated.remediation.action).toBeNull();
    expect(annotated.remediation.kind).not.toBe("supported");
  });

  it("un sujeto `unverified` con un flujo sano SÍ recibe la acción", () => {
    // El defecto que atrapa: ofrecer el flujo sólo cuando la credencial está
    // AUSENTE deja sin reparación al caso que más la necesita —«no se pudo
    // verificar»— y ninguna prueba lo veía.
    const auth = new FixtureAuth(flowOf());
    auth.verifiesAs("unverified");
    return runDoctor(makeCtx(), { verify: [] }, depsFor(auth)).then((report) => {
      const [finding] = report.findings;
      expect(finding.state).toBe("unverified");
      expect(finding.remediation.kind).toBe("supported");
      expect(finding.remediation.action?.op).toBe("auth.flow");
    });
  });

  it("en `tools-auth` ninguna operación que no sea el flujo recibe acción", () => {
    // El defecto que atrapa: cualquier otra operación sobre esta categoría
    // implicaría que el CLI escribe la credencial en algún lado, y entonces la
    // custodia del secreto pasa a ser suya.
    const base: DoctorFinding = {
      id: FINDING_ID,
      host: "workspace",
      category: "tools-auth",
      resource: { kind: "credential", name: SUBJECT.label, locator: null },
      state: "warning",
      summary: "falta autenticar",
      impact: "no se puede usar",
      evidence: [],
      ownership: "ours",
      remediation: { kind: "manual", action: null, guidance: [] },
    };

    const [other] = annotateRepairs([
      { ...base, proposal: { op: "mcp.setup", args: { host: "claude" } } },
    ]);
    expect(other.remediation.action).toBeNull();

    const [flow] = annotateRepairs([
      { ...base, proposal: { op: "auth.flow", args: { provider: "doble" }, flow: flowOf() } },
    ]);
    expect(flow.remediation.kind).toBe("supported");
    expect(flow.remediation.action?.argv).toEqual(ARGV);
  });
});

describe("dos proveedores que declaran el mismo sujeto", () => {
  it("la colisión se DENUNCIA como bloqueante y nombra a los dos, en vez de perderse", async () => {
    // El defecto que atrapa, y que sobrevivió a la primera ronda de mutación:
    // el id del sujeto es la identidad del hallazgo, así que el segundo se
    // descartaba en silencio y el informe quedaba hablando por un recurso que
    // nadie comprobó. Es el mismo defecto que ya costó una ronda en este plan,
    // cuando sanear un id lo volvió no inyectivo y los hallazgos desaparecieron
    // de un `Map`.
    const uno = new FixtureAuth(null, "uno");
    const dos = new FixtureAuth(null, "dos");

    const report = await runDoctor(
      makeCtx(),
      {},
      {
        providers: [createToolsAuthProvider({ providers: [uno, dos] })],
      },
    );

    const collision = report.findings.find((finding) => finding.id.includes("colision"));
    expect(collision, "la colisión no se denunció").toBeDefined();
    expect(collision?.state).toBe("blocking");
    expect(collision?.evidence.join(" | ")).toContain("uno");
    expect(collision?.evidence.join(" | ")).toContain("dos");
    // El primero SÍ se comprobó y conserva su propio hallazgo: la colisión no se
    // come al sujeto que sí se pudo mirar.
    expect(report.findings.map((finding) => finding.id)).toContain(FINDING_ID);
    // Y el veredicto lo acusa: hay un sujeto del que el informe no puede hablar.
    expect(report.verdict.exit_code).toBe(1);
  });

  it("con TRES proveedores homónimos las dos colisiones son dos filas, no una", async () => {
    // El mismo defecto un nivel más adentro: un id de colisión que sólo lleva el
    // sujeto es no inyectivo en cuanto hay dos duplicados, y el `Map` del informe
    // se queda con uno. El id lleva al proveedor duplicado justamente por eso.
    const report = await runDoctor(
      makeCtx(),
      {},
      {
        providers: [
          createToolsAuthProvider({
            providers: [
              new FixtureAuth(null, "uno"),
              new FixtureAuth(null, "dos"),
              new FixtureAuth(null, "tres"),
            ],
          }),
        ],
      },
    );

    const collisions = report.findings.filter((finding) => finding.id.includes("colision"));
    expect(collisions).toHaveLength(2);
    expect(new Set(collisions.map((finding) => finding.id)).size).toBe(2);
    expect(collisions.map((finding) => finding.evidence.join(" ")).join(" | ")).toContain("tres");
  });
});

describe("la autorización de la verificación, desde la superficie hacia adentro", () => {
  it("`--verify-connection` es booleano en el parser y no se traga el subverbo", () => {
    // El defecto que atrapa: sin declararlo, `consumeOptionFlag` toma el token
    // siguiente como su valor y `aw doctor --verify-connection prepare` corre el
    // informe en vez de preparar.
    const parsed = parseArgv(["doctor", "--verify-connection", "prepare"]);

    expect(parsed.flags.has("--verify-connection")).toBe(true);
    expect(parsed.rest).toEqual(["prepare"]);
    expect(parsed.values.has("verify-connection")).toBe(false);
  });

  it("sin el flag NADIE pide verificar: el informe usa la lectura barata", async () => {
    const auth = new FixtureAuth(null);
    await runDoctor(makeCtx(), {}, depsFor(auth));

    expect(auth.verifications).toEqual([]);
  });

  it("con el flag la autorización de red llega al proveedor", async () => {
    const auth = new FixtureAuth(null);
    await runDoctor(makeCtx(), { verify: ["network_external"] }, depsFor(auth));

    expect(auth.verifications).toEqual([["network_external"]]);
  });
});

describe("la redacción sobre las tres salidas de esta categoría", () => {
  /** El doble planta el valor del DSN donde el proveedor podría reflejarlo. */
  class Leaky extends FixtureAuth {
    override guidance(): string[] {
      return [`exportá ${SUBJECT.label}=${FAKE_DSN} en tu shell`];
    }
  }

  it("el informe nombra la variable y no deja pasar el valor", async () => {
    const report = await runDoctor(makeCtx(), {}, depsFor(new Leaky(flowOf())));
    const dump = JSON.stringify(report);

    expect(dump).toContain(SUBJECT.label);
    expect(dump).not.toContain("CLAVE-INVENTADA-9f3a");
    expect(dump).not.toContain(FAKE_DSN);
    // Y el resumen sigue siendo una frase: el nombre de la variable va
    // parentizado justamente para que el redactor no se lleve la palabra
    // siguiente.
    expect(report.findings[0].summary).not.toContain("***");
  });

  it("un id de proveedor que el redactor reconoce no se lleva la palabra siguiente", async () => {
    // El defecto que atrapa, y que sobrevivió a la primera ronda de mutación
    // porque NINGÚN doble podía cazarlo: el id del único proveedor real es
    // literalmente `dsn`, así que toda cadena que lo escriba seguido de un espacio
    // llega al informe con la palabra siguiente reemplazada por `***`. Los dobles
    // se llamaban `doble`, `uno`, `dos` — ninguno casa el redactor —, así que acá
    // el doble se llama como el real.
    const auth = new FixtureAuth(flowOf({ interactive: false }), "dsn");
    const report = await runDoctor(makeCtx(), {}, depsFor(auth));
    const [finding] = report.findings;

    expect(finding.state).toBe("blocking");
    // La guía sigue siendo una frase completa: nombra al proveedor Y dice qué hacer.
    const guidance = finding.remediation.guidance.join(" | ");
    expect(guidance).toContain("dsn");
    expect(guidance).not.toContain("***");
    expect(guidance).toContain("corregirlo en el CLI");
  });

  it("la denuncia de una colisión también sobrevive a la redacción", async () => {
    const report = await runDoctor(
      makeCtx(),
      {},
      {
        providers: [
          createToolsAuthProvider({
            providers: [new FixtureAuth(null, "dsn"), new FixtureAuth(null, "token")],
          }),
        ],
      },
    );
    const collision = report.findings.find((finding) => finding.id.includes("colision"));

    expect(collision?.evidence.join(" | ")).not.toContain("***");
    expect(collision?.remediation.guidance.join(" | ")).not.toContain("***");
    // Y los dos nombres siguen ahí: son lo único accionable de esta denuncia.
    expect(collision?.evidence.join(" | ")).toContain("dsn");
    expect(collision?.evidence.join(" | ")).toContain("token");
  });

  it("las TRES proyecciones humanas nombran la variable y no reflejan el valor", async () => {
    // La proyección es su propia superficie: el JSON puede estar redactado y el
    // texto no, porque los arma código distinto. Y el informe, la vista previa y
    // el resultado del lote son tres proyecciones, no una.
    const render = doctorCommand.renderHuman;
    if (render === undefined) throw new Error("doctor perdió su proyección humana");
    const auth = new Leaky(flowOf());
    const deps = depsFor(auth);
    const report = await runDoctor(makeCtx(), {}, deps);
    const proposal = await seal(makeCtx(), deps);
    const applied = await applyDoctorBatch(
      makeCtx(),
      { approval: proposal.digest, select: [FINDING_ID] },
      deps,
    );
    if (!applied.ok) throw new Error("el lote no llegó a aplicarse");

    const texts = [
      render({ ok: true, data: report, exitCode: report.verdict.exit_code }, { detail: false }),
      render(
        { ok: true, data: { kind: "prepare-sealed", ...proposal }, exitCode: 0 },
        { detail: false },
      ),
      render(
        { ok: true, data: { kind: "applied", ...applied.result }, exitCode: 1 },
        { detail: false },
      ),
    ];

    for (const text of texts) {
      expect(text).not.toContain("CLAVE-INVENTADA-9f3a");
      expect(text).not.toContain(FAKE_DSN);
    }
    // El informe nombra la variable, y la frase sigue entera.
    expect(texts[0]).toContain(SUBJECT.label);
    // La vista previa muestra los tokens que se van a ejecutar.
    expect(texts[1]).toContain(ARGV.join(" "));
    // Y el resultado dice qué operación corrió y cómo quedó su recomprobación.
    expect(texts[2]).toContain("auth.flow");
    expect(texts[2]).toContain("recomprobación");
  });

  it("la vista previa y el resultado del lote tampoco lo reflejan", async () => {
    const auth = new Leaky(flowOf());
    const deps = depsFor(auth);
    const proposal = await seal(makeCtx(), deps);
    const outcome = await applyDoctorBatch(
      makeCtx(),
      { approval: proposal.digest, select: [FINDING_ID] },
      deps,
    );

    const preview = JSON.stringify(proposal);
    expect(preview).not.toContain("CLAVE-INVENTADA-9f3a");
    expect(JSON.stringify(outcome)).not.toContain("CLAVE-INVENTADA-9f3a");
  });
});
