import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { projectRun } from "../../src/application/flow/run-projection.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import {
  FIX_PREVIEW_TRANSITION,
  type FlowDecision,
  actionOf,
  conditionOf,
  effectsOf,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import { bindAction, skipReason, thresholdFired } from "../../src/domain/flow/rules.js";
import { FLOW_RUN_STATE_FILE, attemptAccountingAt } from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * QUICK, dirigido por el CLI — el primer consumidor de producción del motor.
 *
 * Lo que esta prueba fija no es "el recorrido funciona": es que la migración no
 * compró velocidad a cambio de mentir. Tres cosas, sobre el registro VIVO y una
 * corrida real en disco:
 *
 * 1. **El umbral se deriva, y lo que no disparó no se pregunta.** Las señales que
 *    el agente declara se persisten; el veredicto se recalcula en cada lectura.
 *    Cero o una señal omiten el gate — y la omisión queda escrita con su motivo,
 *    porque `applied.length` es el cursor y un paso que desaparece del cursor es
 *    un paso que nadie puede auditar.
 * 2. **Buscar, sembrar y validar no se acreditan por decreto.** Las tres filas con
 *    acción delegada nombran su invocación exacta —ya ligada a ESTA sesión— y no
 *    aplican nada hasta que vuelve la salida real.
 * 3. **El tramo es el documento, no el scope.** Las cinco filas transversales
 *    siguen siendo de la doctrina: migrarlas acá movería un tramo que nadie
 *    planeó.
 */

const fs = new NodeFileSystem();
const SESSION = "007-tramo-quick-quick";
const CODE = "007";

const JOURNEY = journeyOfFlow("quick");

function rowOf(id: string): FlowDecision {
  const row = JOURNEY.find((decision) => decision.id === id);
  if (row === undefined) throw new Error(`el recorrido quick ya no tiene '${id}'`);
  return row;
}

/** Un preview del arreglo con sus tres partes: archivos, intención y forma del diff. */
const PREVIEW = {
  files: ["src/dominio/cosa.ts", "tests/unit/cosa.test.ts"],
  intent: "cerrar el borde que el test rojo reproduce",
  diff: "una guarda nueva en la función y su caso rojo",
};

/**
 * Lo que una frontera semántica del tramo admite en `decisions`, por fila.
 *
 * `quick.fix-preview` es la única cuyo contenido el CLI valida —un `paso`
 * genérico no la atraviesa—, así que vive acá y no repetido en cada caminante:
 * tres copias del payload es cómo un caminante se queda atrás del contrato.
 */
function decisionsFor(id: string | undefined): Record<string, unknown> {
  return id === FIX_PREVIEW_TRANSITION ? { preview: PREVIEW } : { paso: id };
}

