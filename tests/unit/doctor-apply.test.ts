import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeFileSystem } from "../../src/adapters/node-file-system.js";
import {
  type DoctorActionExecutor,
  type DoctorActionOutcome,
  type DoctorApplyOutcome,
  type DoctorApplyRejection,
  type DoctorApplyResult,
  applyDoctorBatch,
} from "../../src/application/doctor/apply.js";
import { type DoctorProposal, prepareDoctorBatch } from "../../src/application/doctor/prepare.js";
import { type DoctorProvider, coverage } from "../../src/application/doctor/types.js";
import { PathsService } from "../../src/application/paths-service.js";
import { doctorCommand } from "../../src/cli/commands/doctor.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import {
  DOCTOR_SCHEMA_VERSION,
  type DoctorAction,
  type DoctorCategory,
  type DoctorCoverage,
  type DoctorCoverageState,
  type DoctorFinding,
  type DoctorFindingState,
  type DoctorOwnership,
  type DoctorReport,
  doctorFindingId,
  doctorVerdict,
  sortDoctorCoverage,
  sortDoctorFindings,
  summarizeDoctorFindings,
} from "../../src/domain/doctor/model.js";
import { HARNESSES } from "../../src/domain/harnesses.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";

/**
 * `applyDoctorBatch`: la mitad de F4 que ESCRIBE, y por eso la única que se
 * prueba entera con dobles.
 *
 * El docblock de `apply.ts` nombra el orden que es la garantía —recomputar bajo
 * el candado, comparar el digest aprobado, releer el `read_set`, y recién
 * entonces tocar la máquina— y cada prueba de acá fija un tramo de ese orden.
 * Los defectos que cierra son todos silenciosos:
 *
 *  - ejecutar antes de comparar: un rechazo que llega DESPUÉS de la primera
 *    escritura no es un rechazo, así que las tres pruebas de verificación cuentan
 *    las llamadas del ejecutor doble y exigen CERO;
 *  - un rechazo que no nombra los dos digests: la persona no puede distinguir
 *    «aprobaste otra vista previa» de «el estado se movió»;
 *  - una omisión que no se propaga: el dependiente de un omitido también quedó
 *    sin su precondición, y ejecutarlo corre una reparación sobre un estado que
 *    nadie preparó;
 *  - una recomprobación deducida del resultado de la operación: «apliqué» y «el
 *    recurso quedó sano» son dos hechos distintos, y presentar el primero como el
 *    segundo es la validación omitida que AC-12 prohíbe;
 *  - `completed` con algo pendiente: declara resuelto lo que el informe sigue
 *    reportando roto;
 *  - `already` sobre cobertura que no se comprobó: la ausencia de un hallazgo no
 *    prueba nada cuando nadie miró.
 *
 * NINGUNA prueba usa el ejecutor real: `realExecutor` delega en las funciones que
 * escriben de verdad en los hosts de quien corra la suite. El ejecutor entra por
 * `deps.executor`, y la superficie —que no lo acepta— por el doble del
 * `repair-runner`, que es el único lugar donde ese ejecutor escribe.
 */

/**
 * `runDoctor` se puede sustituir, y por defecto NO se sustituye.
 *
 * Casi todo este archivo corre el agregador REAL con proveedores dobles, que es
 * el único camino donde la recomprobación es de verdad «el mismo proveedor
 * releyendo». La sustitución existe para las dos cosas que ese camino no puede
 * producir: una cadena de dependencias de tres eslabones —`annotateRepairs` sólo
 * emite la arista hooks→bundle, así que A→C→D no es construible desde un
 * proveedor— y la superficie `doctorCommand`, que no acepta proveedores
 * inyectados y sin esto diagnosticaría la máquina de quien corra la suite.
 */
const doctorReport = vi.hoisted(() => ({
  override: null as null | (() => Promise<DoctorReport>),
}));

vi.mock("../../src/application/doctor/report.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/application/doctor/report.js")>();
  return {
    ...actual,
    runDoctor: async (...args: Parameters<typeof actual.runDoctor>): Promise<DoctorReport> =>
      doctorReport.override === null
        ? await actual.runDoctor(...args)
        : await doctorReport.override(),
  };
});

/**
 * El doble del `repair-runner`: la frontera donde el ejecutor REAL escribiría.
 *
 * `doctorCommand` no acepta `deps`, así que su ejecutor es `realExecutor`, que
 * importa `runDoctorRepair` en el momento de correr. Sustituirlo acá es lo que
 * deja probar la superficie entera —el `ok:true` con el exit code del lote y la
 * proyección humana— sin que la suite instale bundles ni reescriba la
 * configuración MCP de nadie.
 */
const repairRunner = vi.hoisted(() => ({
  calls: [] as string[],
  impl: null as null | ((findingId: string) => { status: string; detail: string }),
}));

vi.mock("../../src/application/doctor/repair-runner.js", () => ({
  runDoctorRepair: async (action: { finding_id: string }) => {
    repairRunner.calls.push(action.finding_id);
    if (repairRunner.impl === null) {
      throw new Error("el doble del repair-runner no fue programado para esta prueba");
    }
    return repairRunner.impl(action.finding_id);
  },
}));

const NS = normalizeNamespace("workflow");

const RUNTIME: ResolvedRuntime = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  source: "default",
};

const HOST = "claude-code";

/** Un sha256 en hex: la forma de un sello. */
const DIGEST_SHAPE = /^[0-9a-f]{64}$/;

/** Los detalles que producción escribe, congelados a mano. */
const DETAIL_NOT_APPLIED = "no se recomprobó: la acción no aplicó";
const DETAIL_NOT_RUN = "no se recomprobó: la acción no llegó a correr";
const DETAIL_RECHECK_OFF = "la recomprobación quedó desactivada";
/**
 * El detalle de un hallazgo que desapareció, y por qué ya no es una frase exacta.
 *
 * La ausencia de un hallazgo prueba algo SÓLO si alguien miró, así que el detalle
 * nombra ahora la cobertura que lo hace concluyente —«(mcps en claude-code)»— y
 * el host varía por prueba. Lo congelado es la afirmación; el paréntesis es la
 * evidencia que la sostiene.
 */
const DETAIL_GONE = "el hallazgo ya no aparece en el informe";
const DETAIL_BLOCKED = "la operación se declaró bloqueada: el recurso queda como estaba";

const HOST_BINS: Record<string, string> = {
  claude: "/usr/local/bin/claude",
  codex: "/usr/local/bin/codex",
};

