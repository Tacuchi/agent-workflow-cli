import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import {
  SKILL_DIR_NAME,
  bindHostInvocations,
  selfInstallSkill,
  splitCommandDoc,
} from "../../src/application/self/install-skill.js";
import { type ParsedArgs, parseArgv } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import type { FileSystemPort } from "../../src/ports/file-system.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import type { ResolvedRuntime } from "../../src/runtime/types.js";
import { FakeEnv } from "../helpers/fake-env.js";
import { FakeProcess } from "../helpers/fake-process.js";
import { NoScanFs as RealFs } from "../helpers/real-fs.js";

/**
 * `/w:doctor` en el bundle: los dos techos que lo dejan entrar, y el host que
 * viaja en su invocación.
 *
 * Los techos no son gusto: el presupuesto de contexto mide la MEDIANA de
 * activación sobre todos los comandos y el total de `discovery` sobre sus
 * `description`, y las dos bandas estaban al borde.
 *
 * La regla exacta, porque es la que hace auditable la constante: con 19 comandos
 * la mediana es el DÉCIMO valor ordenado, y los otros 18 dejan el hueco 2519
 * (`fix-git`) → 2537 (`reset`). Así que cualquier `doctor.md` que caiga en ese
 * hueco PASA A SER la mediana, y el objetivo es 2532: a 2533 el gate ya se
 * rompe. `discovery`, por su lado, tenía 145 bytes libres en TODO el bundle.
 *
 * Se fijan acá, sobre el archivo real y con las cifras escritas a mano, porque
 * derivarlas del propio presupuesto haría que un techo movido y un documento
 * crecido se muevan juntos y la prueba siga verde — que es exactamente lo que
 * este gate existe para no permitir.
 */

const BUNDLE = resolve(__dirname, "..", "..", "skills", "w");
const DOC = join(BUNDLE, "commands", "doctor.md");

/** El techo del documento y el de su `description`, en bytes. Escritos a mano. */
const DOC_CEILING = 2532;
const DESCRIPTION_CEILING = 145;

function buildArgs(values: Record<string, string>, flags: string[] = []): ParsedArgs {
  return {
    rest: ["install-skill"],
    plugin: {},
    flags: new Set(flags),
    values: new Map(Object.entries(values)),
    valuesMulti: new Map(),
  };
}

function buildCtx(home: string, fs: FileSystemPort): CliContext {
  const ns = normalizeNamespace("agent-workflow");
  const runtime: ResolvedRuntime = {
    packageName: "@tacuchi/agent-workflow-cli",
    binName: "agent-workflow",
    source: "default",
  };
  return {
    fs,
    env: new FakeEnv(home),
    process: new FakeProcess(),
    git: {} as never,
    namespace: { namespace: ns, source: "default" },
    runtime,
    paths: new PathsService(ns, home, home),
  } as unknown as CliContext;
}