describe("el tramo QUICK migró como dato, no como prosa", () => {
  it("el umbral de entrada vive UNA vez y lo comparten los pasos que dependen de él", () => {
    const gate = conditionOf(rowOf("quick.gate-choice"));
    const search = conditionOf(rowOf("quick.anti-duplicate"));
    expect(gate?.threshold).toEqual({ observed: "quick.entry-gate-signal", min: 2 });
    // La MISMA regla, no una copia con vida propia: la búsqueda anti-duplicado y
    // la elección disparan juntas o no disparan.
    expect(search?.threshold).toBe(gate?.threshold);
  });

  /**
   * «El mismo umbral de señales que dispara el gate de entrada» — el MISMO objeto.
   *
   * Se afirma con `toBe` y no con `toEqual` a propósito: una copia con los mismos
   * dos números pasaría cualquier comparación por valor y se quedaría atrás el día
   * que el umbral del gate cambie. La doctrina no dice «dos señales» acá, dice «el
   * mismo umbral», y eso es una identidad, no una coincidencia.
   */
  it("la aprobación del preview reusa el umbral del gate de entrada, no una copia", () => {
    const gate = conditionOf(rowOf("quick.gate-choice"));
    const approval = conditionOf(rowOf("quick.fix-preview-approval"));
    expect(approval?.threshold).toBe(gate?.threshold);
    // Y su `otherwise` dice lo que la doctrina dice que pasa por debajo del umbral:
    // el preview queda declarado y la tarea ejecuta, sin parada humana.
    expect(approval?.otherwise).toContain("sin parada humana");
  });

  it("el preview se declara ANTES de producir el entregable, y se aprueba entre los dos", () => {
    // El orden ES el recorrido: el array del registro lo compone. Un preview
    // después del entregable sería una descripción de lo ya hecho.
    const ids = JOURNEY.map((decision) => decision.id);
    const at = (id: string): number => ids.indexOf(id);
    expect(at("quick.fix-preview")).toBe(at("quick.branch-precondition") + 1);
    expect(at("quick.fix-preview-approval")).toBe(at("quick.fix-preview") + 1);
    expect(at("quick.deliverable-authoring")).toBe(at("quick.fix-preview-approval") + 1);
    // La fila que declara no admite señales: contesta con una declaración, y su
    // umbral no se deriva de nada que ella observe.
    expect(rowOf("quick.fix-preview").signals).toBeUndefined();
    // Y el id que la pista y el validador comparten es este, no uno parecido.
    expect(FIX_PREVIEW_TRANSITION).toBe("quick.fix-preview");
    expect(ids).toContain(FIX_PREVIEW_TRANSITION);
  });

  it("las tres alternativas del preview llevan los rótulos de la doctrina, con una sola recomendación", () => {
    const alternatives = rowOf("quick.fix-preview-approval").alternatives ?? [];
    expect(alternatives.map((choice) => choice.label)).toEqual([
      "Ejecutar tal cual",
      "Ajustar el enfoque",
      "Escalar a spec",
    ]);
    expect(alternatives.filter((choice) => choice.recommended).map((c) => c.label)).toEqual([
      "Ejecutar tal cual",
    ]);
    // «Ajustar el enfoque» NO re-emite la frontera —el vocabulario de outcomes no
    // tiene «repetir» y el ajuste es conversacional, igual que `Recortar alcance`
    // en el gate de entrada—, así que su consecuencia lo dice en vez de dejar a
    // alguien esperando otra pregunta.
    const adjust = alternatives.find((choice) => choice.label === "Ajustar el enfoque");
    expect(adjust?.consequence).toContain("no se vuelve a emitir");
    // Y «Escalar a spec» NO puede resolverse como `Cambiar a SPEC` del gate de
    // entrada: aquella elige antes de que la corrida exista —seguir caminando no
    // contradice nada—, y esta elige con la corrida ya sembrada y una fila después
    // la que implementa. Con `continue`, «la tarea no implementa» duraba hasta la
    // frontera siguiente.
    const escalate = alternatives.find((choice) => choice.label === "Escalar a spec");
    expect(escalate?.outcome).toEqual({ kind: "handoff", destination: "spec-new" });
    const changeToSpec = (rowOf("quick.gate-choice").alternatives ?? []).find(
      (choice) => choice.label === "Cambiar a SPEC",
    );
    expect(escalate?.outcome).not.toEqual(changeToSpec?.outcome);
  });

  it("toda condición observa una fila anterior del mismo tramo que declara señales", () => {
    for (const [index, decision] of JOURNEY.entries()) {
      const condition = conditionOf(decision);
      if (condition === null) continue;
      const observed = JOURNEY.findIndex((row) => row.id === condition.threshold.observed);
      expect(observed, decision.id).toBeGreaterThanOrEqual(0);
      // Antes, o el veredicto se derivaría de algo que todavía no se observó.
      expect(observed, decision.id).toBeLessThan(index);
      const vocabulary = JOURNEY[observed]?.signals ?? [];
      expect(vocabulary.length, decision.id).toBeGreaterThan(0);
      expect(condition.threshold.min, decision.id).toBeGreaterThan(0);
      expect(condition.threshold.min, decision.id).toBeLessThanOrEqual(vocabulary.length);
      expect(condition.otherwise.trim().length, decision.id).toBeGreaterThan(10);
    }
  });

  it("las tres alternativas del gate son dato de la fila, con una sola recomendación", () => {
    const labels = (rowOf("quick.gate-choice").alternatives ?? []).map((choice) => choice.label);
    expect(labels).toEqual(["Cambiar a SPEC", "Seguir en quick", "Recortar alcance"]);
  });

  it("cada acción delegada invoca un comando que este CLI registra de verdad", () => {
    // Un `program`/verbo inventado es una directiva que manda a correr algo que no
    // existe, y eso solo se ve cuando alguien lo intenta. La misma verificación
    // cazó `aw flow submit --code` en la proyección de esta fase.
    const registered = new Set(ALL_COMMANDS.map((command) => command.name));
    for (const decision of JOURNEY) {
      const action = actionOf(decision);
      if (action === null) continue;
      expect(action.invocation.program, decision.id).toBe("aw");
      expect(registered.has(action.invocation.args[0] ?? ""), decision.id).toBe(true);
    }
  });

  it("las acciones delegadas del tramo, incluidas las dos que llegaron con PLAN", () => {
    const delegated = JOURNEY.filter((decision) => actionOf(decision) !== null).map((d) => d.id);
    // Las dos últimas del pilot mas las dos de los documentos compartidos: la
    // rama y el script de la sesión se acreditan igual que todo lo demás, con
    // salida real, y llegaron cuando PLAN liberó sus documentos.
    expect(delegated).toEqual([
      "quick.anti-duplicate",
      "quick.session-create",
      "quick.artifact-seed-order",
      "quick.branch-precondition",
      "quick.db-scripts-only",
      "quick.convergence-gate",
      // El cierre del chasis, compuesto como sufijo del recorrido: cerrar la
      // sesión escribe su fila del registro durable, así que se acredita con
      // salida real igual que cualquier otra escritura.
      "chassis.finalize",
    ]);
  });
});