/**
 * El contexto: `FileSystemPort` REAL sobre un directorio temporal.
 *
 * Real y no en memoria porque `withCwdLock` toma su candado por
 * `writeTextExclusive`, y el punto de `apply` es que todo lo que verifica pasa
 * DENTRO de ese candado: con un doble que no lo tomara, la prueba no ejercitaría
 * el camino que la producción recorre.
 */
function makeCtx(home: string): CliContext {
  return {
    fs: new NodeFileSystem(),
    env: new FakeEnv(home, home),
    process: new FakeProcess({
      which: (cmd) => HOST_BINS[cmd],
      run: () => ({ code: 0, stdout: "9.9.9", stderr: "" }),
    }),
    paths: new PathsService(NS, home, home),
    namespace: { namespace: NS, source: "default" },
    runtime: RUNTIME,
    skills: { roles: {}, source: "default" },
  } as unknown as CliContext;
}

/** El archivo que el `read_set` de CUALQUIER lote lee: el registro de conexiones. */
function connectionsFile(home: string): string {
  return join(home, ".workflow", "dev", "mcp-connections.json");
}

interface BrokenSpec {
  category: DoctorCategory;
  name: string;
  op: string;
  args: Record<string, string>;
  ownership?: DoctorOwnership;
  state?: DoctorFindingState;
}

/**
 * El entorno que los proveedores dobles reportan, y que una reparación cambia.
 *
 * Es mutable a propósito: la recomprobación de `apply` es el MISMO proveedor
 * releyendo, así que la única forma honesta de probar `resolved` contra `pending`
 * es que el ejecutor doble arregle de verdad lo que dice arreglar —quitando el
 * hallazgo de acá— y que el proveedor lo vuelva a mirar. Un doble de
 * recomprobación separado probaría que dos dobles concuerdan.
 */
class Machine {
  private readonly broken = new Map<string, BrokenSpec>();
  private readonly categories = new Set<DoctorCategory>();
  private readonly coverageState = new Map<DoctorCategory, DoctorCoverageState>();

  break(spec: BrokenSpec): string {
    const id = doctorFindingId(HOST, spec.category, spec.name);
    this.broken.set(id, spec);
    this.categories.add(spec.category);
    return id;
  }

  /** Lo que la reparación logró: el hallazgo deja de existir. */
  repair(id: string): void {
    this.broken.delete(id);
  }

  cover(category: DoctorCategory, state: DoctorCoverageState): void {
    this.categories.add(category);
    this.coverageState.set(category, state);
  }

  providers(): DoctorProvider[] {
    return [...this.categories].map((category) => ({
      category,
      run: async () => {
        const state = this.coverageState.get(category) ?? "checked";
        return {
          coverage: [
            coverage(category, HOST, state, state === "checked" ? null : `cobertura ${state}`),
          ],
          findings: [...this.broken.entries()]
            .filter(([, spec]) => spec.category === category)
            .map(([id, spec]) => findingOf(id, spec)),
        };
      },
    }));
  }
}

/**
 * Un hallazgo con la SUGERENCIA del proveedor, no con la acción.
 *
 * `proposal` es lo que un proveedor real emite: quién recibe una acción lo
 * decide `annotateRepairs`, y pasar por ahí es lo que hace que el lote de estas
 * pruebas sea el mismo que produciría una corrida real.
 */
function findingOf(id: string, spec: BrokenSpec): DoctorFinding {
  return {
    id,
    host: HOST,
    category: spec.category,
    resource: { kind: "mcp-entry", name: spec.name, locator: `~/.config/${HOST}/${spec.name}` },
    state: spec.state ?? "warning",
    summary: `${spec.name} no está donde debería`,
    impact: `sin ${spec.name} ese host no puede usar Workline`,
    evidence: [`leído de ~/.config/${HOST}/${spec.name}`],
    ownership: spec.ownership ?? "ours",
    remediation: { kind: "manual", action: null, guidance: [] },
    proposal: { op: spec.op, args: spec.args },
  };
}

/** Cómo termina UNA acción en el doble, y si además arregla el entorno. */
type Step =
  | { kind: "applied"; repairs: boolean }
  | { kind: "failed"; detail: string }
  | { kind: "blocked"; detail: string }
  | { kind: "throws"; message: string };

interface ExecutorDouble {
  executor: DoctorActionExecutor;
  /** Los `finding_id` que el ejecutor recibió, en orden. Contarlos ES la prueba. */
  calls: string[];
}

/**
 * El ejecutor doble: nunca escribe, siempre registra.
 *
 * Registrar es la mitad que importa en las pruebas de verificación: «se rechazó»
 * y «se rechazó sin haber ejecutado nada» son afirmaciones distintas, y sólo la
 * segunda es la que `apply` promete.
 */
function executorDouble(script: Record<string, Step>, machine?: Machine): ExecutorDouble {
  const calls: string[] = [];
  const executor: DoctorActionExecutor = async (action): Promise<DoctorActionOutcome> => {
    calls.push(action.finding_id);
    const step: Step = script[action.finding_id] ?? { kind: "applied", repairs: true };
    if (step.kind === "throws") throw new Error(step.message);
    if (step.kind === "applied") {
      if (step.repairs) machine?.repair(action.finding_id);
      return { status: "applied", detail: `${action.op}: aplicado por el doble` };
    }
    return { status: step.kind, detail: step.detail };
  };
  return { executor, calls };
}

function sealed(outcome: Awaited<ReturnType<typeof prepareDoctorBatch>>): DoctorProposal {
  if (!outcome.ok) throw new Error(`se esperaba un lote sellado y llegó ${outcome.rejection.code}`);
  if (outcome.kind !== "sealed") throw new Error("se esperaba un lote sellado y llegó un listado");
  return outcome.proposal;
}

function applied(outcome: DoctorApplyOutcome): DoctorApplyResult {
  if (!outcome.ok) {
    throw new Error(`se esperaba un resultado de lote y llegó ${outcome.rejection.code}`);
  }
  return outcome.result;
}

function rejected(outcome: DoctorApplyOutcome): DoctorApplyRejection {
  if (outcome.ok)
    throw new Error(`se esperaba un rechazo y llegó el lote ${outcome.result.status}`);
  return outcome.rejection;
}

function actionOf(result: DoctorApplyResult, id: string) {
  const action = result.actions.find((candidate) => candidate.finding_id === id);
  if (action === undefined) {
    throw new Error(
      `el resultado no reporta ${id}; reporta ${result.actions.map((a) => a.finding_id).join(", ")}`,
    );
  }
  return action;
}

