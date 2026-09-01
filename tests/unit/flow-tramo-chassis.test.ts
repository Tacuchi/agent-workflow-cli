import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKLINE_FLOWS, type WorklineFlow } from "../../src/application/capability/compose.js";
import { advanceFlowRun, resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import {
  CHASSIS_SCOPE,
  COMMAND_EXCLUSIONS,
  DOCS_BOUNDARY,
  FLOW_DECISIONS,
  type FlowDecision,
  RUN_PLACEMENTS,
  commandOfScope,
  decisionsOfScope,
  flowOfScope,
  journeyOfFlow,
  placementOf,
  realizationOf,
} from "../../src/domain/flow/authority.js";
import { PAUSE_LABEL, STOP_LABEL } from "../../src/domain/flow/directive.js";
import { docsBoundaryBreach } from "../../src/domain/flow/rules.js";
import { MAX_BOUNDARY_ATTEMPTS, newRunState } from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * El tramo transversal — y por qué no se migró como se migró un flow.
 *
 * El recorrido que camina una corrida es UNA lista, y hasta esta fase era
 * `decisionsOfScope(flow)`: ninguna fila del chasis la alcanzaba, porque
 * `chassis` no es un `WorklineFlow`. Voltearlas a `cli-owned` sin más habría
 * dejado veintitrés superficies sin consumidor — exactamente el defecto que las
 * revisiones de F11 y F12 ya retiraron dos veces en este plan.
 *
 * Así que la propiedad se afirma POR FORMA, y esta prueba verifica cuál:
 *
 * 1. **Atravesada por el recorrido.** La fila declara su posición y se compone
 *    en la jornada de los cinco flows; una corrida real la cruza. Las dos del
 *    prefijo no existían en el código: fijan la carpeta escribible y el tope de
 *    intentos, y el motor las hace cumplir en cada frontera.
 * 2. **Atribuida al mecanismo que ya la realiza.** Un símbolo de este motor, o
 *    las filas de flow que la instancian. Verificado en las dos direcciones.
 * 3. **Contratada en su propio comando.** Las que deciden a qué línea pertenece
 *    un prompt ocurren ANTES de que exista una corrida, y la compactación
 *    dispara en cualquier frontera: ninguna es un paso de una jornada.
 *
 * Y la regla que sostiene las tres: una fila `cli-owned` sin consumidor es un
 * defecto, no un avance.
 */

const fs = new NodeFileSystem();
const SESSION = "008-tramo-chassis-quick";
const CODE = "008";
const SRC = resolve(__dirname, "..", "..");

const transversal = decisionsOfScope(CHASSIS_SCOPE);

describe("forma (a) — atravesada por el recorrido", () => {
  it("cada fila con posición declarada se compone en las CINCO jornadas", () => {
    const placed = transversal.filter((row) => placementOf(row) !== null);
    expect(placed.map((row) => row.id)).toEqual([
      "chassis.docs-boundary",
      "chassis.research-exhaustion",
      "chassis.finalize",
    ]);
    for (const flow of WORKLINE_FLOWS) {
      const ids = journeyOfFlow(flow).map((row) => row.id);
      for (const row of placed) expect(ids, `${flow} / ${row.id}`).toContain(row.id);
    }
  });

  it("el prefijo va antes del primer paso propio y el sufijo después del último", () => {
    for (const flow of WORKLINE_FLOWS) {
      const journey = journeyOfFlow(flow);
      const own = decisionsOfScope(flow).map((row) => row.id);
      const at = (id: string): number => journey.findIndex((row) => row.id === id);
      const first = at(own[0] as string);
      const last = at(own[own.length - 1] as string);
      expect(at("chassis.docs-boundary"), flow).toBeLessThan(first);
      expect(at("chassis.research-exhaustion"), flow).toBeLessThan(first);
      // La carpeta escribible se fija ANTES de que se emita ningún paso que
      // escriba: resuelta después sería una regla contra escrituras ya hechas.
      expect(at("chassis.finalize"), flow).toBeGreaterThan(last);
    }
  });

  it("la jornada compuesta es exactamente prefijo + propias + sufijo, sin duplicar nada", () => {
    for (const flow of WORKLINE_FLOWS) {
      const journey = journeyOfFlow(flow);
      const ids = journey.map((row) => row.id);
      expect(new Set(ids).size, flow).toBe(ids.length);
      expect(journey).toHaveLength(decisionsOfScope(flow).length + 3);
    }
  });

  it("cada posición declarada sale del vocabulario cerrado", () => {
    // Igual que autoridad y propiedad: una posición fuera del conjunto sería una
    // fila que el compositor no sabe dónde poner, y la pondría en ningún lado.
    for (const row of transversal) {
      const placement = placementOf(row);
      if (placement === null) continue;
      expect(RUN_PLACEMENTS, row.id).toContain(placement);
    }
  });

  it("ninguna fila transversal sin posición se cuela en un recorrido", () => {
    const unplaced = transversal.filter((row) => placementOf(row) === null).map((row) => row.id);
    for (const flow of WORKLINE_FLOWS) {
      const ids = new Set(journeyOfFlow(flow).map((row) => row.id));
      for (const id of unplaced) expect(ids.has(id), `${flow} / ${id}`).toBe(false);
    }
  });
});

describe("la frontera de escritura de docs/: ningún target la cruza", () => {
  const action = (target: string, args: string[] = []) => ({
    invocation: { program: "aw", args, target, input: null },
    evidence: ["algo"],
    idempotent: true,
    recovery: "recuperación",
  });

  it("cada flow declara su carpeta, y `quick` declara NINGUNA", () => {
    expect(DOCS_BOUNDARY.quick).toEqual([]);
    expect(DOCS_BOUNDARY["plan-exec"]).toContain("docs/plans");
    expect(DOCS_BOUNDARY["spec-refine"]).toContain("docs/specs");
    // Exhaustivo sobre los cinco: una entrada faltante y el flow caería en un
    // default, que es justamente lo que un límite no puede tener.
    for (const flow of WORKLINE_FLOWS) expect(DOCS_BOUNDARY[flow], flow).toBeDefined();
  });

  it("se mira la invocación ENTERA, no solo el target", () => {
    // El defecto que esto evita: la ruta que un comando escribe suele viajar en
    // un argumento, y una frontera que solo mirara el target dejaría pasar
    // `--out docs/manuals` con target `.`.
    expect(docsBoundaryBreach(action("."), "plan-exec")).toBeNull();
    expect(docsBoundaryBreach(action("docs/plans"), "plan-exec")).toBeNull();
    expect(docsBoundaryBreach(action("docs/manuals"), "plan-exec")).toBe("docs/manuals");
    expect(docsBoundaryBreach(action(".", ["export", "--out", "docs/manuals"]), "plan-exec")).toBe(
      "docs/manuals",
    );
    // `quick` no escribe ninguna: hasta la del flow vecino es una violación.
    expect(docsBoundaryBreach(action("docs/plans"), "quick")).toBe("docs/plans");
  });

  it("una fila que la cruza NO se emite: bloquea nombrando la carpeta y la salida", () => {
    const journey: FlowDecision[] = [
      {
        id: "fixture.exporta",
        scope: "quick",
        title: "escribir fuera de la carpeta del flow",
        authority: "cli",
        ownership: "cli-owned",
        document: "loops/quick-loop/LOOP.md",
        attribution: "aw flow advance",
        effects: ["local_additive"],
        action: action("docs/manuals"),
      },
    ];
    const result = advanceFlowRun({ state: newRunState("quick", SESSION), journey });
    if (!result.ok) throw new Error(`esperaba una frontera: ${result.failure.code}`);
    expect(result.directive.boundary.kind).toBe("blocked");
    expect(result.directive.error?.code).toBe("FLOW_DOCS_BOUNDARY_CROSSED");
    expect(result.directive.error?.message).toContain("docs/manuals");
    // Y la salida es la que el chasis manda: promover es un `export-*` aparte.
    expect(result.directive.error?.action).toContain("export-*");
    // Nada emitido y nada aplicado: una invocación que nadie debe correr no se
    // muestra, igual que un placeholder sin ligar.
    expect(result.directive.action).toBeNull();
    expect(result.directive.applied).toEqual([]);
  });

  it("ninguna acción del registro vivo cruza la frontera de su flow", () => {
    const offenders: string[] = [];
    for (const flow of WORKLINE_FLOWS) {
      for (const row of journeyOfFlow(flow)) {
        if (row.action === undefined) continue;
        const outside = docsBoundaryBreach(row.action, flow);
        if (outside !== null) offenders.push(`${flow} / ${row.id} → ${outside}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("el tope de intentos: la frontera degrada en vez de repetirse", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-chassis-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — prueba\n\n## Objective\nprobar\n",
      "utf8",
    );
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const statePath = (): string => join(paths.cwdSessionsDir(), SESSION, ".flow-run.json");

  async function seal(): Promise<string> {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return resolveBoundary(read.state, journeyOfFlow(read.state.flow)).seal;
  }

  /**
   * Una respuesta que la frontera rechaza: gasta un intento y no resuelve nada.
   *
   * El payload VARÍA en cada llamada a propósito. Un reenvío idéntico es un
   * reenvío —el mismo intento mandado dos veces— y el motor lo contesta como
   * tal; lo que el tope cuenta son intentos distintos de resolver lo mismo.
   */
  let tried = 0;
  async function refused(): Promise<{ code: string; action: string }> {
    tried += 1;
    const result = await submitFlow(fs, paths, {
      code: CODE,
      raw: JSON.stringify({ input_digest: await seal(), signals: [`quick.inventada-${tried}`] }),
      approval: null,
    });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
    return {
      code: result.directive.error?.code ?? "",
      action: result.directive.error?.action ?? "",
    };
  }

  it("los primeros intentos contestan su motivo; el que pasa el tope degrada", async () => {
    for (let attempt = 1; attempt < MAX_BOUNDARY_ATTEMPTS; attempt += 1) {
      expect((await refused()).code, `intento ${attempt}`).toBe("FLOW_SIGNAL_UNKNOWN");
    }
    // El que alcanza el tope ya no vuelve a preguntar lo mismo: degrada.
    const degraded = await refused();
    expect(degraded.code).toBe("FLOW_BOUNDARY_EXHAUSTED");
    // Y dice DÓNDE va el gap, que es lo que el chasis exige de una degradación:
    // un gap sin destino es la convergencia fingida.
    expect(degraded.action).toContain("Open questions");
    expect(degraded.action).toContain("BACKLOG");
  });

  it("agotada, ya no se contesta — pero el recorrido SIGUE, que es lo que degradar significa", async () => {
    for (let attempt = 0; attempt < MAX_BOUNDARY_ATTEMPTS; attempt += 1) await refused();

    // Parado en ella, contestar se acabó: la frontera dice por qué.
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error("esperaba leer la corrida");
    const standing = resolveBoundary(read.state, journeyOfFlow(read.state.flow));
    expect(standing.kind).toBe("blocked");
    expect(standing.stopped?.id).toBe("quick.entry-gate-signal");

    // Y avanzar la pasa por alto DEJANDO DICHO por qué. Lo destapó el recorrido
    // real: bloquear para siempre no es degradar, es el callejón que la regla
    // existe para evitar — una frontera que ya nadie puede contestar, en una
    // corrida que ya nadie puede terminar.
    const advanced = await advanceFlow(fs, paths, { code: CODE, adopt: false });
    if (!advanced.ok) throw new Error("esperaba que la corrida siguiera");
    const given = advanced.directive.applied.find(
      (step) => step.transition === "quick.entry-gate-signal",
    );
    expect(given?.outcome).toBe("skipped");
    expect(given?.reason).toContain("Open questions");
    // Pasada por alto, no decidida: la diferencia queda legible después.
    const after = await readRun(fs, locateRun(paths, SESSION));
    if (!after.ok) throw new Error("esperaba leer la corrida");
    expect(after.state.skipped).toContain("quick.entry-gate-signal");
    expect(advanced.directive.boundary.transition).not.toBe("quick.entry-gate-signal");
  });

  it("lo que EJERCE algo no se degrada: un efecto sin aprobar nunca se saltea", () => {
    // El límite de la regla anterior, y no es un caso especial: saltear una
    // autorización daría por aprobado un efecto que nadie aprobó, y saltear un
    // paso delegado daría por hecha una búsqueda, una escritura o un chequeo que
    // nada corrió. Esos siguen bloqueando, y el bloqueo lo dice.
    const journey: FlowDecision[] = [
      {
        id: "fixture.escribe",
        scope: "quick",
        title: "una transición que sobrescribe",
        authority: "cli",
        ownership: "cli-owned",
        document: "loops/quick-loop/LOOP.md",
        attribution: "aw flow advance",
        effects: ["mutate_overwrite"],
      },
    ];
    const spent = Array.from({ length: MAX_BOUNDARY_ATTEMPTS }, (_unused, index) => ({
      invocation_id: `sello-${index}`,
      attempt: index + 1,
      request_digest: `payload-${index}`,
      parent_request_digest: index === 0 ? null : `payload-${index - 1}`,
      transition: "fixture.escribe",
    }));
    const state = { ...newRunState("quick", SESSION), attempts: spent };
    const result = advanceFlowRun({ state, journey });
    if (!result.ok) throw new Error(`esperaba una frontera: ${result.failure.code}`);
    expect(result.directive.boundary.kind).toBe("blocked");
    expect(result.directive.error?.code).toBe("FLOW_BOUNDARY_EXHAUSTED");
    expect(result.directive.error?.action).toContain("fuera de la corrida");
    expect(result.state.skipped).toEqual([]);
  });

  it("el intento gastado no vuelve stale la frontera: el motivo sigue siendo el real", async () => {
    // El sello cubre la POSICIÓN, no el archivo entero. Si cubriera los intentos,
    // el segundo rechazo devolvería 'vencida' — el propio rechazo anterior del
    // llamador convertido en staleness, cambiando un motivo preciso por uno vago.
    const first = await refused();
    const second = await refused();
    expect(first.code).toBe("FLOW_SIGNAL_UNKNOWN");
    expect(second.code).toBe("FLOW_SIGNAL_UNKNOWN");
  });

  it("una respuesta válida no gasta intentos: el tope cuenta lo que NO resolvió", async () => {
    await refused();
    const applied = await submitFlow(fs, paths, {
      code: CODE,
      raw: JSON.stringify({
        input_digest: await seal(),
        decisions: { tamaño: "cabe en un quick" },
      }),
      approval: null,
    });
    if (!applied.ok) throw new Error("esperaba que la respuesta se aplicara");
    expect(applied.directive.error).toBeNull();
    const persisted = JSON.parse(await readFile(statePath(), "utf8"));
    const spentHere = persisted.attempts.filter(
      (attempt: { transition: string }) => attempt.transition === "quick.entry-gate-signal",
    );
    // Dos: el rechazado y el que resolvió. Contar solo el segundo dejaría el
    // tope sin evidencia; contar de más lo dispararía antes de tiempo.
    expect(spentHere).toHaveLength(2);
  });
});

describe("forma (b) — atribuida al mecanismo que ya la realiza", () => {
  const attributed = FLOW_DECISIONS.filter((row) => realizationOf(row) !== null);

  it("el símbolo que una fila nombra existe de verdad en su módulo", async () => {
    for (const row of attributed) {
      const realization = realizationOf(row);
      if (realization?.kind !== "engine") continue;
      const body = await readFile(join(SRC, realization.module), "utf8");
      // Definido, no solo mencionado: un símbolo que solo aparece en un import o
      // en un comentario no realiza nada.
      const defined = new RegExp(`(function|const|class)\\s+${realization.symbol}\\b`);
      expect(body, `${row.id} → ${realization.symbol}`).toMatch(defined);
    }
  });

  it("las filas que una regla nombra existen y están migradas ellas mismas", () => {
    const byId = new Map(FLOW_DECISIONS.map((row) => [row.id, row]));
    for (const row of attributed) {
      const realization = realizationOf(row);
      if (realization?.kind !== "transitions") continue;
      expect(realization.ids.length, row.id).toBeGreaterThan(0);
      for (const id of realization.ids) {
        const instance = byId.get(id);
        expect(instance, `${row.id} → ${id}`).toBeDefined();
        // Una regla no puede estar realizada por una fila que la doctrina
        // todavía decide: sería propiedad apoyada en propiedad ajena.
        expect(instance?.ownership, `${row.id} → ${id}`).toBe("cli-owned");
      }
    }
  });

  it("la dirección inversa: ninguna fila cli-owned queda sin forma", () => {
    // La regla transversal del plan, verificada por forma. Tres maneras y solo
    // tres: la cruza una corrida, la realiza algo que existe, o la contrata su
    // comando. Cualquier otra cosa es propiedad afirmada, no migrada.
    const formless = FLOW_DECISIONS.filter((row) => {
      if (row.ownership !== "cli-owned") return false;
      if (flowOfScope(row.scope) !== null) return false;
      if (commandOfScope(row.scope) !== null) return false;
      return placementOf(row) === null && realizationOf(row) === null;
    });
    expect(formless.map((row) => row.id)).toEqual([]);
    // Y que las tres formas existan de verdad, o la guarda pasaría vacía.
    expect(transversal.filter((row) => placementOf(row) !== null)).toHaveLength(3);
    // Once por esta fase, mas `chassis.session-numbering`, que ya era `cli-owned`
    // desde antes del plan y nombra la fila del comando que la instancia.
    expect(transversal.filter((row) => realizationOf(row) !== null)).toHaveLength(11);
  });

  it("una fila atravesada por el recorrido no se atribuye además a un mecanismo", () => {
    // Dos formas a la vez serían dos respuestas a "¿qué la hace verdadera?", y
    // el día que discrepen no habría manera de saber cuál rige.
    const both = transversal.filter(
      (row) => placementOf(row) !== null && realizationOf(row) !== null,
    );
    expect(both.map((row) => row.id)).toEqual([]);
  });
});

describe("forma (c) — contratada en su propio comando", () => {
  const moved = [
    "resume.bare-prompt-continues",
    "resume.prompt-relatedness",
    "resume.escalation-consent",
    "session-create.new-work-line",
    "session-resume.locate",
    "session-resume.rerun-is-create-or-resume",
    "checkpoint-write.context-pressure-signal",
    "checkpoint-write.compaction-degradation",
    "checkpoint-write.before-compacting",
  ];

  it("las nueve viven en el scope de un comando registrado y ninguna quedó en el chasis", () => {
    const registered = new Set(ALL_COMMANDS.map((command) => command.name));
    const byId = new Map(FLOW_DECISIONS.map((row) => [row.id, row]));
    for (const id of moved) {
      const row = byId.get(id);
      expect(row, id).toBeDefined();
      const command = commandOfScope(row?.scope ?? "");
      expect(command, id).not.toBeNull();
      expect(registered.has(command ?? ""), id).toBe(true);
      expect(row?.ownership, id).toBe("cli-owned");
    }
    expect(transversal.map((row) => row.id).filter((id) => moved.includes(id))).toEqual([]);
  });

  it("ninguna fila de checkpoint-write promete un modo de compactación", () => {
    // Hubo dos filas que ofrecían `confirm | auto` y una degradación entre
    // ambos: ni la doctrina lo dice ya ni ningún código lo leyó nunca. Una fila
    // del registro es una decisión que alguien toma de verdad, no una intención.
    const rows = FLOW_DECISIONS.filter((row) => commandOfScope(row.scope) === "checkpoint-write");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.title, row.id).not.toMatch(/\bmodo\b|\bconfirm\b|\bauto\b/);
    }
  });

  it("checkpoint-write dejó de estar excluido al pasar a estar clasificado", () => {
    // La guarda de exhaustividad prohíbe las dos cosas a la vez, así que la
    // exclusión se retira en la misma edición que crea sus filas — si no, el
    // registro afirmaría que el comando no decide nada y que decide tres cosas.
    const excluded = COMMAND_EXCLUSIONS.map((entry) => entry.command);
    expect(excluded).not.toContain("checkpoint-write");
  });
});

describe("el control de flujo se emite entero", () => {
  function humanRow(): FlowDecision[] {
    return [
      {
        id: "fixture.preferencia",
        scope: "quick",
        title: "una preferencia que solo la persona tiene",
        authority: "human",
        ownership: "cli-owned",
        document: "loops/quick-loop/LOOP.md",
        attribution: "aw flow advance",
      },
    ];
  }

  it("Compactar viaja junto a Cerrar en toda frontera con alternativas", () => {
    const result = advanceFlowRun({ state: newRunState("quick", SESSION), journey: humanRow() });
    if (!result.ok) throw new Error("esperaba una frontera humana");
    const labels = result.directive.choices.map((choice) => choice.label);
    expect(labels.slice(-2)).toEqual([PAUSE_LABEL, STOP_LABEL]);
    // Ninguno de los dos es la recomendación: recomendar pausar o cerrar sería
    // el motor opinando sobre si seguir.
    for (const label of [PAUSE_LABEL, STOP_LABEL]) {
      const control = result.directive.choices.find((choice) => choice.label === label);
      expect(control?.recommended, label).toBe(false);
      expect(control?.consequence.trim().length, label).toBeGreaterThan(0);
    }
  });

  it("las dos consecuencias son distintas: pausar no es cerrar", () => {
    const result = advanceFlowRun({ state: newRunState("quick", SESSION), journey: humanRow() });
    if (!result.ok) throw new Error("esperaba una frontera humana");
    const consequence = (label: string): string =>
      result.directive.choices.find((choice) => choice.label === label)?.consequence ?? "";
    expect(consequence(PAUSE_LABEL)).not.toBe(consequence(STOP_LABEL));
    expect(consequence(PAUSE_LABEL)).toContain("CHECKPOINT");
  });

  it("también en una frontera de autorización, sin perder lo que cuesta no aprobar", () => {
    const journey: FlowDecision[] = [
      {
        id: "fixture.escribe",
        scope: "quick",
        title: "una transición que sobrescribe",
        authority: "cli",
        ownership: "cli-owned",
        document: "loops/quick-loop/LOOP.md",
        attribution: "aw flow advance",
        effects: ["mutate_overwrite"],
        action: {
          invocation: { program: "aw", args: ["status", "--json"], target: ".", input: null },
          evidence: ["algo"],
          idempotent: true,
          recovery: "recuperación",
        },
      },
    ];
    const result = advanceFlowRun({ state: newRunState("quick", SESSION), journey });
    if (!result.ok) throw new Error("esperaba una frontera de autorización");
    expect(result.directive.boundary.kind).toBe("authorization");
    const labels = result.directive.choices.map((choice) => choice.label);
    expect(labels.slice(-2)).toEqual([PAUSE_LABEL, STOP_LABEL]);
    const stop = result.directive.choices.find((choice) => choice.label === STOP_LABEL);
    expect(stop?.consequence).toContain("mutate_overwrite");
  });
});

describe("Compactar sobre una corrida real: pausa, no resuelve", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-chassis-pause-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — prueba\n\n## Objective\nprobar\n",
      "utf8",
    );
    await advanceFlow(fs, paths, { code: CODE, flow: "quick", adopt: true });
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("pausar deja la MISMA frontera en pie y no aplica la transición", async () => {
    // Se posiciona la corrida en el gate humano declarando las dos señales que
    // su umbral cuenta; ahí es donde el control de flujo se emite.
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error("esperaba leer la corrida");
    const digest = resolveBoundary(read.state, journeyOfFlow("quick")).seal;
    const declared = await submitFlow(fs, paths, {
      code: CODE,
      raw: JSON.stringify({
        input_digest: digest,
        signals: ["quick.needs-architecture", "quick.multiple-deliverables"],
      }),
      approval: null,
    });
    if (!declared.ok) throw new Error("esperaba declarar las señales");

    // Con el umbral disparado, lo siguiente NO es el gate: es la búsqueda
    // anti-duplicado, que decide cuál alternativa se recomienda. Se le devuelve
    // su resultado real para llegar a la frontera humana.
    const searching = await readRun(fs, locateRun(paths, SESSION));
    if (!searching.ok) throw new Error("esperaba leer la corrida");
    const search = resolveBoundary(searching.state, journeyOfFlow("quick"));
    expect(search.kind).toBe("execution");
    const searched = await submitFlow(fs, paths, {
      code: CODE,
      raw: JSON.stringify({
        input_digest: search.seal,
        outcome: "completed",
        invocation: search.action?.invocation,
        validations: (search.action?.evidence ?? []).map((id) => ({
          id,
          passed: true,
          detail: `salida real de ${id}`,
        })),
        effects: { planned: ["read_only"], approved: [], applied: ["read_only"] },
        output: null,
      }),
      approval: null,
    });
    if (!searched.ok) throw new Error("esperaba devolver el resultado de la búsqueda");

    const current = await readRun(fs, locateRun(paths, SESSION));
    if (!current.ok) throw new Error("esperaba leer la corrida");
    const boundary = resolveBoundary(current.state, journeyOfFlow("quick"));
    expect(boundary.kind).toBe("human");
    expect(boundary.choices.map((choice) => choice.label)).toContain(PAUSE_LABEL);

    const paused = await submitFlow(fs, paths, {
      code: CODE,
      raw: JSON.stringify({ input_digest: boundary.seal, choice: PAUSE_LABEL }),
      approval: null,
    });
    if (!paused.ok) throw new Error("pausar viaja ok:true");
    expect(paused.directive.error?.code).toBe("FLOW_BOUNDARY_PAUSED");
    // Pausar NO es cancelar: la corrida sigue esperando esta misma respuesta.
    expect(paused.directive.outcome).toBe("needs_input");
    expect(paused.directive.boundary.transition).toBe(boundary.stopped?.id);
    expect(paused.directive.error?.action).toContain("checkpoint-write");

    const after = await readRun(fs, locateRun(paths, SESSION));
    if (!after.ok) throw new Error("esperaba leer la corrida");
    expect(after.state.applied).not.toContain(boundary.stopped?.id);
    expect(after.state.boundary).toBe(boundary.stopped?.id);
  });
});

describe("la corrida real cruza las filas transversales", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-chassis-run-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — prueba\n\n## Objective\nprobar\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("adoptar ya aplicó las dos del prefijo antes de la primera frontera propia", async () => {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    // Aplicadas de verdad, no declaradas: son el primer tramo del recorrido y el
    // motor las cruza sin preguntar nada, que es lo que hace observable la forma.
    const applied = adopted.directive.applied.map((step) => step.transition);
    expect(applied.slice(0, 2)).toEqual(["chassis.docs-boundary", "chassis.research-exhaustion"]);
    for (const step of adopted.directive.applied.slice(0, 2)) {
      expect(step.outcome).toBe("applied");
      expect(step.ownership).toBe("cli-owned");
    }
    // Y la frontera en pie ya es del flow, no del chasis.
    expect(adopted.directive.boundary.transition).toBe("quick.entry-gate-signal");
  });

  it("el cierre es el último paso pendiente de toda jornada", () => {
    for (const flow of WORKLINE_FLOWS as readonly WorklineFlow[]) {
      const journey = journeyOfFlow(flow);
      expect(journey[journey.length - 1]?.id, flow).toBe("chassis.finalize");
    }
  });
});