describe("las reglas del tramo, sobre observaciones que nadie filtró", () => {
  // El camino de producción rechaza una respuesta con señales repetidas o ajenas
  // antes de persistirla, así que estas combinaciones no llegan por `submit`. Se
  // prueban igual: el conteo es la regla que decide si se pregunta, y una regla
  // que solo es correcta porque otra capa la protege es una regla sin probar.
  const observed = "quick.entry-gate-signal";

  it("solo cuentan señales distintas y del vocabulario de la fila observada", () => {
    const rule = { observed, min: 2 };
    const fired = (signals: string[]): boolean =>
      thresholdFired(rule, JOURNEY, [{ transition: observed, signals }]);

    expect(fired(["quick.needs-architecture", "quick.needs-architecture"])).toBe(false);
    expect(fired(["quick.needs-architecture", "chassis.context-pressure"])).toBe(false);
    expect(fired(["quick.needs-architecture", "quick.multiple-deliverables"])).toBe(true);
  });

  it("sin observación no hay veredicto, y sin veredicto el paso se omite", () => {
    const gate = rowOf("quick.gate-choice");
    expect(skipReason(gate, JOURNEY, [])).toContain("no disparó");
    expect(
      skipReason(gate, JOURNEY, [
        {
          transition: observed,
          signals: ["quick.needs-architecture", "quick.two-or-more-sources"],
        },
      ]),
    ).toBeNull();
    // Una fila sin condición nunca se omite, tenga o no observaciones.
    expect(skipReason(rowOf("quick.entry-size-gate"), JOURNEY, [])).toBeNull();
  });

  it("una invocación con un placeholder que la corrida no puede resolver se rechaza", () => {
    const action = actionOf(rowOf("quick.session-create"));
    if (action === null) throw new Error("quick.session-create dejó de delegar");

    // `code` es el FOLDER, igual que lo liga la corrida: el número desnudo no
    // resuelve en un workspace que además tiene una carpeta legacy homónima.
    const binding = { session: SESSION, code: SESSION, slug: "tramo-quick" };
    const bound = bindAction(action, binding);
    if (!bound.ok) throw new Error(`esperaba ligar la acción: ${bound.unbound}`);
    expect(bound.action.invocation.args).toEqual(["session-artifacts", "--code", SESSION]);
    expect(bound.action.invocation.target).toBe(SESSION);

    // Un nombre que no existe no se liga con nada, y emitirlo sería mandar a
    // ejecutar un comando con una llave adentro.
    const typo = bindAction(
      { ...action, invocation: { ...action.invocation, target: "{sesion}" } },
      binding,
    );
    expect(typo).toEqual({ ok: false, unbound: "{sesion}" });

    // Y una coordenada del conjunto que ESTA corrida no tiene se niega igual: la
    // ausencia se propaga como placeholder vivo, nunca como cadena vacía.
    const sinSlug = bindAction(
      { ...action, invocation: { ...action.invocation, target: "plan-{slug}.md" } },
      { ...binding, slug: null },
    );
    expect(sinSlug).toEqual({ ok: false, unbound: "{slug}" });
  });
});