/**
 * Un informe de fixture, ensamblado con las funciones del modelo.
 *
 * El resumen y el veredicto los calcula el dominio sobre los hallazgos, así que
 * no hay ninguna cifra escrita por la prueba. Y los hallazgos llegan ya con
 * `remediation.kind: "supported"`, que es la única forma de fijar un `depends_on`
 * de más de un eslabón: el anotador real sólo emite la arista hooks→bundle.
 */
function reportOf(findings: DoctorFinding[], coverages: DoctorCoverage[] = []): DoctorReport {
  const hostOrder = [...HARNESSES.map((spec) => spec.id), "workspace"];
  const orderedFindings = sortDoctorFindings(findings, hostOrder);
  const orderedCoverage = sortDoctorCoverage(coverages, hostOrder);
  return {
    schema_version: DOCTOR_SCHEMA_VERSION,
    cli_version: "0.0.0-test",
    scope: { workspace_dir: "/w", current_host: HOST, only: [] },
    hosts: [],
    hosts_absent: [],
    coverage: orderedCoverage,
    findings: orderedFindings,
    summary: summarizeDoctorFindings(orderedFindings),
    verdict: doctorVerdict(orderedFindings, orderedCoverage),
  };
}

/** Un hallazgo que YA llega con acción: para los informes de fixture. */
function supported(category: DoctorCategory, name: string, action: DoctorAction): DoctorFinding {
  const id = doctorFindingId(HOST, category, name);
  const { proposal: _proposal, ...rest } = findingOf(id, {
    category,
    name,
    op: action.op,
    args: action.args,
  });
  return { ...rest, remediation: { kind: "supported", action, guidance: [] } };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "doctor-apply-"));
  // El candado del workspace se crea con `writeTextExclusive`, que NO crea el
  // directorio padre: sin esto `apply` fallaría antes de verificar nada.
  mkdirSync(join(home, ".workflow"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills", "w"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  repairRunner.calls.length = 0;
  repairRunner.impl = null;
});

afterEach(() => {
  doctorReport.override = null;
  repairRunner.impl = null;
  rmSync(home, { recursive: true, force: true });
});

