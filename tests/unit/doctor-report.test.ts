import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../../src/application/doctor/report.js";
import type { DoctorProvider, DoctorProviderInput } from "../../src/application/doctor/types.js";
import { coverage } from "../../src/application/doctor/types.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { CliContext } from "../../src/cli/types.js";
import {
  DOCTOR_CATEGORIES,
  DOCTOR_SCHEMA_VERSION,
  type DoctorCategory,
  type DoctorFinding,
  doctorFindingId,
} from "../../src/domain/doctor/model.js";
import { HARNESSES } from "../../src/domain/harnesses.js";
import type { DirEntry, FileStat, FileSystemPort, LinkStat } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { MemFs } from "../helpers/mem-fs.js";

/**
 * El agregador `runDoctor`: la condición de salida de F1 y las garantías que
 * ningún proveedor individual puede sostener por su cuenta.
 *
 * Cuatro cosas se fijan acá porque son transversales y se rompen en silencio:
 * un diagnóstico que ESCRIBE (AC-04) deja de ser un diagnóstico y ya nadie lo
 * corre a ciegas; un host ausente convertido en hallazgo enseña a saltearse la
 * sección de hallazgos (AC-15); un proveedor que se cae devolviendo 0 se lee
 * como «entorno sano», que es lo único que un doctor nunca puede decir por
 * accidente (AC-14); y un orden inestable hace que dos corridas del mismo
 * entorno produzcan un diff que nadie puede leer.
 */

const NS = normalizeNamespace("workflow");

const RUNTIME: ResolvedRuntime = {
  packageName: "@tacuchi/agent-workflow-cli",
  binName: "agent-workflow",
  source: "default",
};

/** La versión sale del package.json, no del informe: un assert tautológico no fija nada. */
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")) as {
    version: string;
  }
).version;

/** Orden del catálogo — la misma fuente que el informe dice respetar. */
const CATALOG_ORDER = HARNESSES.map((spec) => spec.id);

/** Invocaciones nativas que el contrato admite, con sus args exactos. */
const NATIVE_READ_ONLY_CALLS = [
  { command: "claude", argv: "mcp list" },
  { command: "codex", argv: "mcp list --json" },
];

/**
 * Las invocaciones completas —binario Y args— que la fase diagnóstica admite.
 *
 * Se juzga el par y no la argv sola porque `--version` es inocente en `claude` y
 * no dice nada sobre qué binario se corrió: un instalador invocado con una argv
 * de la lista atravesaría un allowlist que descarta el comando.
 */
const READ_ONLY_CALLS = new Set([
  // Los binarios que el catálogo declara, sondeados con `--version` y nada más.
  ...HARNESSES.flatMap((spec) => spec.runtime?.bins ?? []).map((binary) => `${binary} --version`),
  ...NATIVE_READ_ONLY_CALLS.map((call) => `${call.command} ${call.argv}`),
]);

/**
 * FileSystemPort que DELEGA lectura y sólo REGISTRA mutación.
 *
 * Envuelve el `MemFs` compartido en vez de reimplementarlo: lo único que agrega
 * es el registro, porque `MemFs.writes` sólo ve `writeText` y AC-04 promete que
 * el doctor no crea, borra, copia ni enlaza NADA por ninguna vía del puerto.
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

/**
 * Dos hosts participan y seis quedan ausentes, y el estado NO se inyecta: sale
 * de `reportAllHostStates` leyendo este doble, que es el camino real.
 *
 * claude-code queda `ready` (binario en PATH + bundle instalado) y codex
 * `installable` (binario en PATH, sin bundle). El resto no tiene ni binario ni
 * dir de config, así que el catálogo los declara `absent`.
 */
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

/** El ProcessPort del doctor: registra TODO lo que se ejecuta (`calls`). */
function fakeProcess(): FakeProcess {
  return new FakeProcess({
    which: (cmd) => HOST_BINS[cmd],
    run: () => ({ code: 0, stdout: "9.9.9", stderr: "" }),
  });
}

