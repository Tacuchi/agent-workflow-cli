import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DoctorPrepareListing,
  type DoctorPrepareOutcome,
  type DoctorPrepareRejection,
  type DoctorProposal,
  prepareDoctorBatch,
} from "../../src/application/doctor/prepare.js";
import type { DoctorProvider } from "../../src/application/doctor/types.js";
import { coverage } from "../../src/application/doctor/types.js";
import { PathsService } from "../../src/application/paths-service.js";
import { doctorCommand } from "../../src/cli/commands/doctor.js";
import { parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import {
  DOCTOR_SCHEMA_VERSION,
  type DoctorAction,
  type DoctorCategory,
  type DoctorCoverage,
  type DoctorFinding,
  type DoctorReport,
  doctorFindingId,
  doctorVerdict,
  sortDoctorCoverage,
  sortDoctorFindings,
  summarizeDoctorFindings,
} from "../../src/domain/doctor/model.js";
import { doctorOperation } from "../../src/domain/doctor/operations.js";
import { HARNESSES } from "../../src/domain/harnesses.js";
import type { DirEntry, FileStat, FileSystemPort, LinkStat } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * `prepareDoctorBatch`: la mitad de F3 que decide QUÉ se va a aprobar, y la que
 * tiene que ser indistinguible entre dos corridas del mismo estado.
 *
 * Lo que se fija acá son propiedades del sello, nunca su valor: comparar el
 * digest contra un `semanticDigest` recomputado en la prueba mueve los dos lados
 * juntos —cambiá lo que el sello cubre y la prueba te sigue— y comparar contra un
 * literal congela una cadena que ningún contrato publica. Así que se afirma lo
 * único que la persona necesita cierto: dos corridas sobre el mismo estado sellan
 * IGUAL, y cualquier cambio material sella DISTINTO.
 *
 * Los seis defectos que estas pruebas atrapan, y que son silenciosos:
 *  - listar sellando: `prepare` sin selección devolviendo un digest enseña a
 *    aprobar antes de elegir, y ese digest describe un lote que nadie eligió;
 *  - un digest que no cubre el `read_set`: el compare-and-swap de `apply` deja de
 *    detectar que el estado se movió entre la vista previa y la aprobación;
 *  - un orden no topológico: armar los hooks antes de instalar el bundle falla
 *    siempre, y la vista previa lo mostraba en el orden equivocado;
 *  - un orden inestable: el digest cambia sin que nada material cambie, así que
 *    un reintento idéntico vuelve a preguntar;
 *  - una vista previa que no se deriva del objeto sellado: se muestra una cosa y
 *    se aplica otra;
 *  - un rechazo que no nombra: la persona no puede distinguir «ese id no existe»
 *    de «ese id existe y no se puede reparar».
 */

/**
 * `runDoctor` se puede sustituir, y por defecto NO se sustituye.
 *
 * Casi todo este archivo corre el agregador REAL con proveedores dobles, que es
 * el único camino donde el gate de propiedad de `annotateRepairs` y el orden del
 * informe participan de verdad. La sustitución existe para las dos cosas que ese
 * camino no puede producir: un informe con acciones que se depenten en círculo
 * —`annotateRepairs` sólo emite la dependencia hooks→bundle, así que un ciclo no
 * es construible desde un proveedor— y la superficie `doctorCommand`, que no
 * acepta proveedores inyectados y sin esto diagnosticaría la máquina de quien
 * corra la suite.
 */
const doctorReport = vi.hoisted(() => ({
  override: null as null | (() => Promise<DoctorReport>),
  /**
   * Lo que el agregador RECIBIÓ, corrida por corrida.
   *
   * Es la única forma de ver `--host`, `--only` y `--skip-native`: los tres
   * viajan hacia adentro y no dejan rastro en el lote sellado, así que dejar de
   * pasarlos no cambia ni una línea de la vista previa.
   */
  calls: [] as unknown[][],
}));

vi.mock("../../src/application/doctor/report.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/application/doctor/report.js")>();
  return {
    ...actual,
    runDoctor: async (...args: Parameters<typeof actual.runDoctor>): Promise<DoctorReport> => {
      doctorReport.calls.push(args);
      return doctorReport.override === null
        ? await actual.runDoctor(...args)
        : await doctorReport.override();
    },
  };
});

const NS = normalizeNamespace("workflow");

const RUNTIME: ResolvedRuntime = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  source: "default",
};

/** El prefijo del comando `apply`, tal como el contrato de F3 lo publica. */
const APPLY_PREFIX = "aw doctor apply --approval ";

/** Un sha256 en hex: la forma de un sello, y lo que un listado NO puede tener. */
const DIGEST_SHAPE = /^[0-9a-f]{64}$/;

/** Los verbos del catálogo, escritos a mano: son el comando que la persona podría tipear. */
const VERB_MCP_SETUP = "aw mcp setup --host claude --instance familia --scope global";
const VERB_SKILLS_REINSTALL = "aw self skills reinstall --name w:plan-exec";
const VERB_INSTALL_SKILL = "aw self install-skill --target claude-code";
const VERB_INSTALL_HOOKS = "aw self install-hooks --target claude-code";

const ID_MCP_PROPIO = doctorFindingId("claude-code", "mcps", "familia");
const ID_SKILL_REPLICA = doctorFindingId("claude-code", "skills", "w:plan-exec");
const ID_MCP_AJENO = doctorFindingId("claude-code", "mcps", "ajeno-roto");
const ID_DSN = doctorFindingId("claude-code", "tools-auth", "DB_FAMILIA_DSN");

/**
 * FileSystemPort que DELEGA lectura y sólo REGISTRA mutación.
 *
 * `MemFs.writes` sólo ve `writeText`, y la mitad de AC-04 que le toca a esta
 * fase promete que `prepare` no crea, borra, copia ni enlaza NADA por ninguna
 * vía del puerto.
 */
class RecordingFs implements FileSystemPort {
  readonly mutations: string[] = [];
  constructor(private readonly inner: MemFs) {}

  private record(op: string, path: string): void {
    this.mutations.push(`${op} ${path}`);
  }