describe("QUICK dirigido — sobre una corrida real en disco", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-tramo-quick-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — tramo quick\n\n## Objective\nprobar el tramo\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  /** The boundary the persisted run currently stands on. */
  async function current() {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return { state: read.state, resolved: resolveBoundary(read.state, JOURNEY) };
  }

  async function adopt(): Promise<FlowDirective> {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    return adopted.directive;
  }

  async function answer(body: unknown, approval: string | null = null): Promise<FlowDirective> {
    const result = await submitFlow(fs, paths, {
      code: CODE,
      raw: JSON.stringify(body),
      approval,
    });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
    return result.directive;
  }

  /**
   * Answer the entry-gate boundary with exactly these signals.
   *
   * `decisions` always travels: declaring NO signal is a real answer, and the
   * contract refuses a payload that declares neither — "I observed nothing" and
   * "I did not answer" are different facts.
   */
  async function declare(signals: string[]): Promise<FlowDirective> {
    const first = await adopt();
    expect(first.boundary.transition).toBe("quick.entry-gate-signal");
    return await answer({
      input_digest: first.state_digest,
      signals,
      decisions: { observadas: signals.length },
    });
  }

  /** The real result of the invocation the boundary in force names. */
  function resultFor(
    resolved: Awaited<ReturnType<typeof current>>["resolved"],
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const action = resolved.action;
    if (action === null) throw new Error("esta frontera no nombra ninguna acción");
    const declared = effectsOf(resolved.stopped as FlowDecision);
    return {
      input_digest: resolved.seal,
      outcome: "completed",
      invocation: action.invocation,
      validations: action.evidence.map((id) => ({
        id,
        passed: true,
        detail: `salida real de ${id}`,
        ...(id === "workline.source-bounded"
          ? {
              proof: {
                kind: "inspection" as const,
                source: "workspace",
                relative_cwd: ".",
                checkout_digest: "test-checkout",
                invocation: { artifact: "tests/unit/flow-tramo-quick.test.ts" },
              },
            }
          : {}),
      })),
      effects: { planned: [...declared], approved: [], applied: [...declared] },
      output: null,
      ...overrides,
    };
  }

  it("una señal sola no pregunta ni busca nada: los dos pasos del gate quedan OMITIDOS", async () => {
    const directive = await declare(["quick.needs-architecture"]);

    // Borderline sigue en quick sin preguntar — y los pasos omitidos están en la
    // traza, con su motivo, porque el cursor los pasó igual.
    const omitted = directive.applied.filter((step) => step.outcome === "skipped");
    expect(omitted.map((step) => step.transition)).toEqual([
      "quick.anti-duplicate",
      "quick.gate-choice",
    ]);
    for (const step of omitted) expect(step.reason).toContain("no disparó");
    expect(directive.boundary.transition).not.toBe("quick.gate-choice");

    const { state } = await current();
    expect(state.skipped).toEqual(["quick.anti-duplicate", "quick.gate-choice"]);
    expect(state.applied).toContain("quick.gate-choice");
    // Omitir no ejerce nada: el cursor avanzó y el ledger no.
    expect(state.effects.applied).not.toContain("mutate_overwrite");
  });

  it("dos señales presentan las tres alternativas propias más el control de flujo", async () => {
    await declare(["quick.needs-architecture", "quick.multiple-deliverables"]);
    // Con el umbral disparado, la búsqueda anti-duplicado sí ocurre: es lo que
    // decide cuál alternativa se recomienda.
    const search = await current();
    expect(search.resolved.stopped?.id).toBe("quick.anti-duplicate");
    const directive = await answer(resultFor(search.resolved));

    expect(directive.boundary.kind).toBe("human");
    expect(directive.boundary.transition).toBe("quick.gate-choice");
    expect(directive.choices.map((choice) => choice.label)).toEqual([
      "Cambiar a SPEC",
      "Seguir en quick",
      "Recortar alcance",
      // El control de flujo, ENTERO: pausar y cerrar son actos distintos y el
      // chasis nombra los dos. Emitir solo `Cerrar` obligaba a elegir entre
      // perder el hilo y perder el trabajo.
      "Compactar",
      "Cerrar",
    ]);
    // Ninguno de los dos sale de la fila: el tramo no puede escribir una frontera
    // de la que no se pueda salir ni pausar.
    expect(directive.choices.filter((choice) => choice.recommended)).toHaveLength(1);
    const { state } = await current();
    expect(state.skipped).toEqual([]);
  });

  it("la misma señal dos veces no compra el umbral: la respuesta se rechaza entera", async () => {
    const directive = await declare(["quick.needs-architecture", "quick.needs-architecture"]);
    // Ni siquiera llega a contarse: una observación repetida es una respuesta
    // inválida, y una respuesta inválida no persiste nada.
    expect(directive.error?.code).toBe("FLOW_ANSWER_INVALID");
    const { state } = await current();
    expect(state.observations).toEqual([]);
    // Los dos pasos transversales del prefijo YA se aplicaron —fijan la carpeta
    // que este flow puede escribir y el tope de intentos, antes de cualquier
    // pregunta—, así que "no persiste nada" se afirma sobre lo que la respuesta
    // habría movido: la fila que contestaba sigue sin aplicar.
    expect(state.applied).not.toContain("quick.entry-gate-signal");
    expect(state.skipped).toEqual([]);
  });

  it("el anti-duplicado nombra su búsqueda y no aplica nada hasta que vuelve", async () => {
    await declare(["quick.needs-architecture", "quick.two-or-more-sources"]);
    const { state, resolved } = await current();
    expect(resolved.kind).toBe("execution");
    expect(resolved.stopped?.id).toBe("quick.anti-duplicate");
    expect(resolved.action?.invocation.program).toBe("aw");
    expect(resolved.action?.invocation.args).toEqual(["status", "--json"]);
    expect(state.applied).not.toContain("quick.anti-duplicate");
    expect(state.pending_action?.transition).toBe("quick.anti-duplicate");

    // Una confirmación no es un resultado.
    const claimed = await answer({ input_digest: resolved.seal, confirmed: true });
    expect(claimed.error?.code).toBe("FLOW_RESULT_INVALID");
    const untouched = await current();
    expect(untouched.state.applied).not.toContain("quick.anti-duplicate");

    // La salida real sí — y lo que sigue es el gate, porque el umbral disparó.
    const applied = await answer(resultFor(resolved));
    expect(applied.error).toBeNull();
    expect(applied.boundary.transition).toBe("quick.gate-choice");
    const after = await current();
    expect(after.state.applied).toContain("quick.anti-duplicate");
  });

  it("la siembra pide el dump de ESTA sesión, con el código ya ligado", async () => {
    await declare([]);

    const create = await current();
    expect(create.resolved.stopped?.id).toBe("quick.session-create");
    expect(create.resolved.action?.invocation.args).toEqual([
      "session-artifacts",
      "--code",
      SESSION,
    ]);
    expect(create.resolved.action?.invocation.target).toBe(SESSION);
    // El placeholder nunca llega a quien ejecuta.
    expect(JSON.stringify(create.resolved.action)).not.toContain("{code}");
    expect(JSON.stringify(create.resolved.action)).not.toContain("{session}");
    await answer(resultFor(create.resolved));

    const authoring = await current();
    expect(authoring.resolved.kind).toBe("semantic");
    expect(authoring.resolved.stopped?.id).toBe("quick.success-criteria-authoring");
    await answer({ input_digest: authoring.resolved.seal, decisions: { criterio: "una prueba" } });

    const seed = await current();
    expect(seed.resolved.stopped?.id).toBe("quick.artifact-seed-order");
    expect(seed.resolved.action?.invocation.args).toContain("objetivo,checkpoint");
    expect(seed.resolved.action?.evidence).toEqual([
      "quick.objetivo-sembrado",
      "quick.criterios-sembrados",
      "quick.checkpoint-sembrado",
    ]);

    // Evidencia a medias no siembra nada: falta una de las tres.
    const partial = await answer(
      resultFor(seed.resolved, {
        validations: [{ id: "quick.objetivo-sembrado", passed: true, detail: "objetivo" }],
      }),
    );
    expect(partial.error?.code).toBe("FLOW_EVIDENCE_MISSING");
    const held = await current();
    expect(held.state.applied).not.toContain("quick.artifact-seed-order");
  });

  it("la ratificación solo aparece cuando el entregable es análisis", async () => {
    await declare([]);
    const create = await current();
    await answer(resultFor(create.resolved));

    const authoring = await current();
    expect(authoring.resolved.stopped?.id).toBe("quick.success-criteria-authoring");
    const directive = await answer({
      input_digest: authoring.resolved.seal,
      signals: ["quick.deliverable-is-analysis"],
    });
    expect(directive.boundary.transition).toBe("quick.success-criteria-ratification");
    expect(directive.boundary.kind).toBe("human");
    const { state } = await current();
    expect(state.skipped).not.toContain("quick.success-criteria-ratification");
  });

  /**
   * Camina hasta la frontera pedida contestando lo que cada una admite, y la
   * devuelve SIN contestarla.
   *
   * Es lo que permite probar la respuesta equivocada: llegar a la frontera y no
   * atravesarla.
   */
  async function reach(id: string) {
    for (let step = 0; step < 25; step += 1) {
      const at = await current();
      if (at.resolved.stopped?.id === id) return at;
      if (at.resolved.stopped === null) {
        throw new Error(`el recorrido terminó sin pasar por '${id}'`);
      }
      await answerReturning(at.resolved);
    }
    throw new Error(`el recorrido nunca llegó a '${id}'`);
  }

  it("por debajo del umbral el preview se declara y NADIE lo aprueba", async () => {
    await declare(["quick.needs-architecture"]);
    const preview = await reach(FIX_PREVIEW_TRANSITION);
    // Es semántica: lo que se pide es una declaración, no bytes ni una etiqueta.
    expect(preview.resolved.kind).toBe("semantic");
    // Y la forma exacta viaja en el contrato de la frontera, así que el primer
    // intento puede traerla sin haberse hecho rechazar para aprenderla.
    expect(preview.resolved.request?.contract).toContain("decisions.preview");
    expect(preview.resolved.request?.limits.max_artifacts).toBe(0);

    const directive = await answer({
      input_digest: preview.resolved.seal,
      decisions: { preview: PREVIEW },
    });
    expect(directive.error).toBeNull();
    const skipped = directive.applied.find(
      (step) => step.transition === "quick.fix-preview-approval",
    );
    expect(skipped?.outcome).toBe("skipped");
    expect(skipped?.reason).toContain("sin parada humana");
    expect(directive.boundary.transition).toBe("quick.deliverable-authoring");

    // Y la reanudación no vuelve a pedir lo ya declarado: releer el estado —que es
    // exactamente lo que hace un `resume`— resuelve la frontera SIGUIENTE, porque
    // el cursor es `applied.length` y sólo crece.
    const resumed = await current();
    expect(resumed.state.applied).toContain(FIX_PREVIEW_TRANSITION);
    expect(resumed.state.skipped).toContain("quick.fix-preview-approval");
    expect(resumed.resolved.stopped?.id).toBe("quick.deliverable-authoring");
  });

  it("por encima del umbral: sin preview gasta un intento, con preview lo aprueba una persona", async () => {
    await declare(["quick.needs-architecture", "quick.multiple-deliverables"]);
    const preview = await reach(FIX_PREVIEW_TRANSITION);
    expect(attemptAccountingAt(preview.state, FIX_PREVIEW_TRANSITION).spent).toBe(0);

    // Una decisión cualquiera atraviesa el chequeo de sustancia y no el del
    // preview: la frontera pidió archivos, intención y forma del diff.
    const refused = await answer({
      input_digest: preview.resolved.seal,
      decisions: { paso: "arreglar la cosa" },
    });
    expect(refused.error?.code).toBe("FLOW_PREVIEW_INVALID");
    const charged = await current();
    expect(charged.state.applied).not.toContain(FIX_PREVIEW_TRANSITION);
    // El GASTO, no sólo el código: la tabla de rechazos lo clasifica `evaluated`
    // porque la respuesta se leyó, y el default de esa tabla es fail-closed.
    expect(attemptAccountingAt(charged.state, FIX_PREVIEW_TRANSITION).spent).toBe(1);

    const declared = await answer({
      input_digest: charged.resolved.seal,
      decisions: { preview: PREVIEW },
    });
    expect(declared.error).toBeNull();
    expect(declared.boundary.transition).toBe("quick.fix-preview-approval");
    expect(declared.boundary.kind).toBe("human");
    expect(declared.choices.map((choice) => choice.label)).toEqual([
      "Ejecutar tal cual",
      "Ajustar el enfoque",
      "Escalar a spec",
      // El control de flujo del chasis, que el motor agrega a toda frontera que
      // ofrece alternativas.
      "Compactar",
      "Cerrar",
    ]);
    expect(declared.choices[0]?.recommended).toBe(true);
    expect(declared.choices.filter((choice) => choice.recommended)).toHaveLength(1);

    const standing = await current();
    const chosen = await answer({
      input_digest: standing.resolved.seal,
      choice: "Ejecutar tal cual",
    });
    expect(chosen.error).toBeNull();
    expect(chosen.boundary.transition).toBe("quick.deliverable-authoring");
    expect((await current()).state.applied).toContain("quick.fix-preview-approval");
  });

  it("un preview con lista de archivos VACÍA vale: un análisis no toca ninguno", async () => {
    await declare(["quick.needs-architecture"]);
    const preview = await reach(FIX_PREVIEW_TRANSITION);
    const directive = await answer({
      input_digest: preview.resolved.seal,
      decisions: {
        preview: {
          files: [],
          intent: "producir el análisis del borde, sin tocar código",
          diff: "ningún diff de código: el entregable es el documento de la sesión",
        },
      },
    });
    expect(directive.error).toBeNull();
    expect((await current()).state.applied).toContain(FIX_PREVIEW_TRANSITION);
  });

  /**
   * La rama que exige que el preview DIGA algo, y no sólo que venga.
   *
   * Sin este caso la guarda era letra muerta: los otros casos del preview mueren
   * en la primera rama —«no vino ningún preview»— o la atraviesan entera, así que
   * neutralizarla no ponía nada rojo y un preview vacío llegaba a la frontera
   * donde una persona lo aprueba como «exactamente lo previsualizado».
   */
  it("un preview al que le falta la intención o la forma del diff se rechaza y gasta", async () => {
    await declare(["quick.needs-architecture", "quick.multiple-deliverables"]);
    const preview = await reach(FIX_PREVIEW_TRANSITION);

    const sinIntencion = await answer({
      input_digest: preview.resolved.seal,
      decisions: { preview: { files: ["src/dominio/cosa.ts"], diff: "una guarda nueva" } },
    });
    expect(sinIntencion.error?.code).toBe("FLOW_PREVIEW_INVALID");
    expect(sinIntencion.error?.message).toContain("qué arregla o qué forma tendrá el diff");
    const first = await current();
    expect(first.state.applied).not.toContain(FIX_PREVIEW_TRANSITION);
    expect(attemptAccountingAt(first.state, FIX_PREVIEW_TRANSITION).spent).toBe(1);

    // Y una forma del diff EN BLANCO no es una forma del diff: la rama mira el
    // contenido, no la presencia de la clave. Con la lista vacía, que es legítima,
    // para que lo único que rechace sea lo que falta decir.
    const enBlanco = await answer({
      input_digest: first.resolved.seal,
      decisions: { preview: { files: [], intent: "cerrar el borde", diff: "   " } },
    });
    expect(enBlanco.error?.code).toBe("FLOW_PREVIEW_INVALID");
    const second = await current();
    expect(second.state.applied).not.toContain(FIX_PREVIEW_TRANSITION);
    expect(attemptAccountingAt(second.state, FIX_PREVIEW_TRANSITION).spent).toBe(2);
  });

  /**
   * La otra mitad del contrato: los archivos van como LISTA DE RUTAS.
   *
   * «La lista puede ir vacía» ya tenía su caso; que la lista tenga que venir, y
   * venir con rutas adentro, no lo tenía ninguno — y es justo la mitad que la
   * doctrina llama «files to touch».
   */
  it("un preview sin lista de archivos, o con algo que no son rutas, se rechaza igual", async () => {
    await declare(["quick.needs-architecture", "quick.multiple-deliverables"]);
    const preview = await reach(FIX_PREVIEW_TRANSITION);

    const sinArchivos = await answer({
      input_digest: preview.resolved.seal,
      decisions: { preview: { intent: "cerrar el borde", diff: "una guarda nueva" } },
    });
    expect(sinArchivos.error?.code).toBe("FLOW_PREVIEW_INVALID");
    expect(sinArchivos.error?.message).toContain("lista de archivos a tocar");
    const first = await current();
    expect(first.state.applied).not.toContain(FIX_PREVIEW_TRANSITION);
    expect(attemptAccountingAt(first.state, FIX_PREVIEW_TRANSITION).spent).toBe(1);

    // Y la lista se mide elemento por elemento: una ruta de verdad al lado de algo
    // que no es una ruta sigue siendo una lista, y no es la lista que se pidió.
    const conBasura = await answer({
      input_digest: first.resolved.seal,
      decisions: {
        preview: { files: [1, "src/dominio/cosa.ts"], intent: "cerrar", diff: "una guarda" },
      },
    });
    expect(conBasura.error?.code).toBe("FLOW_PREVIEW_INVALID");
    const second = await current();
    expect(second.state.applied).not.toContain(FIX_PREVIEW_TRANSITION);
    expect(attemptAccountingAt(second.state, FIX_PREVIEW_TRANSITION).spent).toBe(2);
  });

  /**
   * «La tarea no implementa» tiene que sobrevivir a una reanudación.
   *
   * Resuelta como `continue`, la promesa duraba hasta la frontera siguiente: la
   * que implementa. Con el host compactando en el medio, `advance` devolvía
   * «producir el cambio mínimo» y en el estado no quedaba rastro de haber
   * declinado — el quick producía exactamente lo que se rechazó producir.
   */
  it("«Escalar a spec» para la corrida y no la deja volver al entregable", async () => {
    await declare(["quick.needs-architecture", "quick.multiple-deliverables"]);
    const preview = await reach(FIX_PREVIEW_TRANSITION);
    await answer({ input_digest: preview.resolved.seal, decisions: { preview: PREVIEW } });

    const standing = await current();
    expect(standing.resolved.stopped?.id).toBe("quick.fix-preview-approval");
    const escalated = await answer({
      input_digest: standing.resolved.seal,
      choice: "Escalar a spec",
    });
    // La entrega ES la frontera: no queda pregunta que contestar ni alternativa
    // que elegir, y lo que vuelve es el comando del destino.
    expect(escalated.boundary.kind).toBe("blocked");
    expect(escalated.error?.code).toBe("FLOW_HANDOFF");
    expect(escalated.error?.action).toBe("/w:spec-new");
    expect(escalated.choices).toEqual([]);

    // Y el rastro es durable: releer el estado —que es exactamente lo que hace un
    // `resume`— encuentra la elección y la entrega, nunca la frontera que produce
    // el entregable.
    const resumed = await current();
    expect(resumed.state.handoff?.destination).toBe("spec-new");
    expect(resumed.state.selected_choice?.label).toBe("Escalar a spec");
    expect(resumed.state.selected_choice?.transition).toBe("quick.fix-preview-approval");
    expect(resumed.resolved.kind).toBe("blocked");
    expect(resumed.resolved.error?.code).toBe("FLOW_HANDOFF");
    expect(resumed.state.applied).toContain("quick.fix-preview-approval");
  });

  it("el gate de convergencia llega como ejecución y recién el resultado lo aplica", async () => {
    await declare([]);
    // Caminar hasta el gate contestando lo que cada frontera admite.
    for (let step = 0; step < 25; step += 1) {
      const { resolved } = await current();
      if (resolved.stopped?.id === "quick.convergence-gate") break;
      if (resolved.kind === "execution") {
        await answer(resultFor(resolved));
        continue;
      }
      if (resolved.kind === "semantic") {
        await answer({
          input_digest: resolved.seal,
          decisions: decisionsFor(resolved.stopped?.id),
        });
        continue;
      }
      if (resolved.kind === "legacy") {
        await answer({
          input_digest: resolved.seal,
          fallback: resolved.stopped?.document,
          choice: "Resolver la frontera",
        });
        continue;
      }
      await answer({ input_digest: resolved.seal, choice: "Resolver la frontera" });
    }

    // Correr los criterios que la corrida misma declaró es contabilidad propia:
    // custodia de la corrida cubre el `execute` y la frontera emitida nombra la
    // invocación directamente, sin preflight que nadie tenga nada que decidir.
    const gate = await current();
    expect(gate.resolved.stopped?.id).toBe("quick.convergence-gate");
    expect(gate.resolved.kind).toBe("execution");
    expect(gate.resolved.action).not.toBeNull();
    expect(gate.resolved.authorization?.missing ?? []).toEqual([]);

    // La custodia no es crédito: nada se aplica hasta que vuelve salida real, y
    // una validación que falló no cierra el gate.
    expect(gate.state.applied).not.toContain("quick.convergence-gate");
    const failed = await answer(
      resultFor(gate.resolved, {
        validations: [{ id: "quick.criterios-verdes", passed: false, detail: "2 tests en rojo" }],
      }),
    );
    expect(failed.error?.code).toBe("FLOW_EVIDENCE_MISSING");
    const refused = await current();
    expect(refused.state.effects.applied).not.toContain("execute");
    // El resultado rechazado declaró `execute` aplicado, así que dejó su rastro
    // en la traza — y la traza es parte de la posición. La respuesta siguiente
    // va sobre la frontera recalculada, que es la que devuelve el propio
    // rechazo: nada se acreditó, pero el estado ya no es el mismo.
    const green = await answer(resultFor(refused.resolved));
    expect(green.error).toBeNull();
    expect(green.effects.applied).toContain("execute");
  });

  /** Whatever the boundary in force admits, answered the way the run would. */
  async function answerBoundary(
    resolved: Awaited<ReturnType<typeof current>>["resolved"],
  ): Promise<void> {
    await answerReturning(resolved);
  }

  /** Igual que {@link answerBoundary}, devolviendo la directiva recalculada. */
  async function answerReturning(
    resolved: Awaited<ReturnType<typeof current>>["resolved"],
  ): Promise<FlowDirective> {
    const stopped = resolved.stopped as FlowDecision;
    if (resolved.kind === "execution") {
      return await answer(resultFor(resolved));
    }
    if (resolved.kind === "authorization") {
      return await answer(
        { input_digest: resolved.seal, choice: "Autorizar el efecto" },
        effectApprovalDigest(stopped.id, resolved.authorization?.planned ?? []),
      );
    }
    return await answer(
      resolved.kind === "human"
        ? { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" }
        : {
            input_digest: resolved.seal,
            // Declara TODAS las señales que la fila admite, para que el recorrido
            // camine entero: una fila condicionada se salta cuando su señal no se
            // observó, y este test existe para ver los pasos, no los saltos.
            signals: [...(stopped.signals ?? [])],
            decisions: decisionsFor(stopped.id),
          },
    );
  }

  /**
   * Camina el recorrido entero declarando, en cada frontera semántica, las señales
   * que `porFila` indique para ella — y todas las que la fila admita cuando no la
   * menciona. Devuelve los pasos que quedaron omitidos, con su motivo.
   */
  async function walkDeclaring(
    porFila: Record<string, string[]>,
  ): Promise<Array<{ id: string; reason: string }>> {
    const saltadas: Array<{ id: string; reason: string }> = [];
    const recordar = (directive: FlowDirective): void => {
      for (const applied of directive.applied) {
        if (applied.outcome === "skipped") {
          saltadas.push({ id: applied.transition, reason: applied.reason ?? "" });
        }
      }
    };
    recordar(await declare([]));
    for (let step = 0; step < 20; step += 1) {
      const { resolved } = await current();
      if (resolved.stopped === null) return saltadas;
      const stopped = resolved.stopped as FlowDecision;
      const override = porFila[stopped.id];
      recordar(
        resolved.kind === "semantic" && override !== undefined
          ? await answer({
              input_digest: resolved.seal,
              signals: override,
              decisions: decisionsFor(stopped.id),
            })
          : await answerReturning(resolved),
      );
    }
    return saltadas;
  }

  it("ninguna transversal decide ya desde su documento: el recorrido llega al final", async () => {
    // Las cinco que el piloto dejó atrás viajaron con PLAN, así que QUICK ya no
    // tiene ninguna frontera legacy. Lo que el recorrido demuestra ahora es lo
    // contrario de lo que demostraba: camina entero, y la rama y el script de la
    // sesión siguen exigiendo salida real en el camino.
    await declare([]);
    const seen: string[] = [];
    for (let step = 0; step < 20; step += 1) {
      const { resolved } = await current();
      if (resolved.stopped === null) {
        expect(seen).toContain("quick.branch-precondition");
        expect(seen).toContain("quick.db-scripts-only");
        return;
      }
      expect(resolved.kind, resolved.stopped.id).not.toBe("legacy");
      if (resolved.kind === "execution") seen.push(resolved.stopped.id);
      await answerBoundary(resolved);
    }
    throw new Error("el recorrido nunca llegó al final");
  });

  // El otro sentido de la misma regla, y el que importa: un quick que no toca
  // ninguna base de datos no tiene sentencia que derivar, así que la regla de
  // scripts-only se SALTA con su razón en vez de exigir un SCRIPTS.sql que no
  // debería existir. Antes exigía el efecto igual.
  it("un quick que no toca base de datos se salta la regla de scripts-only, con su razón", async () => {
    const saltadas = await walkDeclaring({ "quick.db-touched": [] });
    const scripts = saltadas.find((x) => x.id === "quick.db-scripts-only");
    expect(scripts, "la regla de scripts-only tenía que saltarse").toBeDefined();
    expect(scripts?.reason).toContain("no tocó ninguna base de datos");
  });
});