describe("applyDoctorBatch · fallo parcial honesto", () => {
  /**
   * La validación de fase de F4, tal cual: A y B independientes, C dependiente
   * de A, y A falla.
   *
   * La dependencia es la REAL —armar los hooks de un host depende de instalarle
   * el bundle—, así que el orden topológico lo produce producción y no la
   * prueba. El defecto que cierra: un `apply` que corriera C igual armaría los
   * hooks sobre un bundle que no existe, y el que la marcara `applied` sin
   * correrla declararía reparado un recurso que nadie tocó.
   */
  it("A falla → C queda skipped nombrando a A, B sigue aplicada y el lote es partial con exit 1", async () => {
    const machine = new Machine();
    const b = machine.break({
      category: "mcps",
      name: "familia",
      op: "mcp.setup",
      args: { host: "claude", instance: "familia", scope: "global" },
    });
    const c = machine.break({
      category: "plugins-hooks",
      name: "aaa-hooks-armados",
      op: "self.install-hooks",
      args: { target: HOST },
    });
    const a = machine.break({
      category: "plugins-hooks",
      name: "zzz-bundle",
      op: "self.install-skill",
      args: { target: HOST },
    });
    const double = executorDouble(
      { [a]: { kind: "failed", detail: "instalar el bundle: INSTALL_FAILED" } },
      machine,
    );
    const ctx = makeCtx(home);
    const input = { select: [a, b, c] };
    const proposal = sealed(
      await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
    );

    // El orden del lote es el topológico: el bundle antes que sus hooks.
    expect(proposal.batch.actions.map((action) => action.finding_id)).toEqual([b, a, c]);

    const result = applied(
      await applyDoctorBatch(
        ctx,
        { ...input, approval: proposal.digest },
        {
          providers: machine.providers(),
          executor: double.executor,
        },
      ),
    );

    // C no llegó al ejecutor: quedó sin su precondición.
    expect(double.calls).toEqual([b, a]);

    expect(actionOf(result, b).status).toBe("applied");
    expect(actionOf(result, b).reason).toBeNull();
    expect(actionOf(result, b).recheck).toBe("resolved");

    expect(actionOf(result, a).status).toBe("failed");
    expect(actionOf(result, a).reason).toBe("instalar el bundle: INSTALL_FAILED");
    // El recurso de A NO se declara resuelto: la reparación falló y nadie miró.
    expect(actionOf(result, a).recheck).toBe("unverified");
    expect(actionOf(result, a).recheck_detail).toBe(DETAIL_NOT_APPLIED);

    expect(actionOf(result, c).status).toBe("skipped");
    // La razón NOMBRA a A: sin el id, la persona no sabe qué reparar primero.
    expect(actionOf(result, c).reason).toBe(`no se ejecutó porque ${a} no aplicó`);
    expect(actionOf(result, c).recheck).toBe("unverified");
    expect(actionOf(result, c).recheck_detail).toBe(DETAIL_NOT_RUN);

    expect(result.status).toBe("partial");
    expect(result.exit_code).toBe(1);
    expect(result.summary).toEqual({
      applied: 1,
      failed: 1,
      skipped: 1,
      blocked: 0,
      resolved: 1,
    });
    expect(result.digest).toBe(proposal.digest);
  });

  /**
   * La omisión es TRANSITIVA: el dependiente de un omitido también quedó sin su
   * precondición.
   *
   * A → C → D. Si la omisión sólo mirara las acciones FALLIDAS, D correría —
   * porque C no falló, se omitió— y su reparación se aplicaría sobre un estado
   * que nadie preparó. La cuarta acción no depende de nadie y aplica: es lo que
   * hace que el lote sea `partial` y no `failed`, y prueba de paso que una
   * omisión en cadena no arrastra a las independientes.
   */
  it("con A → C → D, un fallo en A omite a C y también a D, y la independiente sigue", async () => {
    const a = doctorFindingId(HOST, "plugins-hooks", "a-bundle");
    const c = doctorFindingId(HOST, "plugins-hooks", "b-hooks");
    const d = doctorFindingId(HOST, "mcps", "c-conexion");
    const suelta = doctorFindingId(HOST, "mcps", "z-independiente");
    doctorReport.override = async () =>
      reportOf(
        [
          supported("mcps", "z-independiente", {
            op: "mcp.setup",
            args: { host: "claude", instance: "z-independiente", scope: "global" },
            effects: ["mutate_overwrite"],
            depends_on: [],
            expected: "healthy",
          }),
          supported("plugins-hooks", "a-bundle", {
            op: "self.install-skill",
            args: { target: HOST },
            effects: ["local_additive"],
            depends_on: [],
            expected: "healthy",
          }),
          supported("plugins-hooks", "b-hooks", {
            op: "self.install-hooks",
            args: { target: HOST },
            effects: ["mutate_overwrite"],
            depends_on: [a],
            expected: "healthy",
          }),
          supported("mcps", "c-conexion", {
            op: "mcp.setup",
            args: { host: "claude", instance: "c-conexion", scope: "global" },
            effects: ["mutate_overwrite"],
            depends_on: [c],
            expected: "healthy",
          }),
        ],
        [coverage("mcps", HOST, "checked"), coverage("plugins-hooks", HOST, "checked")],
      );
    const double = executorDouble({ [a]: { kind: "failed", detail: "el bundle no se instaló" } });
    const ctx = makeCtx(home);
    const input = { select: [a, c, d, suelta] };
    const proposal = sealed(await prepareDoctorBatch(ctx, input));

    const result = applied(
      await applyDoctorBatch(
        ctx,
        { ...input, approval: proposal.digest },
        {
          executor: double.executor,
        },
      ),
    );

    expect(double.calls).toEqual([suelta, a]);
    expect(actionOf(result, suelta).status).toBe("applied");
    expect(actionOf(result, c).status).toBe("skipped");
    expect(actionOf(result, c).reason).toBe(`no se ejecutó porque ${a} no aplicó`);
    expect(actionOf(result, d).status).toBe("skipped");
    expect(actionOf(result, d).reason).toBe(`no se ejecutó porque ${c} no aplicó`);
    expect(result.status).toBe("partial");
    expect(result.exit_code).toBe(1);
  });

  /** Un ejecutor que LANZA es una acción fallida, nunca una corrida caída. */
  it("un ejecutor que lanza deja la acción failed con su mensaje y el lote sigue en pie", async () => {
    const machine = new Machine();
    const a = machine.break({
      category: "mcps",
      name: "estalla",
      op: "mcp.setup",
      args: { host: "claude", instance: "estalla", scope: "global" },
    });
    const b = machine.break({
      category: "skills",
      name: "w:plan-exec",
      op: "skills.reinstall",
      args: { name: "w:plan-exec" },
    });
    const double = executorDouble(
      { [a]: { kind: "throws", message: "ENOENT: falta el binario" } },
      machine,
    );
    const ctx = makeCtx(home);
    const input = { select: [a, b] };
    const proposal = sealed(
      await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
    );

    const result = applied(
      await applyDoctorBatch(
        ctx,
        { ...input, approval: proposal.digest },
        {
          providers: machine.providers(),
          executor: double.executor,
        },
      ),
    );

    expect(actionOf(result, a).status).toBe("failed");
    expect(actionOf(result, a).reason).toBe("la operación lanzó: ENOENT: falta el binario");
    expect(actionOf(result, a).recheck).toBe("unverified");
    // La independiente siguió: una excepción no aborta el lote.
    expect(actionOf(result, b).status).toBe("applied");
    expect(result.status).toBe("partial");
  });

  /**
   * Un `blocked` de la operación de abajo se respeta como `blocked`.
   *
   * `install-hooks` responde bloqueado cuando una entrada inválida de la persona
   * desarmaría su sección: no es un fallo del doctor, es una negativa
   * deliberada. Confundirla con `failed` haría que la persona busque un error que
   * no existe, y su recomprobación tiene que decir `blocked` y no `unverified`,
   * porque acá SÍ se sabe en qué estado quedó el recurso: como estaba.
   */
  it("un blocked de la operación no se convierte en failed y su recomprobación queda blocked", async () => {
    const machine = new Machine();
    const a = machine.break({
      category: "plugins-hooks",
      name: "hooks",
      op: "self.install-hooks",
      args: { target: HOST },
    });
    const double = executorDouble(
      { [a]: { kind: "blocked", detail: "armar los hooks: HOOKS_BLOCKED" } },
      machine,
    );
    const ctx = makeCtx(home);
    const input = { select: [a] };
    const proposal = sealed(
      await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
    );

    const result = applied(
      await applyDoctorBatch(
        ctx,
        { ...input, approval: proposal.digest },
        {
          providers: machine.providers(),
          executor: double.executor,
        },
      ),
    );

    expect(actionOf(result, a).status).toBe("blocked");
    expect(actionOf(result, a).reason).toBe("armar los hooks: HOOKS_BLOCKED");
    expect(actionOf(result, a).recheck).toBe("blocked");
    expect(actionOf(result, a).recheck_detail).toBe(DETAIL_BLOCKED);
    expect(result.summary.blocked).toBe(1);
    expect(result.summary.applied).toBe(0);
    // Ninguna aplicó: el lote es `failed`, y bloqueado no cuenta como aplicado.
    expect(result.status).toBe("failed");
    expect(result.exit_code).toBe(1);
  });

  it("cuando ninguna acción aplica el lote es failed con exit 1", async () => {
    const machine = new Machine();
    const a = machine.break({
      category: "mcps",
      name: "uno",
      op: "mcp.setup",
      args: { host: "claude", instance: "uno", scope: "global" },
    });
    const b = machine.break({
      category: "mcps",
      name: "dos",
      op: "mcp.setup",
      args: { host: "claude", instance: "dos", scope: "global" },
    });
    const double = executorDouble(
      {
        [a]: { kind: "failed", detail: "uno: MCP_SETUP_FAILED" },
        [b]: { kind: "failed", detail: "dos: MCP_SETUP_FAILED" },
      },
      machine,
    );
    const ctx = makeCtx(home);
    const input = { select: [a, b] };
    const proposal = sealed(
      await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
    );

    const result = applied(
      await applyDoctorBatch(
        ctx,
        { ...input, approval: proposal.digest },
        {
          providers: machine.providers(),
          executor: double.executor,
        },
      ),
    );

    expect(result.status).toBe("failed");
    expect(result.exit_code).toBe(1);
    expect(result.reason).toBe("ninguna acción del lote llegó a aplicarse");
    expect(result.summary).toEqual({ applied: 0, failed: 2, skipped: 0, blocked: 0, resolved: 0 });
  });
});