  readText(path: string): Promise<string> {
    return this.inner.readText(path);
  }
  readBytes(path: string): Promise<Uint8Array> {
    return this.inner.readBytes(path);
  }
  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }
  list(path: string): Promise<DirEntry[]> {
    return this.inner.list(path);
  }
  stat(path: string): Promise<FileStat> {
    return this.inner.stat(path);
  }
  lstat(path: string): Promise<LinkStat | null> {
    return this.inner.lstat(path);
  }
  realPath(path: string): Promise<string> {
    return this.inner.realPath(path);
  }

  async writeText(path: string, content: string): Promise<void> {
    this.record("writeText", path);
    await this.inner.writeText(path, content);
  }
  async appendText(path: string, content: string): Promise<void> {
    this.record("appendText", path);
    await this.inner.appendText(path, content);
  }
  async writeTextExclusive(path: string, content: string): Promise<{ created: boolean }> {
    this.record("writeTextExclusive", path);
    return this.inner.writeTextExclusive(path, content);
  }
  async publishTextExclusive(path: string, content: string): Promise<{ created: boolean }> {
    this.record("publishTextExclusive", path);
    return this.inner.publishTextExclusive(path, content);
  }
  async remove(path: string): Promise<void> {
    this.record("remove", path);
    await this.inner.remove(path);
  }
  async mkdirp(path: string): Promise<void> {
    this.record("mkdirp", path);
    await this.inner.mkdirp(path);
  }
  async symlink(target: string, path: string): Promise<void> {
    this.record("symlink", `${path} -> ${target}`);
    await this.inner.symlink(target, path);
  }
}

/** claude-code queda `ready` y codex `installable`; el resto del catálogo, ausente. */
function hostStateFs(home: string): MemFs {
  return new MemFs({ lenient: true })
    .dir(join(home, ".claude"))
    .dir(join(home, ".claude", "skills", "w"))
    .dir(join(home, ".codex"));
}

const HOST_BINS: Record<string, string> = {
  claude: "/usr/local/bin/claude",
  codex: "/usr/local/bin/codex",
};

function makeCtx(fs: FileSystemPort, home: string, root: string = home): CliContext {
  return {
    fs,
    env: new FakeEnv(home, root),
    process: new FakeProcess({
      which: (cmd) => HOST_BINS[cmd],
      run: () => ({ code: 0, stdout: "9.9.9", stderr: "" }),
    }),
    paths: new PathsService(NS, home, root),
    namespace: { namespace: NS, source: "default" },
    runtime: RUNTIME,
    skills: { roles: {}, source: "default" },
  } as unknown as CliContext;
}

/**
 * Un hallazgo con la SUGERENCIA del proveedor, no con la acción.
 *
 * `proposal` es lo que un proveedor real emite: quién puede recibir una acción
 * lo decide `annotateRepairs`, y pasar por ahí es lo que hace que estas pruebas
 * también cubran el gate de propiedad en vez de esquivarlo.
 */
function hint(
  host: string,
  category: DoctorCategory,
  name: string,
  proposal: { op: string; args: Record<string, string> } | undefined,
  over: Partial<DoctorFinding> = {},
): DoctorFinding {
  return {
    id: doctorFindingId(host, category, name),
    host,
    category,
    resource: { kind: "mcp-entry", name, locator: `~/.config/${host}/${name}` },
    state: "warning",
    summary: `${name} no está donde debería`,
    impact: `sin ${name} ese host no puede usar Workline`,
    evidence: [`leído de ~/.config/${host}/${name}`],
    ownership: "ours",
    remediation: { kind: "manual", action: null, guidance: [] },
    ...(proposal === undefined ? {} : { proposal }),
    ...over,
  };
}

/** Proveedor doble: emite exactamente estos hallazgos, en este orden. */
function provider(category: DoctorCategory, findings: DoctorFinding[]): DoctorProvider {
  return {
    category,
    async run() {
      return {
        coverage: [coverage(category, "claude-code", "checked")],
        findings: [...findings],
      };
    },
  };
}

/**
 * Los tres hallazgos de la condición de salida de F3: un MCP propio ausente, una
 * skill con réplica incompleta y un MCP ajeno roto.
 *
 * El ajeno llega CON sugerencia a propósito: el proveedor puede equivocarse, y
 * lo que tiene que negarlo es el gate, no la buena voluntad del proveedor.
 */
function exitConditionProviders(): DoctorProvider[] {
  return [
    provider("mcps", [
      hint("claude-code", "mcps", "familia", {
        op: "mcp.setup",
        args: { host: "claude", instance: "familia", scope: "global" },
      }),
      hint(
        "claude-code",
        "mcps",
        "ajeno-roto",
        { op: "mcp.remove", args: { host: "claude", instance: "ajeno-roto", scope: "global" } },
        { ownership: "foreign" },
      ),
    ]),
    provider("skills", [
      hint("claude-code", "skills", "w:plan-exec", {
        op: "skills.reinstall",
        args: { name: "w:plan-exec" },
      }),
    ]),
  ];
}

/** Bundle ausente y hooks desarmados en el MISMO host: la única dependencia real. */
function dependentProviders(reverse = false): DoctorProvider[] {
  // Los nombres de recurso ordenan los hooks ANTES del bundle en el informe: si
  // `prepare` conservara el orden de llegada, el lote intentaría armar hooks
  // sobre un bundle que todavía no existe.
  const hooks = hint("claude-code", "plugins-hooks", "aaa-hooks-armados", {
    op: "self.install-hooks",
    args: { target: "claude-code" },
  });
  const bundle = hint("claude-code", "plugins-hooks", "zzz-bundle", {
    op: "self.install-skill",
    args: { target: "claude-code" },
  });
  return [provider("plugins-hooks", reverse ? [bundle, hooks] : [hooks, bundle])];
}

const ID_HOOKS = doctorFindingId("claude-code", "plugins-hooks", "aaa-hooks-armados");
const ID_BUNDLE = doctorFindingId("claude-code", "plugins-hooks", "zzz-bundle");

/** Un hallazgo que YA llega con acción: para los informes de fixture. */
function supported(
  host: string,
  category: DoctorCategory,
  name: string,
  action: DoctorAction,
): DoctorFinding {
  return {
    ...hint(host, category, name, undefined),
    remediation: { kind: "supported", action, guidance: [] },
  };
}

/**
 * Un informe completo, ensamblado con las funciones del modelo.
 *
 * El resumen y el veredicto los calcula producción sobre los hallazgos, así que
 * no hay ninguna cifra escrita por la prueba.
 */
function reportOf(findings: DoctorFinding[], coverages: DoctorCoverage[] = []): DoctorReport {
  const hostOrder = [...HARNESSES.map((spec) => spec.id), "workspace"];
  const orderedFindings = sortDoctorFindings(findings, hostOrder);
  const orderedCoverage = sortDoctorCoverage(coverages, hostOrder);
  return {
    schema_version: DOCTOR_SCHEMA_VERSION,
    cli_version: "0.0.0-test",
    scope: { workspace_dir: "/w", current_host: "claude-code", only: [] },
    hosts: [],
    hosts_absent: [],
    coverage: orderedCoverage,
    findings: orderedFindings,
    summary: summarizeDoctorFindings(orderedFindings),
    verdict: doctorVerdict(orderedFindings, orderedCoverage),
  };
}