function makeCtx(
  fs: FileSystemPort,
  home: string,
  root: string,
  process: FakeProcess = fakeProcess(),
): CliContext {
  return {
    fs,
    env: new FakeEnv(home, root),
    process,
    paths: new PathsService(NS, home, root),
    namespace: { namespace: NS, source: "default" },
    runtime: RUNTIME,
    skills: { roles: {}, source: "default" },
  } as unknown as CliContext;
}

function findingFor(
  host: string,
  category: DoctorCategory,
  name: string,
  over: Partial<DoctorFinding> = {},
): DoctorFinding {
  return {
    id: doctorFindingId(host, category, name),
    host,
    category,
    resource: { kind: "sonda", name, locator: null },
    state: "healthy",
    summary: `estado de ${name}`,
    impact: "ninguno",
    evidence: [],
    ownership: "n/a",
    remediation: { kind: "none", action: null, guidance: [] },
    ...over,
  };
}

/** Proveedor doble: un hallazgo y una cobertura por host participante. */
function perHostProvider(
  category: DoctorCategory,
  opts: { seen?: string[][]; reverse?: () => boolean } = {},
): DoctorProvider {
  return {
    category,
    async run(input: DoctorProviderInput) {
      opts.seen?.push(input.hosts.map((host) => host.host));
      const hosts = input.hosts.map((host) => host.host);
      const ordered = opts.reverse?.() === true ? [...hosts].reverse() : hosts;
      return {
        coverage: ordered.map((host) => coverage(category, host, "checked")),
        findings: ordered.map((host) => findingFor(host, category, "recurso")),
      };
    },
  };
}