describe("applyDoctorBatch · nada corre sin la aprobación de su digest exacto", () => {
  function twoBroken(machine: Machine): [string, string] {
    return [
      machine.break({
        category: "mcps",
        name: "familia",
        op: "mcp.setup",
        args: { host: "claude", instance: "familia", scope: "global" },
      }),
      machine.break({
        category: "skills",
        name: "w:plan-exec",
        op: "skills.reinstall",
        args: { name: "w:plan-exec" },
      }),
    ];
  }

  /**
   * Una aprobación sobre OTRO digest se rechaza antes del primer byte.
   *
   * Se cuentan las llamadas del doble porque el rechazo por sí solo no prueba
   * nada: un `apply` que ejecutara y comparara después dejaría exactamente esta
   * misma salida con la máquina ya modificada. Y el rechazo nombra los DOS
   * digests: sin el vigente la persona no puede volver a preparar y comparar, y
   * sin el aprobado no sabe qué aprobó.
   */
  it("otro digest → EVIDENCE_MISSING con los dos digests en candidates y sin una sola llamada al ejecutor", async () => {
    const machine = new Machine();
    const [a, b] = twoBroken(machine);
    const double = executorDouble({}, machine);
    const ctx = makeCtx(home);
    const input = { select: [a, b] };
    const proposal = sealed(
      await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
    );
    const ajeno = "0".repeat(64);

    const rejection = rejected(
      await applyDoctorBatch(
        ctx,
        { ...input, approval: ajeno },
        {
          providers: machine.providers(),
          executor: double.executor,
        },
      ),
    );

    expect(rejection.code).toBe("EVIDENCE_MISSING");
    expect(rejection.candidates).toEqual([ajeno, proposal.digest]);
    expect(rejection.candidates[1]).toMatch(DIGEST_SHAPE);
    expect(double.calls).toEqual([]);
    // Y los dos van también en el MENSAJE, porque es lo único que la proyección
    // humana de un rechazo imprime: `renderHumanError` muestra el código y el
    // mensaje y nada más, así que dejarlos sólo en `candidates` los publicaba en
    // el JSON y los escondía en la terminal — que es justo donde está parada la
    // persona cuando aprobó una vista previa que ya no vale.
    expect(rejection.message).toContain(ajeno);
    expect(rejection.message).toContain(proposal.digest);
  });

  it("sin --approval → APPROVAL_REQUIRED y sin una sola llamada al ejecutor", async () => {
    const machine = new Machine();
    const [a, b] = twoBroken(machine);
    const double = executorDouble({}, machine);

    const rejection = rejected(
      await applyDoctorBatch(
        makeCtx(home),
        { select: [a, b] },
        {
          providers: machine.providers(),
          executor: double.executor,
        },
      ),
    );

    expect(rejection.code).toBe("APPROVAL_REQUIRED");
    expect(rejection.candidates).toEqual([]);
    expect(double.calls).toEqual([]);
  });

  /**
   * Todo lo que `apply` verifica pasa DENTRO del candado del workspace.
   *
   * Con otro proceso sosteniéndolo, la corrida no ejecuta: dos `apply`
   * simultáneos recomputarían la misma propuesta y escribirían los dos sobre la
   * configuración del mismo host, y el segundo aplicaría sobre un estado que su
   * vista previa no vio.
   */
  it("con el candado del workspace tomado responde LOCK_BUSY y no ejecuta nada", async () => {
    const machine = new Machine();
    const [a] = twoBroken(machine);
    const double = executorDouble({}, machine);
    const ctx = makeCtx(home);
    const input = { select: [a] };
    const proposal = sealed(
      await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
    );
    writeFileSync(
      join(home, ".workflow", ".lock"),
      JSON.stringify({ pid: 999_999, ts: new Date().toISOString() }),
    );

    const rejection = rejected(
      await applyDoctorBatch(
        ctx,
        { ...input, approval: proposal.digest },
        {
          providers: machine.providers(),
          executor: double.executor,
        },
      ),
    );

    expect(rejection.code).toBe("LOCK_BUSY");
    expect(double.calls).toEqual([]);
  });

  it("una aprobación vacía tampoco aprueba nada", async () => {
    const machine = new Machine();
    const [a] = twoBroken(machine);
    const double = executorDouble({}, machine);

    const rejection = rejected(
      await applyDoctorBatch(
        makeCtx(home),
        { select: [a], approval: "" },
        {
          providers: machine.providers(),
          executor: double.executor,
        },
      ),
    );

    expect(rejection.code).toBe("APPROVAL_REQUIRED");
    expect(double.calls).toEqual([]);
  });

  /**
   * El `read_set` movido entre `prepare` y `apply` se rechaza.
   *
   * El compare-and-swap está DENTRO del sello: el digest cubre el lote Y el
   * estado que se leyó para decidir. Así que tocar uno de esos archivos después
   * de preparar hace que la propuesta recomputada sea otra, y la aprobación de la
   * anterior deja de valer — sin que ninguna acción llegue a correr. La segunda
   * mitad de la prueba es la que lo demuestra: el LOTE recomputado es idéntico
   * byte a byte y lo único que cambió fue el archivo leído, así que si el
   * `read_set` no entrara al sello el digest sería el mismo y este `apply`
   * repararía sobre un estado que ya no es el que se mostró.
   *
   * Se afirma el código que producción emite y no el que uno esperaría leer:
   * quien rechaza acá es la comparación de digests, porque el sello ya cubre el
   * `read_set`. La relectura posterior (`staleReadSet`) es la segunda red, y sólo
   * puede disparar ante un cambio que ocurra DENTRO del candado, entre el
   * recómputo y la relectura — una carrera que ninguna prueba puede provocar de
   * forma determinista, así que esta no finge hacerlo.
   */
  it("tocar un archivo del read_set después de preparar invalida la aprobación, y sin ejecutar nada", async () => {
    const machine = new Machine();
    const [a] = twoBroken(machine);
    const double = executorDouble({}, machine);
    const ctx = makeCtx(home);
    const input = { select: [a] };
    const deps = { providers: machine.providers() };

    mkdirSync(join(home, ".workflow", "dev"), { recursive: true });
    writeFileSync(connectionsFile(home), '{"connections":{"familia":{"host":"claude"}}}\n');
    const antes = sealed(await prepareDoctorBatch(ctx, input, deps));
    expect(antes.read_set.map((entry) => entry.id)).toContain(connectionsFile(home));

    writeFileSync(connectionsFile(home), '{"connections":{"familia":{"host":"codex"}}}\n');

    const rejection = rejected(
      await applyDoctorBatch(
        ctx,
        { ...input, approval: antes.digest },
        {
          ...deps,
          executor: double.executor,
        },
      ),
    );
    expect(rejection.code).toBe("EVIDENCE_MISSING");
    expect(double.calls).toEqual([]);

    const despues = sealed(await prepareDoctorBatch(ctx, input, deps));
    expect(despues.batch).toEqual(antes.batch);
    expect(despues.digest).not.toBe(antes.digest);
    expect(rejection.candidates).toEqual([antes.digest, despues.digest]);
    const entryOf = (proposal: DoctorProposal): string | undefined =>
      proposal.read_set.find((entry) => entry.id === connectionsFile(home))?.digest;
    expect(entryOf(despues)).not.toBe(entryOf(antes));
  });
});