function sealed(outcome: DoctorPrepareOutcome): DoctorProposal {
  if (!outcome.ok) {
    throw new Error(`se esperaba un lote sellado y llegó ${outcome.rejection.code}`);
  }
  if (outcome.kind !== "sealed") throw new Error("se esperaba un lote sellado y llegó un listado");
  return outcome.proposal;
}

/**
 * El sobre sellado ENTERO, informe incluido.
 *
 * `sealed` devuelve sólo la propuesta, así que el informe que viaja con el sobre
 * no se observaba: perderlo obligaría a la superficie a volver a diagnosticar
 * para mostrar el contexto del lote que ya selló, y ese segundo informe podría
 * no ser el que la persona leyó para elegir.
 */
function sealedOutcome(outcome: DoctorPrepareOutcome): {
  proposal: DoctorProposal;
  report: DoctorReport;
} {
  if (!outcome.ok) throw new Error(`se esperaba un lote sellado y llegó ${outcome.rejection.code}`);
  if (outcome.kind !== "sealed") throw new Error("se esperaba un lote sellado y llegó un listado");
  return { proposal: outcome.proposal, report: outcome.report };
}

function listed(outcome: DoctorPrepareOutcome): DoctorPrepareListing {
  if (!outcome.ok) throw new Error(`se esperaba un listado y llegó ${outcome.rejection.code}`);
  if (outcome.kind !== "listing") throw new Error("se esperaba un listado y llegó un lote sellado");
  return outcome.listing;
}

function rejected(outcome: DoctorPrepareOutcome): DoctorPrepareRejection {
  if (outcome.ok) throw new Error(`se esperaba un rechazo y llegó un ${outcome.kind}`);
  return outcome.rejection;
}

/** Listado recursivo y ordenado de un árbol real: la huella que `prepare` no puede cambiar. */
function treeOf(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      out.push(`${entry.isDirectory() ? "d" : "f"} ${relative(root, abs)}`);
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return out.sort();
}