describe("skills/w/commands/doctor.md · los techos del presupuesto", () => {
  const raw = readFileSync(DOC, "utf8");
  const bytes = Buffer.byteLength(raw, "utf8");
  // Con `splitCommandDoc`, el MISMO parser que alimenta `discovery` y que arma
  // cada wrapper — y no con un regex propio. Un regex sobre la línea captura `>-`
  // ante un bloque plegado y da 2 bytes sobre una `description` de cualquier
  // tamaño: el techo quedaría evadible justo en la prueba que la fase declara
  // como su aserción de tamaño.
  const description = splitCommandDoc(raw).description ?? "";

  it(`no pasa de ${DOC_CEILING} bytes`, () => {
    expect(bytes).toBeLessThanOrEqual(DOC_CEILING);
  });

  it(`su description no pasa de ${DESCRIPTION_CEILING} bytes`, () => {
    // `discovery` es la suma de las `description` de todos los comandos, y su
    // banda quedó con exactamente estos bytes libres.
    expect(description.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(DESCRIPTION_CEILING);
  });

  it("no declara más herramientas que las dos que necesita", () => {
    // Un comando de sólo lectura que pidiera Write o Edit contradiría su propia
    // promesa desde el frontmatter, que es lo primero que el host lee.
    const tools = /allowed-tools:\s*\n\s*\[([\s\S]*?)\]/.exec(raw)?.[1] ?? "";
    const named = [...tools.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
    expect(named).toEqual(["Bash", "Read"]);
  });

  it("ata su context-plan al bundle del plugin y no re-deriva ninguna decisión del CLI", () => {
    expect(raw).toContain(
      'aw context-plan --command doctor --signal <s> --root "${CLAUDE_PLUGIN_ROOT}/skills/w"',
    );
    // Los dos enlaces canónicos de structured-choice, y ningún módulo nuevo.
    expect(raw).toContain("../loops/CHASSIS.md#structured-choice-design--batching");
    expect(raw).toContain("../harness/HARNESS.md#harness-binding-matrix");
    expect(raw).toContain("Relay it verbatim");
    expect(raw).toContain("Nothing here is re-derived");
    // Y la degradación va declarada, nunca en silencio.
    expect(raw).toContain("Degradation is declared, never silent");
  });

  it("reparte lo que escribe y lo que no, como lo reparte el CLI", () => {
    // El defecto que atrapa: el documento decía «no writes» sin calificar, en el
    // mismo renglón de contrato que `status.md`, y sus pasos 4 y 5 escriben. El
    // informe sí es de sólo lectura y ni siquiera deja bitácora (main.ts exime
    // del logger a `doctor` SÓLO sin subverbo); `prepare` queda registrado y
    // `apply` reescribe la configuración de los hosts. Una persona que lee la
    // línea de contrato y despacha el documento cree que ninguno de los cinco
    // pasos toca su disco.
    expect(raw).toContain("The report is read-only and leaves no trace");
    expect(raw).toContain("`prepare` seals and is logged");
    expect(raw).toContain("`apply` is the only step that writes");
    expect(raw).toContain("No loop, no session.");
  });

  it("pide la proyección humana en TODAS sus invocaciones", () => {
    // El defecto que atrapa: desde la herramienta Bash de cualquier host la
    // salida es una tubería, y `resolveOutputMode` resuelve JSON. Las palabras que
    // el documento manda relevar —`automatizable`, `impacto`, `acción`— sólo
    // existen en la proyección humana, así que sin el flag el agente recibe mil
    // líneas de JSON y «relevar textualmente» se vuelve volcarlo crudo.
    const invocations = [...raw.matchAll(/`aw doctor[^`]*`/g)].map((match) => match[0]);
    expect(invocations.length).toBeGreaterThanOrEqual(3);
    for (const invocation of invocations) {
      expect(invocation, invocation).toContain("--format human");
    }
  });

  it("distingue lo `automatizable` del contador `accionable`, y nombra el listado autoritativo", () => {
    // El defecto que atrapa: `summary.actionable` cuenta los `manual` también, y
    // un agente que abriera una opción por cada «accionable» ofrecería
    // reparaciones que ningún lote acepta. El conjunto elegible lo da el CLI.
    expect(raw).toContain("aw doctor prepare --format human");
    expect(raw).toContain("`accionable` count also includes manual findings");
    expect(raw).toContain("take the listing, not the count");
  });

  it("avisa que la pasada por defecto conecta los MCP del host", () => {
    // Lo que el documento se callaba: sin `--skip-native`, la categoría de MCPs
    // le pregunta a Claude y a Codex por sus servidores, y Claude los CONECTA
    // para reportar su salud. Una persona que corre el paso 1 por primera vez
    // levanta todos los servidores de dos hosts sin saberlo.
    expect(raw).toContain("--skip-native");
    expect(raw).toContain("which connects them");
    expect(raw).toContain("`omitida`");
  });

  it("su argument-hint nombra los dos subverbos que el propio documento tipea", () => {
    // El defecto que atrapa: decía «(none)» sobre un comando que despacha por
    // posicional y cuyos pasos 4 y 5 usan esos posicionales.
    const hint = /^argument-hint:\s*(.*)$/m.exec(raw)?.[1] ?? "";
    expect(hint).toContain("prepare");
    expect(hint).toContain("apply");
    expect(hint).toContain("--approval");
    expect(hint).toContain("--select");
  });

  it("la mediana MEDIDA queda bajo su objetivo, y se dice quién la fija", async () => {
    // El defecto que atrapa: el techo de este archivo custodia el documento que
    // SOBRA. Con 2524 bytes `doctor.md` pasó a ser la mediana, pero el margen es
    // de la banda entera: `reset.md` (2537) ya está por encima del objetivo y
    // sólo lo salva ser el 11.º valor, y `fix-git.md` (2519) es el 9.º. Fijar la
    // mediana medida es lo que hace que crecer CUALQUIER comando rompa una
    // prueba en vez de romper el gate en la próxima corrida de otra persona.
    const { runContextBudget } = await import("../../src/application/context/budget-service.js");
    const { NodeFileSystem } = await import("../helpers/real-fs.js");
    const result = await runContextBudget(new NodeFileSystem(), { root: BUNDLE });
    const median = result.budget.find((line) => line.metric === "activation.median");

    expect(median?.actual).toBe(bytes);
    expect(median?.actual ?? 0).toBeLessThanOrEqual(DOC_CEILING);
    // Y los dos vecinos que definen el hueco, con sus bytes: si alguno se mueve,
    // esta prueba lo dice antes que el gate.
    const entries = new Map(result.activation.entries.map((e) => [e.command, e.bytes]));
    expect(entries.get("fix-git")).toBe(2519);
    expect(entries.get("reset")).toBe(2537);
  });

  it("el MANIFEST lo declara con su core y sólo módulos ya contabilizados", () => {
    const manifest = JSON.parse(readFileSync(join(BUNDLE, "context", "MANIFEST.json"), "utf8")) as {
      commands: Record<string, { core: string[]; modules: { path: string }[] }>;
    };
    const entry = manifest.commands.doctor;

    expect(entry).toBeDefined();
    expect(entry?.core).toEqual(["commands/doctor.md"]);
    // `PLAN-MODE.md` ya está contabilizado por `status` y `resume`: declarar un
    // módulo nuevo movería la banda de módulos, que este lote no toca.
    expect(entry?.modules.map((module) => module.path)).toEqual(["modules/PLAN-MODE.md"]);
  });
});

/**
 * El host viaja en la invocación, y el destino compartido queda sin atar.
 *
 * `aw doctor` recorre TODOS los hosts y resalta el de la corrida. Sin el binding,
 * el wrapper instalado para un host le dejaría ese papel a lo que dijeran los
 * marcadores de la terminal, y el informe señalaría un host distinto del que la
 * persona invocó. El destino `agents` es el único que se comparte entre hosts, y
 * por eso es el único que NO se ata.
 */
describe("el binding no rompe las invocaciones que el documento enseña", () => {
  it("el flag insertado NO desplaza el subverbo: cada línea del documento sigue parseando", () => {
    // El binding mete `--host <id>` justo después de `doctor`, así que el subverbo
    // queda detrás de un flag CON valor. Si `--host` se comiera el token
    // siguiente, `aw doctor --host codex prepare` correría el informe en vez de
    // preparar — y la persona estaría siguiendo al pie de la letra un documento
    // que le enseña un comando que hace otra cosa. Se comprueba con el parser
    // real sobre las tres invocaciones que el documento nombra.
    const cases: Array<[string[], string[]]> = [
      [["doctor", "--host", "claude-code"], []],
      [["doctor", "--host", "claude-code", "prepare", "--select", "x"], ["prepare"]],
      [["doctor", "--host", "codex", "apply", "--approval", "abc", "--select", "x"], ["apply"]],
      [["doctor", "--host", "oz", "--verify-connection", "prepare"], ["prepare"]],
    ];

    for (const [argv, rest] of cases) {
      const parsed = parseArgv(argv);
      expect(parsed.rest, argv.join(" ")).toEqual(rest);
      expect(parsed.values.get("host"), argv.join(" ")).toBe(argv[2]);
    }
  });

  it("el binding no duplica el flag ni toca lo que no declara", () => {
    // `aw context-plan --command doctor` lleva la palabra `doctor` y NO es una
    // invocación de este comando: atarla dejaría un `--host` en medio de otro
    // comando. Y un documento que ya trajera `--host` recibiría dos.
    //
    // Se llama a la función REAL sobre el cuerpo real. Copiar su regex acá dejaba
    // una prueba que no podía fallar por ningún cambio en producción: con el
    // binding anulado por completo seguía verde, mientras su nombre prometía
    // cubrir justamente eso.
    const raw = readFileSync(DOC, "utf8");
    const body = splitCommandDoc(raw).body;
    const bound = bindHostInvocations(body, "claude");

    expect(bound).not.toContain("--host claude-code --host");
    expect(bound).toContain("aw context-plan --command doctor --signal <s>");
    expect(bound).not.toContain("aw context-plan --host");
    // Las invocaciones del recorrido quedan atadas: una por cada paso que llama
    // al CLI, y ninguna más.
    const invocations = [...bound.matchAll(/aw doctor --host claude-code/g)];
    expect(invocations).toHaveLength(
      [...splitCommandDoc(raw).body.matchAll(/\baw doctor\b/g)].length,
    );
  });
});

describe("instalación · `aw doctor` recibe --host en cada wrapper", () => {
  let home: string;
  let source: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "doctor-bundle-home-"));
    source = await mkdtemp(join(tmpdir(), "doctor-bundle-src-"));
    await mkdir(join(source, "commands"), { recursive: true });
    await mkdir(join(source, "harness"), { recursive: true });
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: agent-workflow\ndescription: Universal skill.\nversion: 1.1.0\n---\n\n# agent-workflow\n",
      "utf8",
    );
    await writeFile(join(source, "harness/HARNESS.md"), "# harness binding\n", "utf8");
    // El documento del fixture llama al CLI de las tres formas que se atan y una
    // que no: `aw status` tiene que quedar intacta.
    await writeFile(
      join(source, "commands/doctor.md"),
      '---\ndescription: Diagnosis across hosts.\nallowed-tools:\n  [\n    "Bash",\n  ]\n---\n\n# doctor\n\nRun `aw doctor`, then `aw doctor prepare --select x`, then `aw flow advance`. Never `aw status`.\n',
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(source, { recursive: true, force: true });
  });

  it("el wrapper nativo de Claude llama `aw doctor --host claude-code`", async () => {
    const fs = new RealFs();
    await selfInstallSkill(buildArgs({ from: source, target: "claude" }), buildCtx(home, fs));

    const wrapper = await readFile(join(home, ".claude/commands/w/doctor.md"), "utf8");

    expect(wrapper).toContain("aw doctor --host claude-code");
    expect(wrapper).toContain("aw doctor --host claude-code prepare --select x");
    // El binding alcanza también a `flow`, que ya estaba.
    expect(wrapper).toContain("aw flow --host claude-code advance");
    // Y no toca lo que no declara: `aw status` sigue sin host.
    expect(wrapper).toContain("aw status");
    expect(wrapper).not.toContain("aw status --host");
  });

  it("la skill sintetizada de Codex llama `aw doctor --host codex`", async () => {
    const fs = new RealFs();
    await selfInstallSkill(buildArgs({ from: source, target: "codex" }), buildCtx(home, fs));

    const synth = await readFile(join(home, ".codex/skills/w-doctor/SKILL.md"), "utf8");

    expect(synth).toContain("aw doctor --host codex");
    expect(synth).toContain("aw doctor --host codex prepare --select x");
  });

  it("el destino compartido `agents` no instala wrapper de comando: no hay nada que atar", async () => {
    // `agents` es un destino, no un host, y no sintetiza comandos: instala el
    // bundle y nada más. Así que la rama «compartido queda sin atar» de
    // `bindHostInvocations` no tiene caso alcanzable por acá — se deja dicho en
    // vez de afirmar una exención que ningún archivo demuestra. Ojo con
    // confundirlo con `oz`, que instala EN `~/.agents/skills` pero sí es un host
    // del catálogo y por lo tanto sí se ata.
    const fs = new RealFs();
    await selfInstallSkill(buildArgs({ from: source, target: "agents" }), buildCtx(home, fs));

    expect(await fs.exists(join(home, ".agents/skills", SKILL_DIR_NAME))).toBe(true);
    expect(await fs.exists(join(home, ".agents/skills/w-doctor"))).toBe(false);
  });

  it("`oz` sí se ata, aunque comparta el directorio con el destino compartido", async () => {
    const fs = new RealFs();
    await selfInstallSkill(buildArgs({ from: source, target: "oz" }), buildCtx(home, fs));

    const synth = await readFile(join(home, ".agents/skills/w-doctor/SKILL.md"), "utf8");

    expect(synth).toContain("aw doctor --host oz");
  });
});