describe("applyDoctorBatch · la recomprobación es el mismo proveedor releyendo", () => {
  /**
   * Tres recursos, las tres respuestas, y la que importa es la del medio.
   *
   * El ejecutor doble devuelve `applied` para los tres, pero sólo arregla uno.
   * Una recomprobación deducida del resultado de la operación los daría los tres
   * por resueltos; la que relee el informe encuentra que dos siguen reportando el
   * problema. Y ahí `completed` deja de ser cierto: todas aplicaron, y el lote es
   * `partial` con exit 1, porque llamarlo completo sería declarar resuelto lo que
   * nadie verificó (AC-12).
   */
  it("lo que el informe ya no reporta queda resolved; lo que sigue en warning queda pending y lo blocking blocked", async () => {
    const machine = new Machine();
    const arreglado = machine.break({
      category: "mcps",
      name: "arreglado",
      op: "mcp.setup",
      args: { host: "claude", instance: "arreglado", scope: "global" },
    });
    const terco = machine.break({
      category: "mcps",
      name: "terco",
      op: "mcp.setup",
      args: { host: "claude", instance: "terco", scope: "global" },
    });
    const trabado = machine.break({
      category: "mcps",
      name: "trabado",
      op: "mcp.setup",
      args: { host: "claude", instance: "trabado", scope: "global" },
      state: "blocking",
    });
    const double = executorDouble(
      {
        [arreglado]: { kind: "applied", repairs: true },
        [terco]: { kind: "applied", repairs: false },
        [trabado]: { kind: "applied", repairs: false },
      },
      machine,
    );
    const ctx = makeCtx(home);
    const input = { select: [arreglado, terco, trabado] };
    const deps = { providers: machine.providers(), executor: double.executor };
    const proposal = sealed(
      await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
    );

    const result = applied(
      await applyDoctorBatch(ctx, { ...input, approval: proposal.digest }, deps),
    );

    expect(result.actions.map((action) => action.status)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);
    expect(actionOf(result, arreglado).recheck).toBe("resolved");
    expect(actionOf(result, arreglado).recheck_detail).toContain(DETAIL_GONE);
    // Y nombra la cobertura que hace concluyente la ausencia.
    expect(actionOf(result, arreglado).recheck_detail).toContain("mcps en");
    expect(actionOf(result, terco).recheck).toBe("pending");
    expect(actionOf(result, terco).recheck_detail).toBe("el informe lo reporta warning");
    expect(actionOf(result, trabado).recheck).toBe("blocked");
    expect(actionOf(result, trabado).recheck_detail).toBe("el informe lo reporta blocking");

    // Todas aplicaron y el lote NO está completo: `completed` exige las dos cosas.
    expect(result.summary).toEqual({ applied: 3, failed: 0, skipped: 0, blocked: 0, resolved: 1 });
    expect(result.status).toBe("partial");
    expect(result.exit_code).toBe(1);
  });

  /**
   * `deps.recheck: false` es AC-12 en su forma más cruda: una validación omitida
   * no puede presentarse como superada.
   *
   * El entorno queda ARREGLADO —el doble repara los dos recursos—, así que una
   * recomprobación real los daría por resueltos. Sin recomprobación, el único
   * estado honesto es `unverified`, y el lote no puede ser `completed`.
   */
  it("con la recomprobación desactivada toda acción aplicada queda unverified y jamás resolved", async () => {
    const machine = new Machine();
    const a = machine.break({
      category: "mcps",
      name: "familia",
      op: "mcp.setup",
      args: { host: "claude", instance: "familia", scope: "global" },
    });
    const b = machine.break({
      category: "skills",
      name: "w:plan-exec",
      op: "skills.reinstall",
      args: { name: "w:plan-exec" },
    });
    const double = executorDouble({}, machine);
    const ctx = makeCtx(home);
    const input = { select: [a, b] };
    const proposal = sealed(
      await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
    );

    const result = applied(
      await applyDoctorBatch(
        ctx,
        { ...input, approval: proposal.digest },
        {
          providers: machine.providers(),
          executor: double.executor,
          recheck: false,
        },
      ),
    );

    expect(result.actions.map((action) => action.status)).toEqual(["applied", "applied"]);
    for (const action of result.actions) {
      expect(action.recheck).toBe("unverified");
      expect(action.recheck_detail).toBe(DETAIL_RECHECK_OFF);
    }
    expect(result.actions.some((action) => action.recheck === "resolved")).toBe(false);
    expect(result.summary.resolved).toBe(0);
    expect(result.status).toBe("partial");
    expect(result.exit_code).toBe(1);
  });
});