describe("prepareDoctorBatch", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "doctor-prepare-"));
    doctorReport.calls.length = 0;
  });
  afterEach(() => {
    doctorReport.override = null;
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * Sin selección se LISTA, y listar no sella.
   *
   * El defecto que cierra: un `prepare` que devolviera un digest junto con el
   * listado publicaría un sello sobre un lote que nadie eligió, y `apply
   * --approval <ese digest>` ejecutaría todo lo accionable. Por eso no se afirma
   * sólo que falta la clave `digest`: no puede haber NINGÚN sello en ningún lugar
   * de la salida.
   */
  it("sin selección lista lo accionable y no sella nada", async () => {
    const outcome = await prepareDoctorBatch(
      makeCtx(new RecordingFs(hostStateFs(home)), home),
      {},
      { providers: exitConditionProviders() },
    );
    const listing = listed(outcome);

    expect(listing.actionable.map((action) => action.finding_id)).toEqual([
      ID_MCP_PROPIO,
      ID_SKILL_REPLICA,
    ]);
    expect(listing.actionable.map((action) => action.verb)).toEqual([
      VERB_MCP_SETUP,
      VERB_SKILLS_REINSTALL,
    ]);
    // El informe entero viaja con el listado: es lo que la persona lee para
    // elegir, y los tres hallazgos son los de la condición de salida —el ajeno
    // incluido, que se lee pero no se selecciona.
    expect(listing.report.findings.map((finding) => finding.id)).toEqual([
      ID_MCP_AJENO,
      ID_MCP_PROPIO,
      ID_SKILL_REPLICA,
    ]);

    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("digest");
    expect(serialized).not.toMatch(/[0-9a-f]{64}/);
    expect(Object.keys(listing).sort()).toEqual(["actionable", "report"]);
  });

  /**
   * La condición de salida de F3, entera: dos accionables sellan un lote de dos
   * acciones con su orden y su `next`, y el tercero no es seleccionable.
   *
   * `next` se afirma como el comando LITERAL porque es lo que la persona copia:
   * un `next` sin el digest, o al que le falta un `--select`, describe un lote
   * distinto del que se acaba de mostrar y `apply` lo rechazaría —o peor, lo
   * aceptaría por otro conjunto.
   */
  it("con selección sella {digest, batch, read_set, preview, next} y next es el apply literal", async () => {
    const outcome = await prepareDoctorBatch(
      makeCtx(new RecordingFs(hostStateFs(home)), home),
      { select: [ID_MCP_PROPIO, ID_SKILL_REPLICA] },
      { providers: exitConditionProviders() },
    );
    const { proposal, report } = sealedOutcome(outcome);

    expect(Object.keys(proposal).sort()).toEqual([
      "batch",
      "digest",
      "next",
      "preview",
      "read_set",
    ]);
    expect(proposal.digest).toMatch(DIGEST_SHAPE);

    expect(proposal.batch.actions.map((action) => action.finding_id)).toEqual([
      ID_MCP_PROPIO,
      ID_SKILL_REPLICA,
    ]);
    expect(proposal.batch.actions.map((action) => action.op)).toEqual([
      "mcp.setup",
      "skills.reinstall",
    ]);
    /*
     * Los `args` de cada acción, contra literales.
     *
     * Son lo ÚNICO que le dice a `apply` sobre qué recurso actuar: sin
     * `host`/`instance`/`scope` la entrada MCP se registraría en el host
     * equivocado —o en ninguno—, y sin `name` la reinstalación no sabría qué
     * skill materializar. Un lote que sellara `args: {}` describiría una
     * reparación sin recurso, y su digest se aprobaría igual.
     */
    expect(proposal.batch.actions.map((action) => action.args)).toEqual([
      { host: "claude", instance: "familia", scope: "global" },
      { name: "w:plan-exec" },
    ]);
    // Los efectos del lote son la unión ordenada, y es lo que la aprobación cubre.
    expect(proposal.batch.effects).toEqual(["mutate_overwrite"]);

    expect(proposal.next).toBe(
      `${APPLY_PREFIX}${proposal.digest} --select ${ID_MCP_PROPIO} --select ${ID_SKILL_REPLICA}`,
    );

    // El informe viaja CON el sobre sellado, entero y en su orden: es el que la
    // persona acaba de leer, no uno que haya que volver a producir.
    expect(report.findings.map((finding) => finding.id)).toEqual([
      ID_MCP_AJENO,
      ID_MCP_PROPIO,
      ID_SKILL_REPLICA,
    ]);
  });

  /**
   * REPRODUCIBLE: el mismo estado y la misma selección sellan igual.
   *
   * Es la promesa que hace que un reintento idéntico no vuelva a preguntar. Se
   * compara UNA corrida contra OTRA —nunca contra `semanticDigest` recomputado
   * acá, que se movería junto con el código— y se agrega la selección en orden
   * inverso: el conjunto elegido es un conjunto, y si el orden en que se tipearon
   * los `--select` entrara al sello, aprobar lo mismo dos veces daría dos digests.
   */
  it("dos corridas sobre el mismo estado y la misma selección dan el MISMO digest", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);
    const first = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO, ID_SKILL_REPLICA] },
        { providers: exitConditionProviders() },
      ),
    );
    const second = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO, ID_SKILL_REPLICA] },
        { providers: exitConditionProviders() },
      ),
    );
    const typedBackwards = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_SKILL_REPLICA, ID_MCP_PROPIO] },
        { providers: exitConditionProviders() },
      ),
    );

    expect(second.digest).toBe(first.digest);
    expect(second.batch).toEqual(first.batch);
    expect(second.read_set).toEqual(first.read_set);
    expect(second.preview).toEqual(first.preview);
    expect(second.next).toBe(first.next);
    expect(typedBackwards.digest).toBe(first.digest);
    expect(typedBackwards.batch.actions.map((action) => action.finding_id)).toEqual(
      first.batch.actions.map((action) => action.finding_id),
    );
  });

  /**
   * MATERIAL: cualquier cambio de lo que se va a hacer, o de contra qué estado se
   * decidió, produce OTRO digest.
   *
   * Las tres direcciones son distintas y cada una tiene su forma de romperse: el
   * conjunto de acciones (sellar sólo la primera), la operación de una acción
   * (sellar el id del hallazgo y no lo que se le va a hacer) y el `read_set`
   * (sellar sólo el lote, que es exactamente lo que deja a `apply` sin
   * compare-and-swap).
   */
  it("otra selección, otra operación y otro read_set dan digests DISTINTOS", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);
    const base = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO] },
        { providers: exitConditionProviders() },
      ),
    );

    // 1) Una acción más en el lote.
    const wider = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO, ID_SKILL_REPLICA] },
        { providers: exitConditionProviders() },
      ),
    );
    expect(wider.digest).not.toBe(base.digest);

    // 2) El MISMO hallazgo, otra operación: retirar la entrada en vez de
    // registrarla. El id es idéntico, así que un sello que sólo cubriera los ids
    // seleccionados no notaría la diferencia entre escribir y borrar.
    const otherOp = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO] },
        {
          providers: [
            provider("mcps", [
              hint("claude-code", "mcps", "familia", {
                op: "mcp.remove",
                args: { host: "claude", instance: "familia", scope: "global" },
              }),
            ]),
          ],
        },
      ),
    );
    expect(otherOp.batch.actions[0]?.finding_id).toBe(base.batch.actions[0]?.finding_id);
    expect(otherOp.batch.actions[0]?.op).toBe("mcp.remove");
    expect(otherOp.digest).not.toBe(base.digest);

    // 3) Otro `read_set`: se toca uno de los archivos que el lote LEE para
    // decidir. Nada del lote cambió; el estado sobre el que se armó, sí.
    const touched = join(home, ".mcp.json");
    expect(base.read_set.map((entry) => entry.id)).toContain(touched);
    writeFileSync(touched, '{"mcpServers":{}}\n', "utf-8");

    const afterTouch = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO] },
        { providers: exitConditionProviders() },
      ),
    );
    expect(afterTouch.batch).toEqual(base.batch);
    expect(afterTouch.digest).not.toBe(base.digest);
  });

  /**
   * La vista previa se DERIVA del objeto sellado.
   *
   * El defecto que cierra es el de una vista previa guardada al lado del lote:
   * dos descripciones del mismo cambio que pueden discrepar, y la persona aprueba
   * la que le mostraron mientras `apply` ejecuta la otra. Así que cada acción del
   * lote tiene que aparecer con su verbo, sus efectos y su estado esperado, la
   * última línea tiene que ser el digest sellado, y un lote distinto tiene que
   * dar una vista previa distinta.
   */
  it("cada acción del lote está en el preview con verbo, efectos y estado esperado, y termina en el digest", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);
    const proposal = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO, ID_SKILL_REPLICA] },
        { providers: exitConditionProviders() },
      ),
    );
    const preview = proposal.preview.join("\n");

    // Los verbos y los efectos salen del catálogo (escritos a mano acá), no del
    // objeto que `prepare` devolvió.
    expect(preview).toContain(`comando equivalente: ${VERB_MCP_SETUP}`);
    expect(preview).toContain(`comando equivalente: ${VERB_SKILLS_REINSTALL}`);
    expect(preview).toContain(`${doctorOperation("mcp.setup")?.summary} — familia (claude-code)`);
    expect(preview).toContain(
      `${doctorOperation("skills.reinstall")?.summary} — w:plan-exec (claude-code)`,
    );
    expect(preview.match(/efectos: mutate_overwrite$/gm)).toHaveLength(2);
    expect(preview.match(/estado esperado: healthy$/gm)).toHaveLength(2);

    // Las dos acciones aparecen en el ORDEN del lote, numeradas.
    expect(proposal.preview[0]).toBe("2 acción(es), en este orden:");
    expect(preview.indexOf(VERB_MCP_SETUP)).toBeLessThan(preview.indexOf(VERB_SKILLS_REINSTALL));

    // Y termina en el sello: es lo que la persona aprueba.
    expect(proposal.preview.at(-1)).toBe(`digest: ${proposal.digest}`);

    // Un lote distinto, una vista previa distinta.
    const narrower = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO] },
        { providers: exitConditionProviders() },
      ),
    );
    expect(narrower.preview).not.toEqual(proposal.preview);
    expect(narrower.preview[0]).toBe("1 acción(es), en este orden:");
    expect(narrower.preview.join("\n")).not.toContain(VERB_SKILLS_REINSTALL);
  });

  /**
   * ORDEN TOPOLÓGICO, y estable.
   *
   * Armar los hooks de un host antes de instalarle el bundle falla siempre, así
   * que la dependiente va DESPUÉS. Los nombres de recurso están elegidos para que
   * el informe entregue los hooks PRIMERO: sin reordenar, el lote saldría en el
   * orden en que el informe ya venía y ninguna aserción sobre el conjunto lo
   * notaría. Y el orden es parte del sello, así que también tiene que ser el mismo
   * cuando los hallazgos entran al revés.
   */
  it("la acción dependiente va después, y el orden no depende del orden de llegada", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);

    const straight = await prepareDoctorBatch(
      ctx,
      { select: [ID_HOOKS, ID_BUNDLE] },
      { providers: dependentProviders() },
    );
    const listing = listed(await prepareDoctorBatch(ctx, {}, { providers: dependentProviders() }));
    // El informe entrega los hooks primero: reordenar es trabajo de `prepare`.
    expect(listing.actionable.map((action) => action.finding_id)).toEqual([ID_HOOKS, ID_BUNDLE]);

    const first = sealed(straight);
    expect(first.batch.actions.map((action) => action.finding_id)).toEqual([ID_BUNDLE, ID_HOOKS]);
    // La dependencia la resolvió el anotador entre las acciones de ESTA corrida.
    expect(first.batch.actions[1]?.depends_on).toEqual([ID_BUNDLE]);
    expect(first.batch.actions[0]?.depends_on).toEqual([]);
    expect(first.batch.actions.map((action) => action.verb)).toEqual([
      VERB_INSTALL_SKILL,
      VERB_INSTALL_HOOKS,
    ]);
    expect(first.batch.actions.map((action) => action.args)).toEqual([
      { target: "claude-code" },
      { target: "claude-code" },
    ]);
    const previewText = first.preview.join("\n");
    // El preview arrastra el orden y dice de quién depende cada acción.
    expect(previewText).toContain(`después de: ${ID_BUNDLE}`);

    /*
     * DOS clases de efecto en el mismo lote: la única forma de ver la unión.
     *
     * Instalar el bundle crea donde falta y reescribe lo que quedó viejo
     * (`local_additive` + `mutate_overwrite`); armar los hooks sólo reescribe.
     * Sobre un lote cuya unión colapsa a una sola clase, «unir» es
     * indistinguible de «tomar la primera» y un orden lo es de su inverso.
     *
     * `requires_approval` es el subconjunto que NO se autoriza solo, con el
     * mismo `SELF_AUTHORIZABLE_CLASSES` que sella una propuesta de capacidad:
     * `local_additive` queda AFUERA, y si apareciera ahí la vista previa le
     * pediría a la persona autorizar lo que la invocación ya concede.
     */
    expect(first.batch.effects).toEqual(["local_additive", "mutate_overwrite"]);
    expect(first.batch.requires_approval).toEqual(["mutate_overwrite"]);

    /*
     * Las tres líneas de NIVEL DE LOTE de la vista previa.
     *
     * `efectos del lote` es la que le dice a la persona qué clases está
     * autorizando; `lo que tu aprobación habilita` acota eso a lo que su firma
     * agrega; `estado leído para decidir` dice sobre cuánto estado se armó el
     * lote, que es lo que `apply` va a releer. Las tres se pueden borrar sin que
     * ninguna otra aserción de este archivo lo note.
     */
    expect(first.read_set.map((entry) => entry.id)).toEqual([
      join(home, ".claude", "settings.json"),
      join(home, ".workflow", "dev", "mcp-connections.json"),
    ]);
    expect(previewText).toContain("efectos del lote: local_additive, mutate_overwrite");
    expect(previewText).toContain("lo que tu aprobación habilita: mutate_overwrite");
    expect(previewText).toContain("estado leído para decidir: 2 archivo(s)");

    const again = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_HOOKS, ID_BUNDLE] },
        { providers: dependentProviders() },
      ),
    );
    const reversedArrival = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_HOOKS, ID_BUNDLE] },
        { providers: dependentProviders(true) },
      ),
    );

    expect(again.batch.actions.map((action) => action.finding_id)).toEqual([ID_BUNDLE, ID_HOOKS]);
    expect(reversedArrival.batch.actions.map((action) => action.finding_id)).toEqual([
      ID_BUNDLE,
      ID_HOOKS,
    ]);
    expect(again.digest).toBe(first.digest);
    expect(reversedArrival.digest).toBe(first.digest);
  });

  /**
   * Una dependencia que quedó FUERA del lote no impide sellarlo.
   *
   * Escenario real: la persona lee el informe, ve que le faltan los hooks y
   * selecciona ESE hallazgo solo, sin el bundle. El orden topológico sólo puede
   * esperar lo que también se va a ejecutar: una dependencia que nadie
   * seleccionó no llega nunca, así que se ignora en lugar de bloquear. Sin esa
   * rama, una selección de UNA acción —donde no hay ningún ciclo posible—
   * saldría rechazada con `SELECTION_CYCLE` y con un consejo imposible de
   * seguir: «quitá una de las acciones del ciclo».
   *
   * El `depends_on` se CONSERVA en la acción sellada: es verdad sobre el
   * recurso, y quien la lea tiene que poder ver que la precondición sigue ahí,
   * afuera del lote que se está aprobando.
   */
  it("una dependencia que quedó fuera del lote no impide sellar", async () => {
    const proposal = sealed(
      await prepareDoctorBatch(
        makeCtx(new RecordingFs(hostStateFs(home)), home),
        { select: [ID_HOOKS] },
        { providers: dependentProviders() },
      ),
    );

    expect(proposal.batch.actions.map((action) => action.finding_id)).toEqual([ID_HOOKS]);
    expect(proposal.batch.actions[0]?.depends_on).toEqual([ID_BUNDLE]);
    expect(proposal.batch.actions[0]?.verb).toBe(VERB_INSTALL_HOOKS);
    expect(proposal.digest).toMatch(DIGEST_SHAPE);
    expect(proposal.next).toBe(`${APPLY_PREFIX}${proposal.digest} --select ${ID_HOOKS}`);
  });

  /**
   * Un ciclo se rechaza, y sin sellar.
   *
   * Sellar un lote con un ciclo publicaría una vista previa cuyo orden es
   * imposible: `apply` se quedaría esperando una dependencia que nunca termina, o
   * —peor— caería en el orden de llegada y ejecutaría al revés lo que la persona
   * aprobó. El informe llega como fixture porque `annotateRepairs` sólo emite la
   * dependencia hooks→bundle: un ciclo no es construible desde un proveedor, y la
   * defensa tiene que existir igual.
   */
  it("un ciclo entre las acciones seleccionadas se rechaza con SELECTION_CYCLE y sin sellar", async () => {
    const uno = doctorFindingId("claude-code", "mcps", "uno");
    const dos = doctorFindingId("claude-code", "mcps", "dos");
    doctorReport.override = async () =>
      reportOf([
        supported("claude-code", "mcps", "uno", {
          op: "mcp.setup",
          args: { host: "claude", instance: "uno", scope: "global" },
          effects: ["mutate_overwrite"],
          depends_on: [dos],
          expected: "healthy",
        }),
        supported("claude-code", "mcps", "dos", {
          op: "mcp.setup",
          args: { host: "claude", instance: "dos", scope: "global" },
          effects: ["mutate_overwrite"],
          depends_on: [uno],
          expected: "healthy",
        }),
      ]);

    const outcome = await prepareDoctorBatch(makeCtx(new RecordingFs(hostStateFs(home)), home), {
      select: [uno, dos],
    });
    const rejection = rejected(outcome);

    expect(rejection.code).toBe("SELECTION_CYCLE");
    expect(rejection.candidates.sort()).toEqual([dos, uno].sort());
    expect(rejection.action).toBe("quitá una de las acciones del ciclo y volvé a preparar");
    expect(JSON.stringify(outcome)).not.toMatch(/[0-9a-f]{64}/);
  });

  /**
   * Un id que este informe no tiene se rechaza NOMBRÁNDOLO.
   *
   * «Selección inválida» obligaría a adivinar entre las dos causas posibles, y la
   * más frecuente —el estado cambió y el hallazgo ya no está— se arregla de una
   * forma completamente distinta que un id mal tipeado.
   */
  it("un id que el informe no tiene se rechaza con SELECTION_UNKNOWN y ese id en candidates", async () => {
    const fantasma = doctorFindingId("claude-code", "mcps", "no-existe");
    const outcome = await prepareDoctorBatch(
      makeCtx(new RecordingFs(hostStateFs(home)), home),
      { select: [ID_MCP_PROPIO, fantasma] },
      { providers: exitConditionProviders() },
    );
    const rejection = rejected(outcome);

    expect(rejection.code).toBe("SELECTION_UNKNOWN");
    expect(rejection.candidates).toEqual([fantasma]);
    expect(rejection.message).toContain(fantasma);
    // El id que SÍ existía no se acusa: el rechazo nombra la causa, no la selección entera.
    expect(rejection.candidates).not.toContain(ID_MCP_PROPIO);
    expect(JSON.stringify(outcome)).not.toMatch(/[0-9a-f]{64}/);
  });

  /**
   * Un id que existe y no es accionable también se rechaza nombrándolo, y por su
   * propia razón.
   *
   * Los dos casos que llegan acá son los dos que AC-08 y AC-10 protegen: un
   * recurso ajeno —que el proveedor incluso sugirió reparar, y el gate negó— y una
   * variable de autenticación, cuyo remedio es manual porque automatizarlo pondría
   * la custodia del secreto en manos del CLI. Ninguno de los dos puede colarse en
   * un lote por haber sido nombrado en un `--select`.
   */
  it("un id no accionable —ajeno o de remedio manual— se rechaza con SELECTION_NOT_ACTIONABLE", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);

    const foreign = rejected(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_AJENO] },
        { providers: exitConditionProviders() },
      ),
    );
    expect(foreign.code).toBe("SELECTION_NOT_ACTIONABLE");
    expect(foreign.candidates).toEqual([ID_MCP_AJENO]);
    expect(foreign.message).toContain(ID_MCP_AJENO);

    const manualProviders = [
      provider("tools-auth", [
        hint("claude-code", "tools-auth", "DB_FAMILIA_DSN", {
          op: "mcp.setup",
          args: { host: "claude", instance: "familia", scope: "global" },
        }),
      ]),
    ];
    const listing = listed(await prepareDoctorBatch(ctx, {}, { providers: manualProviders }));
    // Ni siquiera se lista: el gate lo dejó con guía manual.
    expect(listing.actionable).toEqual([]);

    const manual = rejected(
      await prepareDoctorBatch(ctx, { select: [ID_DSN] }, { providers: manualProviders }),
    );
    expect(manual.code).toBe("SELECTION_NOT_ACTIONABLE");
    expect(manual.candidates).toEqual([ID_DSN]);
    expect(JSON.stringify(manual)).not.toMatch(/[0-9a-f]{64}/);
  });

  /**
   * AC-04, la mitad que le toca a esta fase: `prepare` no escribe NADA.
   *
   * Se vigilan las dos vías, porque el código usa las dos: el puerto de archivos
   * —registrado entero, no sólo `writeText`— y el disco real, que es por donde
   * `readSetFor` lee (los archivos son de los HOSTS, fuera del workspace donde el
   * puerto vive). Y se corre el camino que SELLA, no el que lista: es el que abre
   * archivos, y un `prepare` que dejara un archivo de trabajo al lado —o que
   * creara el directorio que va a escribir— ya habría tocado la máquina antes de
   * que nadie aprobara nada.
   */
  it("no escribe nada: ni por el puerto de archivos ni en el árbol real", async () => {
    const recording = new RecordingFs(hostStateFs(home));
    const before = treeOf(home);

    const proposal = sealed(
      await prepareDoctorBatch(
        makeCtx(recording, home),
        { select: [ID_MCP_PROPIO, ID_SKILL_REPLICA] },
        { providers: exitConditionProviders() },
      ),
    );

    expect(recording.mutations).toEqual([]);
    expect(treeOf(home)).toEqual(before);
    // Y el trabajo ocurrió: sin esto, «no escribió» también sería cierto para un
    // `prepare` que se cortó antes de mirar un solo archivo.
    expect(proposal.read_set.length).toBeGreaterThan(0);
    expect(proposal.batch.actions).toHaveLength(2);
  });

  /**
   * El `read_set` es el compare-and-swap, y un archivo AUSENTE es parte de él.
   *
   * «No estaba» es un estado del que la decisión también depende: si la entrada
   * MCP aparece entre la vista previa y la aprobación, el lote se armó sobre otra
   * realidad y `apply` tiene que poder verlo. Un `read_set` que salteara lo
   * ausente daría exactamente el falso «nada cambió» sobre el caso más probable —
   * porque lo que casi siempre falta es lo que la reparación va a crear.
   */
  it("el read_set lleva los archivos leídos con su digest, y lo ausente entra como absent", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);
    const connections = join(home, ".workflow", "dev", "mcp-connections.json");
    const entry = join(home, ".mcp.json");

    const missing = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO] },
        { providers: exitConditionProviders() },
      ),
    );

    // El registro de conexiones entra SIEMPRE —es lo que decide qué conexiones
    // existen— y con él los archivos de host que la operación va a tocar.
    const ids = missing.read_set.map((item) => item.id);
    expect(ids).toContain(connections);
    expect(ids).toContain(entry);
    expect(ids).toContain(join(home, ".claude.json"));
    expect(ids).toContain(join(home, ".codex", "config.toml"));
    // Ordenado y sin repetidos: es lo que hace comparable un `read_set` con otro.
    expect(ids).toEqual([...new Set(ids)].sort());
    // Nada de esto existe todavía, y todo entra igual.
    for (const item of missing.read_set) expect(item.digest).toBe("absent");

    writeFileSync(entry, '{"mcpServers":{}}\n', "utf-8");
    const present = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO] },
        { providers: exitConditionProviders() },
      ),
    );
    const digestOf = (set: readonly { id: string; digest: string }[], id: string): string => {
      const found = set.find((item) => item.id === id);
      if (found === undefined) throw new Error(`el read_set no incluye ${id}`);
      return found.digest;
    };

    expect(digestOf(present.read_set, entry)).toMatch(DIGEST_SHAPE);
    // El resto del conjunto no se movió: el digest es del archivo, no de la corrida.
    expect(digestOf(present.read_set, connections)).toBe("absent");

    // Y el digest sigue al CONTENIDO: dos lecturas del mismo archivo dan lo mismo,
    // otro contenido da otra cosa.
    const again = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO] },
        { providers: exitConditionProviders() },
      ),
    );
    expect(digestOf(again.read_set, entry)).toBe(digestOf(present.read_set, entry));

    writeFileSync(entry, '{"mcpServers":{"familia":{}}}\n', "utf-8");
    const changed = sealed(
      await prepareDoctorBatch(
        ctx,
        { select: [ID_MCP_PROPIO] },
        { providers: exitConditionProviders() },
      ),
    );
    expect(digestOf(changed.read_set, entry)).not.toBe(digestOf(present.read_set, entry));
  });

  /**
   * La UNIÓN de clases de efecto, cuando ninguna acción las trae todas.
   *
   * El caso de hooks+bundle no alcanza para verla: el lote queda ordenado con el
   * bundle primero, y `self.install-skill` ya declara las dos clases, así que
   * «unir todas las acciones» es indistinguible de «tomar las de la primera». Un
   * mutante que sólo mirara `actions[0]` sobrevivía ahí.
   *
   * Acá cada acción aporta una clase que la otra no tiene, y la primera del lote
   * trae UNA sola. Es lo que hace observable la unión — y lo que importa de verdad
   * es que la persona vea `destructive` en la vista previa cuando el lote borra
   * algo, aunque lo que borra no sea la primera acción de la lista.
   */
  describe("prepareDoctorBatch · la unión de efectos mira TODAS las acciones", () => {
    it("una clase que sólo aporta la segunda acción igual llega al lote y a la vista previa", async () => {
      const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);
      // `self.install-hooks` sólo reescribe (`mutate_overwrite`); `mcp.remove`
      // sólo borra (`destructive`). Ninguna trae las dos.
      const hooks = hint("claude-code", "plugins-hooks", "aaa-hooks", {
        op: "self.install-hooks",
        args: { target: "claude-code" },
      });
      const sobrante = hint("claude-code", "mcps", "zzz-sobrante", {
        op: "mcp.remove",
        args: { host: "claude", instance: "sobrante", scope: "workspace" },
      });
      const providers = [provider("plugins-hooks", [hooks]), provider("mcps", [sobrante])];
      const idHooks = doctorFindingId("claude-code", "plugins-hooks", "aaa-hooks");
      const idSobrante = doctorFindingId("claude-code", "mcps", "zzz-sobrante");

      const proposal = sealed(
        await prepareDoctorBatch(ctx, { select: [idHooks, idSobrante] }, { providers }),
      );

      // La primera acción del lote trae UNA clase —el orden es por categoría, y
      // `mcps` va antes que `plugins-hooks`—: sin recorrer el resto, la unión
      // saldría incompleta. Acá el que borra ES el primero, así que la prueba
      // también vale al revés: la clase que se perdería es la del segundo.
      expect(proposal.batch.actions[0]?.effects).toEqual(["destructive"]);
      expect(proposal.batch.actions[1]?.effects).toEqual(["mutate_overwrite"]);
      expect(proposal.batch.effects).toEqual(["destructive", "mutate_overwrite"]);
      expect(proposal.batch.requires_approval).toEqual(["destructive", "mutate_overwrite"]);
      expect(proposal.preview.join("\n")).toContain(
        "efectos del lote: destructive, mutate_overwrite",
      );
    });
  });
});