describe("runDoctor", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "doctor-report-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  /**
   * AC-04, y es la prueba transversal del lote: el doctor DIAGNOSTICA, no repara.
   *
   * Corre con los proveedores REALES —un doble que no escribe no probaría nada—
   * y vigila las TRES vías por las que un proveedor podría mutar: el puerto de
   * archivos (registrado entero, no sólo `writeText`), el disco de verdad
   * —varios lectores de este camino usan `node:fs` directo y esquivarían el
   * puerto— y el ProcessPort, que en un doctor multihost es la vía más probable
   * de todas: mutar el entorno no es escribir un archivo, es invocar el CLI del
   * host (`claude mcp add`, `codex mcp remove`, `npm i -g`).
   */
  it("no escribe NADA: ni por el puerto, ni en el disco real, ni ejecutando un comando (AC-04)", async () => {
    const recording = new RecordingFs(hostStateFs(home));
    const before = treeOf(home);
    const proc = fakeProcess();
    const asked: { command: string; argv: string }[] = [];

    const report = await runDoctor(
      makeCtx(recording, home, home, proc),
      {},
      { mcps: { native: { run: (command, args) => nativeFixtureRun(command, args, asked) } } },
    );

    // La lectura nativa se hizo (sobre los fixtures congelados, nunca spawneando
    // el binario de la máquina), así que el proveedor de MCP recorrió su camino
    // completo y no una rama corta que no escribiría igual. Y se afirman los
    // ARGS, no sólo el binario: `readNativeMcpState` podría pedir `mcp add` y un
    // doble que descarta los args lo dejaría pasar.
    expect(asked).toEqual(NATIVE_READ_ONLY_CALLS);

    // Todo lo que se ejecutó —por el puerto y por el runner nativo— es de sólo
    // lectura, y se juzga el COMANDO JUNTO CON SUS ARGS. Colapsar la vía del
    // puerto a su argv dejaba pasar cualquier binario con una argv de la lista:
    // `npm --version` y `algo-que-instala --version` se leían igual.
    const executed = [
      // El binario llega RESUELTO (`/usr/local/bin/claude`), así que se juzga su
      // nombre: la ruta la eligió `which`, el nombre y los args los eligió el
      // código bajo prueba.
      ...proc.calls.map((call) => `${basename(call.cmd)} ${call.args.join(" ")}`.trim()),
      ...asked.map((call) => `${basename(call.command)} ${call.argv}`),
    ];
    // La vía del PUERTO no puede estar vacía: `reportAllHostStates` sondea el
    // runtime de cada host con `<bin> --version`, así que cero llamadas
    // significaría que el diagnóstico se cortó antes de mirar y «no escribió»
    // sería cierto por no haber hecho nada.
    expect(proc.calls.length).toBeGreaterThan(0);
    expect(executed.filter((call) => !READ_ONLY_CALLS.has(call))).toEqual([]);

    expect(recording.mutations).toEqual([]);
    expect(treeOf(home)).toEqual(before);
    // Y el diagnóstico ocurrió de verdad: las seis categorías informaron
    // cobertura. Sin esto, «no escribió» se cumpliría también si todo se hubiera
    // caído antes de mirar.
    expect([...new Set(report.coverage.map((entry) => entry.category))].sort()).toEqual(
      [...DOCTOR_CATEGORIES].sort(),
    );
    expect(report.coverage.filter((entry) => entry.state === "unavailable")).toEqual([]);
  });

  /**
   * AC-15: un host ausente se ENUMERA y no se diagnostica.
   *
   * El defecto que cierra es el inverso del intuitivo: convertir «no tenés kimi
   * en esta máquina» en una advertencia llena el informe de ruido permanente y
   * entrena a la persona a saltear la sección donde viven los bloqueos reales.
   */
  it("participan ready e installable; el ausente se enumera y no genera hallazgos (AC-15)", async () => {
    const seen: string[][] = [];
    const report = await runDoctor(
      makeCtx(new RecordingFs(hostStateFs(home)), home, home),
      {},
      { providers: [perHostProvider("mcps", { seen })] },
    );

    expect(report.hosts.map((host) => host.host)).toEqual(["claude-code", "codex"]);
    expect(report.hosts.map((host) => host.status)).toEqual(["ready", "installable"]);

    const absent = CATALOG_ORDER.filter((id) => id !== "claude-code" && id !== "codex");
    expect(report.hosts_absent).toEqual(absent);

    // Ni el proveedor los vio, ni el informe habla de ellos por ningún lado.
    expect(seen).toEqual([["claude-code", "codex"]]);
    for (const host of absent) {
      expect(report.findings.filter((finding) => finding.host === host)).toEqual([]);
      expect(report.coverage.filter((entry) => entry.host === host)).toEqual([]);
    }
    expect(report.summary.warning).toBe(0);
  });

  /**
   * AC-14: un proveedor que revienta no se lleva el informe puesto, y sobre todo
   * no se lleva puesto el veredicto.
   *
   * Un doctor que devuelve 0 después de NO haber podido mirar es peor que uno
   * que no dice nada: la persona lee el cero como salud. Así que la categoría
   * caída queda `unavailable` CON la razón en cada host participante, el resto
   * de los proveedores entrega igual, y la salida es 1.
   */
  it("un proveedor que lanza deja su categoría unavailable con razón y fuerza salida 1 (AC-14)", async () => {
    const boom: DoctorProvider = {
      category: "skills",
      async run() {
        throw new Error("EACCES al leer el índice de skills");
      },
    };

    const report = await runDoctor(
      makeCtx(new RecordingFs(hostStateFs(home)), home, home),
      {},
      { providers: [boom, perHostProvider("mcps")] },
    );

    const fallen = report.coverage.filter((entry) => entry.category === "skills");
    expect(fallen.map((entry) => entry.host)).toEqual(["claude-code", "codex"]);
    for (const entry of fallen) {
      expect(entry.state).toBe("unavailable");
      expect(entry.reason).toContain("EACCES al leer el índice de skills");
    }

    // El proveedor sano entregó igual: la caída de uno no cancela a los demás.
    expect(report.findings.map((finding) => finding.id)).toEqual([
      "claude-code/mcps/recurso",
      "codex/mcps/recurso",
    ]);
    expect(report.coverage.filter((entry) => entry.category === "mcps")).toHaveLength(2);

    expect(report.verdict.exit_code).toBe(1);
    expect(report.verdict.reason).toContain("skills");
  });

  /**
   * AC-14, su peor caso: CERO hosts participantes.
   *
   * `--only` sobre un host que no está en esta máquina (y una máquina sin ningún
   * host se ve igual) deja la selección vacía. Si la cobertura de un proveedor
   * caído se emitiera «una por host participante» a secas, no habría NINGUNA
   * cobertura `unavailable`, `doctorVerdict` no vería ni bloqueos ni caídas y el
   * informe saldría 0: el doctor que devuelve 0 después de no haber podido
   * mirar. La caída se ancla en `workspace`, que existe siempre.
   */
  it("con CERO hosts participantes la caída se ancla en workspace y NO sale 0 (AC-14)", async () => {
    const boom: DoctorProvider = {
      category: "skills",
      async run() {
        throw new Error("EACCES al leer el índice de skills");
      },
    };

    const report = await runDoctor(
      makeCtx(new RecordingFs(hostStateFs(home)), home, home),
      // kimi no está instalado en este entorno: la selección queda vacía.
      { only: ["kimi"] },
      { providers: [boom] },
    );

    expect(report.hosts).toEqual([]);
    expect(report.hosts_absent).toEqual(["kimi"]);
    expect(
      report.coverage.map((entry) => `${entry.category}/${entry.host}/${entry.state}`),
    ).toEqual(["skills/workspace/unavailable"]);
    expect(report.coverage[0]?.reason).toContain("EACCES al leer el índice de skills");
    expect(report.verdict.exit_code).toBe(1);
  });

  /**
   * AC-02: un `--only` que el catálogo no declara se DENUNCIA, y la corrida que
   * no pudo mirar nada no declara el entorno sano.
   *
   * `claude` es la trampa natural: es el id de host MCP que TODOS los demás
   * comandos toman (`aw mcp setup --host claude`), pero el catálogo de hosts lo
   * llama `claude-code`. El filtro lo descartaba en silencio, los proveedores
   * que derivan su alcance de los hosts participantes devolvían CERO filas,
   * ninguna cobertura quedaba `unavailable` y el informe salía 0 con tres
   * categorías que nunca declararon nada: el doctor que devuelve 0 después de no
   * haber podido mirar.
   */
  it("un --only que el catálogo no declara se denuncia y la corrida no sale 0 (AC-02)", async () => {
    const report = await runDoctor(
      makeCtx(new RecordingFs(hostStateFs(home)), home, home),
      { only: ["claude"] },
      { providers: [perHostProvider("mcps")] },
    );

    expect(report.hosts).toEqual([]);
    const denounced = report.findings.find(
      (finding) => finding.id === "workspace/installation-hosts/--only=claude",
    );
    expect(denounced?.state).toBe("blocking");
    // La sugerencia sale del CATÁLOGO: este módulo no cablea ninguna tabla de
    // alias propia que después se desincronice del catálogo real.
    expect(denounced?.evidence.join(" | ")).toContain("claude-code");
    expect(denounced?.remediation.guidance).toEqual(["repetí la corrida con --only claude-code"]);

    // Y la categoría que no tuvo nada que mirar declara su hueco CON la razón,
    // en vez de desaparecer del informe. El estado es `not-applicable` y NO
    // `unavailable`: no había nada que comprobar, que no es lo mismo que no
    // haber podido. Lo que pone la corrida en 1 es el hallazgo bloqueante del
    // filtro inexistente, que es la causa verdadera.
    expect(
      report.coverage.map((entry) => `${entry.category}/${entry.host}/${entry.state}`),
    ).toEqual(["mcps/workspace/not-applicable"]);
    expect(report.coverage[0]?.reason).toContain("claude");
    expect(report.verdict.exit_code).toBe(1);
    expect(report.verdict.reason).toContain("--only=claude");
  });

  /**
   * Un id LEGÍTIMO que no está en esta máquina: acá no hay nada que denunciar
   * sobre el nombre —`kimi` existe en el catálogo— y tampoco hay nada que
   * comprobar. La categoría igual declara su hueco con la razón, y el veredicto
   * es 0: un host sin rastro no es una advertencia (AC-01), y marcar la corrida
   * en rojo pondría en 1 la máquina de cualquiera que sólo tenga un host que
   * este motor no mira.
   */
  it("con --only sobre un host ausente ninguna categoría queda muda, y no se inventa un rojo", async () => {
    const report = await runDoctor(
      makeCtx(new RecordingFs(hostStateFs(home)), home, home),
      { only: ["kimi"] },
      { providers: [perHostProvider("mcps"), perHostProvider("skills")] },
    );

    expect(report.hosts).toEqual([]);
    expect(report.hosts_absent).toEqual(["kimi"]);
    // Ningún hallazgo inventado: el nombre era válido, sólo que el host no está.
    expect(report.findings).toEqual([]);
    expect(
      report.coverage.map((entry) => `${entry.category}/${entry.host}/${entry.state}`),
    ).toEqual(["mcps/workspace/not-applicable", "skills/workspace/not-applicable"]);
    for (const entry of report.coverage) {
      expect(entry.reason).toContain("ningún host participa");
    }
    expect(report.verdict.exit_code).toBe(0);
    // Y el hueco sigue VISIBLE, que es lo que AC-15 pide: sano sólo dentro de la
    // cobertura comprobada, y acá no se comprobó nada.
    expect(report.coverage.every((entry) => entry.state !== "checked")).toBe(true);
  });

  /**
   * El caso extremo del mismo eje, y el que la regresión hacía rojo: una máquina
   * SIN ningún host de agente instalado. Antes salía 0, el relleno de silencio la
   * puso en 1, y ninguna prueba lo cubría.
   */
  it("una máquina sin ningún host de agente sale 0 y enumera los ocho como ausentes", async () => {
    const report = await runDoctor(
      // Ni configuración de ningún host ni binario que `which` resuelva: la
      // máquina limpia de verdad.
      makeCtx(
        new RecordingFs(new MemFs()),
        home,
        home,
        new FakeProcess({ which: () => undefined }),
      ),
      { skipNative: true },
      { providers: [perHostProvider("mcps"), perHostProvider("installation-hosts")] },
    );

    expect(report.hosts).toEqual([]);
    expect(report.hosts_absent.length).toBeGreaterThan(0);
    expect(report.findings).toEqual([]);
    for (const entry of report.coverage) {
      expect(entry.state).toBe("not-applicable");
      expect(entry.reason).toContain("ningún host participa");
    }
    expect(report.verdict.exit_code).toBe(0);
  });

  /**
   * El orden es contrato, no casualidad de iteración.
   *
   * Los proveedores entran en orden INVERSO al del contrato y el segundo pase
   * emite sus hosts al revés que el primero: si el agregador se apoyara en el
   * orden de llegada, las dos corridas diferirían y el diff del informe sería
   * ilegible. Lo esperado sale de DOCTOR_CATEGORIES y del orden del catálogo.
   */
  it("dos corridas sobre el mismo estado dan findings y coverage idénticos", async () => {
    let call = 0;
    const providers = [
      perHostProvider("mcps", { reverse: () => call % 2 === 1 }),
      perHostProvider("installation-hosts", { reverse: () => call % 2 === 1 }),
    ];
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home, home);

    const first = await runDoctor(ctx, {}, { providers });
    call += 1;
    const second = await runDoctor(ctx, {}, { providers });

    expect(second.findings).toEqual(first.findings);
    expect(second.coverage).toEqual(first.coverage);

    // Host primero, categoría del contrato después: el orden concreto también
    // se fija, porque «iguales entre sí» admitiría dos corridas igual de mal
    // ordenadas.
    expect(first.findings.map((finding) => finding.id)).toEqual([
      "claude-code/installation-hosts/recurso",
      "claude-code/mcps/recurso",
      "codex/installation-hosts/recurso",
      "codex/mcps/recurso",
    ]);
    expect(first.coverage.map((entry) => `${entry.category}/${entry.host}`)).toEqual([
      "installation-hosts/claude-code",
      "installation-hosts/codex",
      "mcps/claude-code",
      "mcps/codex",
    ]);
  });

  /**
   * Lo que el agregador le PASA a cada proveedor, que es lo que ningún proveedor
   * puede verificar por su cuenta.
   *
   * `hostStates` existe para no re-sondear (cada sonda tiene techo de 2.5 s), así
   * que llega vacío sin que nada se rompa; `currentHost` es lo que cada proveedor
   * usa para resaltar y podría ser siempre null aunque `scope.current_host`, que
   * se calcula aparte, esté bien; y `workspaceDir` decide qué árbol se mira. Los
   * tres se rompen en silencio: los seis proveedores reales producen un informe
   * byte-idéntico con este input destruido.
   */
  it("cada proveedor recibe el catálogo completo, el host invocante y el workspace", async () => {
    const workspace = join(home, "proyecto");
    let seen: DoctorProviderInput | null = null;
    const capturing: DoctorProvider = {
      category: "workspace-visibility",
      async run(input) {
        seen = input;
        return { coverage: [], findings: [] };
      },
    };

    const report = await runDoctor(
      makeCtx(new RecordingFs(hostStateFs(home)), home, workspace),
      { host: "codex" },
      { providers: [capturing] },
    );

    // Los ESTADOS son todo el catálogo, los HOSTS sólo los que participan: si
    // fueran lo mismo, un proveedor diagnosticaría hosts ausentes.
    expect(seen?.hostStates.map((state) => state.host)).toEqual(CATALOG_ORDER);
    expect(seen?.hosts.map((host) => host.host)).toEqual(["claude-code", "codex"]);
    expect(seen?.currentHost).toBe("codex");
    expect(seen?.workspaceDir).toBe(workspace);
    expect(seen?.skipNative).toBe(false);
    // El mismo workspace que el proveedor recibió es el que el informe declara.
    expect(report.scope.workspace_dir).toBe(workspace);
  });

  /**
   * `--skip-native`: la tercera opción pública, y su efecto observable no es
   * «nada», es una cobertura DEGRADADA.
   *
   * Declinar la consulta nativa no puede pasar por `checked`: eso diría que el
   * estado del host se comprobó cuando nadie lo miró.
   */
  it("--skip-native no consulta al host y deja la cobertura skipped con su razón", async () => {
    const asked: { command: string; argv: string }[] = [];

    const report = await runDoctor(
      makeCtx(new RecordingFs(hostStateFs(home)), home, home),
      { skipNative: true },
      { mcps: { native: { run: (command, args) => nativeFixtureRun(command, args, asked) } } },
    );

    expect(asked).toEqual([]);
    const mcps = report.coverage.filter((entry) => entry.category === "mcps");
    expect(mcps.map((entry) => `${entry.host}/${entry.state}`)).toEqual([
      "claude-code/skipped",
      "codex/skipped",
    ]);
    for (const entry of mcps) expect(entry.reason).toContain("--skip-native");
  });

  /** Un consumidor tiene que poder versionar el esquema y atribuir el informe a un CLI. */
  it("sella schema_version 1, la versión del CLI publicada y un veredicto 0 sin hallazgos", async () => {
    const report = await runDoctor(
      makeCtx(new RecordingFs(hostStateFs(home)), home, home),
      {},
      { providers: [] },
    );

    expect(report.schema_version).toBe(1);
    expect(report.schema_version).toBe(DOCTOR_SCHEMA_VERSION);
    expect(report.cli_version).toBe(PACKAGE_VERSION);
    // Sin esto, un veredicto cableado a 1 sobreviviría el archivo entero: un
    // doctor que siempre falla es tan inútil como uno que siempre aprueba.
    expect(report.verdict.exit_code).toBe(0);
  });

  /**
   * AC-11: la redacción es del AGREGADOR, no de cada proveedor.
   *
   * Un proveedor lee archivos de configuración ajenos y ahí vive cualquier cosa;
   * confiar en que cada uno recuerde tapar credenciales es exactamente cómo se
   * filtra una. La DSN de acá es inventada.
   */
  it("tapa un secreto con forma de DSN que un proveedor trajo en la evidencia (AC-11)", async () => {
    const leak = "postgres://user:SUPERSECRETO@host/db";
    const leaky: DoctorProvider = {
      category: "tools-auth",
      async run() {
        return {
          coverage: [coverage("tools-auth", "workspace", "checked")],
          findings: [
            findingFor("workspace", "tools-auth", "conexion", {
              state: "warning",
              evidence: [`la entrada declara ${leak}`],
            }),
          ],
        };
      },
    };

    const report = await runDoctor(
      makeCtx(new RecordingFs(hostStateFs(home)), home, home),
      {},
      { providers: [leaky] },
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("SUPERSECRETO");
    // El hallazgo sigue estando: se tapa el valor, no se descarta la evidencia.
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.evidence[0]).toBe("la entrada declara postgres://***");
  });

  /**
   * `--host` y `--only` responden preguntas distintas y plegarlas fue un defecto
   * real: el host invocante terminaba ocultando a todos los demás.
   */
  it("--host resalta sin filtrar y --only sí filtra, y ambos quedan en scope", async () => {
    const ctx = makeCtx(new RecordingFs(hostStateFs(home)), home, home);

    const highlighted = await runDoctor(ctx, { host: "codex" }, { providers: [] });
    expect(highlighted.scope.current_host).toBe("codex");
    expect(highlighted.scope.only).toEqual([]);
    expect(highlighted.hosts.map((host) => host.host)).toEqual(["claude-code", "codex"]);
    expect(highlighted.hosts.map((host) => host.current)).toEqual([false, true]);

    const restricted = await runDoctor(
      ctx,
      { host: "codex", only: ["codex"] },
      { providers: [perHostProvider("mcps")] },
    );
    expect(restricted.scope.only).toEqual(["codex"]);
    expect(restricted.hosts.map((host) => host.host)).toEqual(["codex"]);
    expect(restricted.findings.map((finding) => finding.host)).toEqual(["codex"]);

    // Un nombre que no está en el catálogo no se refleja como si lo estuviera:
    // el scope diría que la corrida se hizo desde un host que no existe.
    const unknown = await runDoctor(ctx, { host: "no-such-host" }, { providers: [] });
    expect(unknown.scope.current_host).toBeNull();
    expect(unknown.hosts.every((host) => !host.current)).toBe(true);
  });
});

/**
 * La lectura nativa, servida desde los fixtures congelados.
 *
 * `readNativeMcpState` spawnea `claude mcp list` / `codex mcp list` con
 * `node:child_process` DIRECTO, sin pasar por `ctx.process`: sin este doble una
 * prueba de solo-lectura terminaría conectando los servidores MCP reales de
 * quien la corre.
 */
function nativeFixtureRun(
  command: string,
  args: readonly string[],
  asked: { command: string; argv: string }[],
): {
  status: number;
  stdout: string;
  errorCode: null;
  timedOut: false;
} {
  // Los args se REGISTRAN: descartarlos convertiría este doble en cómplice de
  // una escritura (`mcp add`) disfrazada de lectura.
  asked.push({ command, argv: args.join(" ") });
  const file = command === "codex" ? "codex-mcp-list.json" : "claude-mcp-list.txt";
  const stdout = readFileSync(new URL(`../fixtures/doctor/${file}`, import.meta.url), "utf-8");
  return { status: 0, stdout, errorCode: null, timedOut: false };
}

/** Listado recursivo y ordenado de un árbol real: la huella que AC-04 no puede cambiar. */
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