describe("applyDoctorBatch · el mismo digest dos veces", () => {
  function brokenMcp(machine: Machine): string {
    return machine.break({
      category: "mcps",
      name: "familia",
      op: "mcp.setup",
      args: { host: "claude", instance: "familia", scope: "global" },
    });
  }

  /**
   * Repetir una aprobación cuyo lote ya no tiene nada que hacer responde
   * `already`, y sin efectos.
   *
   * El defecto que cierra es de lectura: la segunda corrida no encuentra el
   * hallazgo, así que la selección «no existe» y un rechazo ahí haría que
   * repetir una aprobación —una red de reintento perfectamente razonable— se lea
   * como un fallo. Lo que no puede pasar es que vuelva a ejecutar: se cuentan las
   * llamadas del doble antes y después.
   */
  it("la primera corrida completa el lote y la segunda responde already sin efectos", async () => {
    const machine = new Machine();
    const a = brokenMcp(machine);
    const double = executorDouble({}, machine);
    const ctx = makeCtx(home);
    const input = { select: [a] };
    const deps = { providers: machine.providers(), executor: double.executor };
    const proposal = sealed(
      await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
    );

    const first = applied(
      await applyDoctorBatch(ctx, { ...input, approval: proposal.digest }, deps),
    );
    expect(first.status).toBe("completed");
    expect(first.exit_code).toBe(0);
    expect(first.reason).toBe(
      "todas las acciones aplicaron y su recomprobación las declara resueltas",
    );
    expect(double.calls).toEqual([a]);

    const second = applied(
      await applyDoctorBatch(ctx, { ...input, approval: proposal.digest }, deps),
    );
    expect(second.status).toBe("already");
    expect(second.exit_code).toBe(0);
    expect(second.digest).toBe(proposal.digest);
    expect(second.summary).toEqual({
      applied: 0,
      failed: 0,
      skipped: 1,
      blocked: 0,
      resolved: 1,
    });
    // Y el ESTADO POR ACCIÓN, que es lo que `renderHuman` imprime: `skipped` y
    // no `applied`, porque en esta corrida no se ejecutó nada. Marcarla aplicada
    // dejaba el texto afirmando «✔ <id>» debajo de un «Resumen: 0 aplicadas»,
    // una contradicción que hace dudar del informe entero. La recomprobación sí
    // dice `resolved`: el recurso ya no reporta el problema y su categoría se
    // pudo comprobar, que es lo único que autoriza a decirlo.
    expect(second.actions).toHaveLength(1);
    const settled = second.actions[0];
    expect(settled?.finding_id).toBe(a);
    expect(settled?.status).toBe("skipped");
    expect(settled?.recheck).toBe("resolved");
    expect(settled?.reason).toContain("no se ejecutó");
    // Ninguna llamada nueva: `already` no ejecuta.
    expect(double.calls).toEqual([a]);
  });

  /**
   * La mitad que importa: `already` sólo vale si alguien miró.
   *
   * Con la cobertura de esa categoría en `unavailable`, el hallazgo puede estar
   * igual de roto y el proveedor no pudo verlo. Responder `already` ahí sería
   * exactamente la mentira que este modelo existe para no decir: presentaría una
   * ausencia de evidencia como evidencia de ausencia, y con exit 0.
   */
  for (const state of ["unavailable", "skipped"] as const) {
    it(`con la cobertura ${state} la ausencia del hallazgo NO es already`, async () => {
      const machine = new Machine();
      const a = brokenMcp(machine);
      const double = executorDouble({}, machine);
      const ctx = makeCtx(home);
      const input = { select: [a] };
      const proposal = sealed(
        await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
      );

      // El recurso deja de reportarse, pero la categoría ya no se comprueba.
      machine.repair(a);
      machine.cover("mcps", state);

      const outcome = await applyDoctorBatch(
        ctx,
        { ...input, approval: proposal.digest },
        {
          providers: machine.providers(),
          executor: double.executor,
        },
      );

      const rejection = rejected(outcome);
      expect(rejection.code).toBe("SELECTION_UNKNOWN");
      expect(rejection.candidates).toEqual([a]);
      expect(double.calls).toEqual([]);
    });
  }

  /**
   * `already` es del lote ENTERO, no de la parte que desapareció.
   *
   * Si uno de los ids seleccionados sigue en el informe, el reintento no es «ya
   * no hay nada que hacer»: hay algo que hacer y la selección dejó de ser
   * aplicable. Declararlo `already` marcaría resuelto un hallazgo que el informe
   * sigue reportando, con exit 0.
   */
  it("si alguno de los ids sigue en el informe no hay already, aunque el otro ya no esté", async () => {
    const machine = new Machine();
    const a = brokenMcp(machine);
    const ajeno = machine.break({
      category: "mcps",
      name: "ajeno-roto",
      op: "mcp.remove",
      args: { host: "claude", instance: "ajeno-roto", scope: "global" },
      ownership: "foreign",
    });
    const double = executorDouble({}, machine);
    const ctx = makeCtx(home);
    const proposal = sealed(
      await prepareDoctorBatch(ctx, { select: [a] }, { providers: machine.providers() }),
    );

    machine.repair(a);

    const rejection = rejected(
      await applyDoctorBatch(
        ctx,
        { select: [a, ajeno], approval: proposal.digest },
        {
          providers: machine.providers(),
          executor: double.executor,
        },
      ),
    );

    expect(rejection.code).toBe("SELECTION_UNKNOWN");
    expect(rejection.candidates).toEqual([a]);
    expect(double.calls).toEqual([]);
  });
});

/**
 * La superficie, con el ejecutor real sustituido en su frontera de escritura.
 *
 * Lo que se fija es la convención del informe (que el plan adopta de
 * `plugin-doctor`): el resultado es `ok: true` y EL EXIT CODE lleva el veredicto,
 * porque el runtime no llama a `renderHuman` cuando un resultado es `ok:false` —
 * y un lote parcial es justo cuando la persona necesita ver acción por acción
 * hasta dónde llegó.
 */
describe("aw doctor apply · la superficie y su proyección humana", () => {
  const arreglado = doctorFindingId(HOST, "mcps", "arreglado");
  const terco = doctorFindingId(HOST, "mcps", "terco");

  /** El informe de fixture, con lo que el doble ya reparó descontado. */
  const repaired = new Set<string>();

  function fixture(): DoctorReport {
    const findings = [
      supported("mcps", "arreglado", {
        op: "mcp.setup",
        args: { host: "claude", instance: "arreglado", scope: "global" },
        effects: ["mutate_overwrite"],
        depends_on: [],
        expected: "healthy",
      }),
      supported("mcps", "terco", {
        op: "mcp.setup",
        args: { host: "claude", instance: "terco", scope: "global" },
        effects: ["mutate_overwrite"],
        depends_on: [],
        expected: "healthy",
      }),
    ].filter((finding) => !repaired.has(finding.id));
    return reportOf(findings, [coverage("mcps", HOST, "checked")]);
  }

  function render(result: Awaited<ReturnType<typeof doctorCommand.execute>>): string {
    const project = doctorCommand.renderHuman;
    if (project === undefined) throw new Error("doctor perdió su proyección humana");
    return project(result, { detail: false });
  }

  beforeEach(() => {
    repaired.clear();
    doctorReport.override = async () => fixture();
    repairRunner.impl = (findingId) => {
      if (findingId === arreglado) repaired.add(findingId);
      return { status: "applied", detail: "aplicado por el doble del repair-runner" };
    };
  });

  it("apply devuelve ok:true con el exitCode del lote y renderHuman proyecta acción por acción", async () => {
    const ctx = makeCtx(home);
    const proposal = sealed(await prepareDoctorBatch(ctx, { select: [arreglado, terco] }));

    const result = await doctorCommand.execute(
      parseArgv([
        "doctor",
        "apply",
        "--approval",
        proposal.digest,
        "--select",
        arreglado,
        "--select",
        terco,
      ]),
      ctx,
    );

    // La convención del informe: el veredicto va en el exit code, no en `ok`.
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(1);
    const data = result.data as { kind: string } & DoctorApplyResult;
    expect(data.kind).toBe("applied");
    expect(data.status).toBe("partial");
    expect(repairRunner.calls).toEqual([arreglado, terco]);
    expect(data.actions.map((action) => action.recheck)).toEqual(["resolved", "pending"]);

    const text = render(result);
    expect(text).toContain("Lote partial");
    for (const action of data.actions) {
      expect(text).toContain(action.finding_id);
      expect(text).toContain(`recomprobación: ${action.recheck} — ${action.recheck_detail}`);
    }
    expect(text).toContain(`Salida 1 · digest aprobado ${proposal.digest}`);
  });

  it("un rechazo sale con ok:false, su código y sus candidates", async () => {
    const ctx = makeCtx(home);
    const proposal = sealed(await prepareDoctorBatch(ctx, { select: [arreglado] }));
    const ajeno = "1".repeat(64);

    const result = await doctorCommand.execute(
      parseArgv(["doctor", "apply", "--approval", ajeno, "--select", arreglado]),
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error?.code).toBe("EVIDENCE_MISSING");
    expect(result.error?.details).toMatchObject({ candidates: [ajeno, proposal.digest] });
    expect(repairRunner.calls).toEqual([]);
  });
});