/**
 * La SUPERFICIE: `aw doctor prepare`, y que el texto proyecte el mismo objeto.
 *
 * `doctorCommand` no acepta proveedores inyectados, así que el informe llega por
 * la sustitución de `runDoctor`: sin eso esta prueba diagnosticaría la máquina de
 * quien corra la suite y su resultado dependería de qué hosts tenga instalados.
 *
 * Lo que se fija es la equivalencia de AC-14 sobre esta superficie: el JSON y el
 * texto salen del MISMO objeto. Un `renderHuman` que resumiera —o que se comiera
 * una acción del lote— dejaría a la persona aprobando un digest cuya vista previa
 * no vio completa.
 */
describe("aw doctor prepare · la superficie y su proyección humana", () => {
  let home: string;

  const A = doctorFindingId("claude-code", "mcps", "familia");
  const B = doctorFindingId("claude-code", "skills", "w:plan-exec");
  const MANUAL = doctorFindingId("claude-code", "mcps", "ajeno-roto");

  function fixtureReport(): DoctorReport {
    return reportOf([
      supported("claude-code", "mcps", "familia", {
        op: "mcp.setup",
        args: { host: "claude", instance: "familia", scope: "global" },
        effects: ["mutate_overwrite"],
        depends_on: [],
        expected: "healthy",
      }),
      supported("claude-code", "skills", "w:plan-exec", {
        op: "skills.reinstall",
        args: { name: "w:plan-exec" },
        effects: ["mutate_overwrite"],
        depends_on: [],
        expected: "healthy",
      }),
      hint("claude-code", "mcps", "ajeno-roto", undefined, { ownership: "foreign" }),
    ]);
  }

  function render(result: Awaited<ReturnType<typeof doctorCommand.execute>>): string {
    const project = doctorCommand.renderHuman;
    if (project === undefined) throw new Error("doctor perdió su proyección humana");
    return project(result, { detail: false });
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "doctor-prepare-surface-"));
    doctorReport.calls.length = 0;
    doctorReport.override = async () => fixtureReport();
  });
  afterEach(() => {
    doctorReport.override = null;
    rmSync(home, { recursive: true, force: true });
  });

  it("sin --select devuelve el listado, y el texto nombra cada accionable con su verbo", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);
    const result = await doctorCommand.execute(parseArgv(["doctor", "prepare"]), ctx);

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    const data = result.data as { kind: string } & DoctorPrepareListing;
    expect(data.kind).toBe("prepare-listing");
    expect(data.actionable.map((action) => action.finding_id)).toEqual([A, B]);
    expect(JSON.stringify(result.data)).not.toMatch(/[0-9a-f]{64}/);

    const text = render(result);
    for (const id of [A, B]) expect(text).toContain(id);
    expect(text).toContain(VERB_MCP_SETUP);
    expect(text).toContain(VERB_SKILLS_REINSTALL);
    /*
     * La línea de efectos de CADA accionable, pegada a su verbo.
     *
     * Es lo único del listado que dice qué clase de cambio implicaría reparar
     * ese hallazgo, y es lo que la persona usa para decidir cuáles seleccionar.
     * Sin ella el listado enumera reparaciones sin declarar ni una consecuencia,
     * y no rompe ninguna otra aserción de la proyección.
     */
    expect(text).toContain(
      `comando equivalente: ${VERB_MCP_SETUP}\n     efectos: mutate_overwrite`,
    );
    expect(text).toContain(
      `comando equivalente: ${VERB_SKILLS_REINSTALL}\n     efectos: mutate_overwrite`,
    );
    // El ajeno no es seleccionable, así que no puede aparecer como accionable.
    expect(text).not.toContain(MANUAL);
  });

  /**
   * `--host`, `--only` y `--skip-native` ATRAVIESAN el subverbo.
   *
   * Los tres viajan sólo hacia adentro: no aparecen en el listado, ni en el lote,
   * ni en la vista previa. Dejar de pasarlos haría que `prepare` diagnosticara
   * todos los hosts —y spawneara la inspección nativa que la persona
   * declinó— mientras la salida se ve idéntica. Lo único que puede verlo es lo
   * que el agregador recibió.
   */
  it("pasa --host, --only y --skip-native al agregador", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);

    await doctorCommand.execute(
      parseArgv([
        "doctor",
        "prepare",
        "--host",
        "codex",
        "--only",
        "claude-code",
        "--only",
        "codex",
        "--skip-native",
        "--select",
        A,
      ]),
      ctx,
    );

    expect(doctorReport.calls).toHaveLength(1);
    expect(doctorReport.calls[0]?.[1]).toEqual({
      host: "codex",
      only: ["claude-code", "codex"],
      skipNative: true,
      select: [A],
    });
  });

  /**
   * `--select A --select A` sella UNA sola acción: la selección es un conjunto.
   *
   * El parser conserva las dos ocurrencias a propósito —perder repeticiones es
   * exactamente cómo `--only` terminaba cubriendo un host solo—, así que
   * deduplicar le toca a `prepare`. Un lote con la misma acción dos veces la
   * ejecutaría dos veces, y su `next` publicaría una selección que no es la que
   * se aprobó.
   */
  it("--select repetido sobre el mismo id sella una sola acción", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);
    const twice = await doctorCommand.execute(
      parseArgv(["doctor", "prepare", "--select", A, "--select", A]),
      ctx,
    );
    const once = await doctorCommand.execute(parseArgv(["doctor", "prepare", "--select", A]), ctx);

    const repeated = twice.data as { kind: string } & DoctorProposal;
    expect(repeated.batch.actions.map((action) => action.finding_id)).toEqual([A]);
    expect(repeated.next).toBe(`${APPLY_PREFIX}${repeated.digest} --select ${A}`);
    // Y sella lo MISMO que nombrarlo una vez: el conjunto elegido es el mismo.
    expect(repeated.digest).toBe((once.data as { kind: string } & DoctorProposal).digest);
  });

  it("con --select repetido devuelve la propuesta sellada y el texto proyecta el preview entero", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);
    const result = await doctorCommand.execute(
      parseArgv(["doctor", "prepare", "--select", A, "--select", B]),
      ctx,
    );

    expect(result.ok).toBe(true);
    // Sellar NO es un veredicto: nada se tocó todavía, así que la salida es 0
    // incluso cuando el informe que lo produjo bloquea.
    expect(result.exitCode).toBe(0);
    const data = result.data as { kind: string } & DoctorProposal;
    expect(data.kind).toBe("prepare-sealed");
    expect(data.digest).toMatch(DIGEST_SHAPE);
    expect(data.batch.actions.map((action) => action.finding_id)).toEqual([A, B]);
    expect(data.next).toBe(`${APPLY_PREFIX}${data.digest} --select ${A} --select ${B}`);

    // CADA renglón de la vista previa está en el texto: es el mismo objeto, no un
    // resumen de él.
    const text = render(result);
    for (const line of data.preview) expect(text).toContain(line);
    expect(text).toContain(`siguiente: ${data.next}`);
    expect(text.trimEnd().endsWith(`siguiente: ${data.next}`)).toBe(true);
  });

  it("un rechazo sale con ok:false, su código y sin datos", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home);
    const fantasma = doctorFindingId("claude-code", "mcps", "no-existe");

    const unknown = await doctorCommand.execute(
      parseArgv(["doctor", "prepare", "--select", fantasma]),
      ctx,
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("SELECTION_UNKNOWN");
    expect(unknown.error?.message).toContain(fantasma);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.data).toBeUndefined();
    /*
     * Los ids concretos LLEGAN al llamador, no sólo al mensaje.
     *
     * El punto del rechazo es nombrar cuál de los ids que la persona escribió
     * falla, y `/w:doctor` lee `details` —no parsea la prosa— para volver a
     * ofrecer la selección sin el id que sobra. Un `details` perdido, o una
     * cuenta en vez de los ids, deja al llamador con «selección inválida».
     */
    expect(unknown.error?.details).toEqual({
      candidates: [fantasma],
      action: "corré `aw doctor` y elegí un id de los que ese informe lista",
    });

    const inert = await doctorCommand.execute(
      parseArgv(["doctor", "prepare", "--select", MANUAL]),
      ctx,
    );
    expect(inert.ok).toBe(false);
    expect(inert.error?.code).toBe("SELECTION_NOT_ACTIONABLE");
    expect(inert.error?.message).toContain(MANUAL);
    expect(inert.error?.details).toEqual({
      candidates: [MANUAL],
      action: "leé la guía de ese hallazgo en `aw doctor`; seleccionalo sólo si propone una acción",
    });
  });
});