describe("resume y status proyectan la frontera vigente", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-tramo-quick-proj-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — tramo quick\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("una sesión sin corrida no inventa ninguna", async () => {
    expect(await projectRun(fs, paths, SESSION)).toBeNull();
  });

  it("la proyección nombra la frontera y, si hay que ejecutar, la invocación exacta", async () => {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");

    const semantic = await projectRun(fs, paths, SESSION);
    expect(semantic?.boundary).toBe("semantic");
    expect(semantic?.transition).toBe("quick.entry-gate-signal");
    // Lo que se fija sigue siendo lo mismo —el flag proyectado tiene que ser uno
    // que el comando `flow` LEA, porque proyectar otro deja un comando que no
    // corre— y lo que cambió es cuál: `aw flow` acepta `--code`, la misma
    // ortografía que `worktree`, `check-branch` y `sources`. Antes proyectaba
    // `--session` justamente porque era el único que leía.
    expect(semantic?.command).toContain("--code");
    expect(semantic?.command).toBe(`aw flow advance --code ${SESSION}`);

    const submitted = await submitFlow(fs, paths, {
      code: CODE,
      raw: JSON.stringify({
        input_digest: adopted.directive.state_digest,
        signals: [],
        decisions: { observadas: 0 },
      }),
      approval: null,
    });
    if (!submitted.ok) throw new Error("esperaba avanzar");

    const execution = await projectRun(fs, paths, SESSION);
    expect(execution?.boundary).toBe("execution");
    expect(execution?.transition).toBe("quick.session-create");
    expect(execution?.invocation).toBe(`aw session-artifacts --code ${SESSION}`);
    // El comando que continúa la corrida ES la invocación: nadie tiene que
    // reconstruirla leyendo prosa.
    expect(execution?.command).toBe(`aw session-artifacts --code ${SESSION}`);
    expect(execution?.summary).toContain("aw flow submit");
  });

  it("una corrida anterior al cutover no se proyecta: entra por re-adopción", async () => {
    const stale = {
      version: 2,
      flow: "quick",
      session: SESSION,
      applied: [],
      boundary: null,
      pending_action: null,
      observations: [],
      authorizations: [],
      effects: { planned: [], approved: [], applied: [] },
      attempts: [],
      digest: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    };
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE),
      `${JSON.stringify(stale)}\n`,
      "utf8",
    );
    const projected = await projectRun(fs, paths, SESSION);
    expect(projected?.boundary).toBe("blocked");
    expect(projected?.summary).toContain("FLOW_RUN_VERSION_UNSUPPORTED");
    // Exacto, no "contiene --adopt": el flag con el que se identifica la sesión es
    // el que el comando `flow` lee, y proyectar otro deja un comando que no corre.
    expect(projected?.command).toBe(`aw flow advance --code ${SESSION} --adopt`);
    // Y el archivo sigue intacto: proyectar es leer.
    const raw = await readFile(join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE), "utf8");
    expect(raw).toContain('"version":2');
  });
});