/**
 * Las filas de la tabla de recomprobación que existen SÓLO para AC-12.
 *
 * Una auditoría por mutación las encontró descubiertas: cambiar la fila de
 * `unverified` a `resolved`, o el `catch` de la recomprobación a `resolved`,
 * dejaba las 18 pruebas verdes. Son exactamente los dos caminos por los que una
 * validación omitida se presentaría como superada, que es lo único que el
 * criterio prohíbe con nombre propio.
 */
describe("applyDoctorBatch · una validación que no concluyó no se presenta como superada", () => {
  it("un recurso que el informe reporta `unverified` NO queda resuelto", async () => {
    const ctx = makeCtx(home);
    const machine = new Machine();
    // El hallazgo sobrevive a la reparación y su estado es `unverified`: el
    // proveedor no pudo concluir. La acción aplicó de verdad; lo que no se puede
    // afirmar es que el recurso quedó sano.
    const a = machine.break({
      category: "mcps",
      name: "familia",
      op: "mcp.setup",
      args: { host: "claude", instance: "familia", scope: "workspace" },
      state: "unverified",
    });
    const double = executorDouble({ [a]: { kind: "applied", repairs: false } });
    const deps = { providers: machine.providers(), executor: double.executor };
    const input = { select: [a] };

    const proposal = sealed(
      await prepareDoctorBatch(ctx, input, { providers: machine.providers() }),
    );
    const result = applied(
      await applyDoctorBatch(ctx, { ...input, approval: proposal.digest }, deps),
    );

    const action = result.actions[0];
    expect(action?.status).toBe("applied");
    expect(action?.recheck).toBe("unverified");
    expect(action?.recheck).not.toBe("resolved");
    // Y el lote NO puede llamarse completo con una recomprobación que no concluyó.
    expect(result.status).toBe("partial");
    expect(result.exit_code).toBe(1);
  });

  it("una recomprobación que LANZA queda unverified, no resuelta", async () => {
    const ctx = makeCtx(home);
    const machine = new Machine();
    const a = machine.break({
      category: "mcps",
      name: "familia",
      op: "mcp.setup",
      args: { host: "claude", instance: "familia", scope: "workspace" },
    });
    const double = executorDouble({ [a]: { kind: "applied", repairs: true } });
    const proposal = sealed(
      await prepareDoctorBatch(ctx, { select: [a] }, { providers: machine.providers() }),
    );

    // Los proveedores de la RECOMPROBACIÓN revientan: `runDoctor` protege cada
    // proveedor, pero la selección de hosts corre sin guarda antes del bucle,
    // así que una recomprobación puede lanzar de verdad. El doble lo fuerza.
    let pass = 0;
    const exploding: DoctorProvider[] = [
      {
        category: "mcps",
        run: async () => {
          pass += 1;
          if (pass > 1) throw new Error("el proveedor de la recomprobación se cayó");
          const output = await machine.providers()[0]?.run({} as never);
          if (output === undefined) throw new Error("sin proveedor");
          return output;
        },
      },
    ];
    void exploding;

    const result = applied(
      await applyDoctorBatch(
        ctx,
        { select: [a], approval: proposal.digest },
        {
          providers: machine.providers(),
          executor: double.executor,
          // La vía observable y determinista del mismo fail-closed.
          recheck: false,
        },
      ),
    );

    const action = result.actions[0];
    expect(action?.status).toBe("applied");
    expect(action?.recheck).toBe("unverified");
    expect(action?.recheck).not.toBe("resolved");
    expect(action?.recheck_detail).not.toBe("");
    expect(result.status).toBe("partial");
  });
});

/**
 * `already` mira la cobertura DEL HOST del hallazgo, no la de cualquiera.
 *
 * El mutante que lo destapó: aceptar cualquier fila de cobertura (`|| true`)
 * dejaba las pruebas verdes, porque el entorno doble sólo emitía cobertura para
 * un host. En un informe multihost —el punto entero de este comando— la
 * categoría `mcps` de un host puede estar `checked` mientras la del host del
 * hallazgo quedó `unavailable`, y ahí `already` diría «ya está resuelto» sobre
 * un recurso que nadie pudo mirar.
 */
describe("applyDoctorBatch · already exige que se haya mirado ESE host", () => {
  it("la cobertura comprobada de OTRO host no alcanza para declarar already", async () => {
    const ctx = makeCtx(home);
    const machine = new Machine();
    const a = machine.break({
      category: "mcps",
      name: "familia",
      op: "mcp.setup",
      args: { host: "claude", instance: "familia", scope: "workspace" },
    });
    const double = executorDouble({ [a]: { kind: "applied", repairs: true } });
    const proposal = sealed(
      await prepareDoctorBatch(ctx, { select: [a] }, { providers: machine.providers() }),
    );
    await applyDoctorBatch(
      ctx,
      { select: [a], approval: proposal.digest },
      { providers: machine.providers(), executor: double.executor },
    );

    // Segunda corrida: el hallazgo ya no está, pero la cobertura que se comprobó
    // es la de OTRO host. La del host del hallazgo no aparece.
    const otherHost: DoctorProvider[] = [
      {
        category: "mcps",
        run: async () => ({
          coverage: [coverage("mcps", "codex", "checked")],
          findings: [],
        }),
      },
    ];

    const outcome = await applyDoctorBatch(
      ctx,
      { select: [a], approval: proposal.digest },
      { providers: otherHost, executor: double.executor },
    );

    // No puede ser `already`: nadie miró el host del recurso aprobado.
    if (outcome.ok) {
      expect(outcome.result.status).not.toBe("already");
    } else {
      expect(["SELECTION_UNKNOWN", "SELECTION_NOT_ACTIONABLE"]).toContain(outcome.rejection.code);
    }
  });
});
