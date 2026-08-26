import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  actionOf,
  conditionOf,
  decisionsOfScope,
  effectsOf,
  flowOfScope,
  journeyForState,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * PLAN, dirigido por el CLI — el tercer tramo, y el que más efecto tiene.
 *
 * Lo que se fija acá:
 *
 * 1. **La elegibilidad de un batch es una regla, no criterio del agente.** El
 *    agente declara qué hecho observable rompe la elegibilidad; el CLI decide qué
 *    cuesta ese hecho. Un rango sin hechos declarados entra continuo, y el paso
 *    que lo aísla queda omitido con su motivo.
 * 2. **Toda escritura pasa por la acción sellada, y la custodia no es crédito.**
 *    El estado de fase, las casillas y el sello `done` son la contabilidad de la
 *    propia corrida sobre su plan-doc: custodia de la corrida —sin preflight— y
 *    solo el resultado real las aplica.
 * 3. **Un chequeo no corrido nunca habilita un commit, y aprobar no es
 *    ejecutar.** La habilitación está detrás de la validación delegada y de la
 *    revisión; aprobar los commits ES autorizar su efecto, y la ejecución sigue
 *    exigiendo su propia evidencia.
 * 4. **El tramo es el documento.** `CODE-POLICIES` y `DB-SCRIPTS-ONLY` viajaron
 *    acá porque sus únicos lectores —`quick` y `plan-exec`— ya están migrados;
 *    `SPLIT-GATE` y `DESIGN-REFERENCES` siguen siendo de la doctrina.
 */

const fs = new NodeFileSystem();
const SESSION = "031-tramo-plan-plan-exec";
const CODE = "031";

const ALIAS = "acme";
const PLAN_DOC = "docs/plans/031-plan-tramo.md";
const WORKSPACE_BLOCK = `<!-- AGENT-WORKFLOW-PROJECT-START -->
## Proyecto

Tramo plan.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| ${ALIAS} | /tmp/acme | main |

## Status

- Ramas de trabajo actuales:
  - ${ALIAS}: main
<!-- AGENT-WORKFLOW-PROJECT-END -->
`;

const EXEC = journeyOfFlow("plan-exec");
const NEW = journeyOfFlow("plan-new");
const REFINE = journeyOfFlow("plan-refine");

function rowOf(journey: readonly FlowDecision[], id: string): FlowDecision {
  const row = journey.find((decision) => decision.id === id);
  if (row === undefined) throw new Error(`el recorrido ya no tiene '${id}'`);
  return row;
}

/** Position of `id` inside its journey — the order IS the doctrine. */
function at(journey: readonly FlowDecision[], id: string): number {
  const index = journey.findIndex((decision) => decision.id === id);
  if (index < 0) throw new Error(`el recorrido ya no tiene '${id}'`);
  return index;
}

describe("el tramo PLAN migró como dato, y el orden de sus filas es la doctrina", () => {
  it("las tres jornadas quedaron sin una sola fila de la doctrina", () => {
    for (const [scope, journey] of [
      ["plan-new", NEW],
      ["plan-refine", REFINE],
      ["plan-exec", EXEC],
    ] as const) {
      expect(
        journey.filter((row) => row.ownership === "legacy").map((row) => row.id),
        scope,
      ).toEqual([]);
    }
  });

  it("en refine la escritura va DESPUÉS del gate y de la confirmación", () => {
    // El registro tenía las dos escrituras por delante del gate, así que la
    // persona habría confirmado un plan ya sobrescrito. Hoy hay UNA sola
    // escritura y su lugar es el mismo: después del gate, después de la propuesta
    // y después de la aprobación. Reducir el original y extraer los hermanos
    // dejó de ser una escritura — decide qué bytes se proponen — y por eso va
    // antes: lo que se aprueba es el resultado de esa decisión, ya visible.
    expect(at(REFINE, "plan-refine.save-proposal")).toBeGreaterThan(
      at(REFINE, "plan-refine.executability-gate"),
    );
    expect(at(REFINE, "plan-refine.split-in-place")).toBeLessThan(
      at(REFINE, "plan-refine.save-proposal"),
    );
    expect(at(REFINE, "plan-refine.save-confirmation")).toBeGreaterThan(
      at(REFINE, "plan-refine.save-proposal"),
    );
    expect(at(REFINE, "plan-refine.publication")).toBeGreaterThan(
      at(REFINE, "plan-refine.save-confirmation"),
    );
    expect(effectsOf(rowOf(REFINE, "plan-refine.publication"))).toContain("mutate_overwrite");
  });

  it("un chequeo no corrido no puede habilitar un commit: la regla es posicional", () => {
    // No hay campo que alguien pueda poner para llegar al commit sin pasar por
    // la validación delegada y por la revisión. Ese es el enunciado entero.
    const validation = rowOf(EXEC, "plan-exec.validation-execution");
    expect(actionOf(validation)).not.toBeNull();
    expect(effectsOf(validation)).toContain("execute");
    for (const [earlier, later] of [
      ["plan-exec.validation-execution", "plan-exec.review-findings"],
      ["plan-exec.review-findings", "plan-exec.final-validation"],
      // La validación final va ANTES de Git, y eso no se movió: el recorrido real
      // destapó el orden inverso, heredado del registro, que habría dejado el plan
      // commiteado y sólo después validado.
      ["plan-exec.final-validation", "plan-exec.commit-enablement"],
      ["plan-exec.commit-enablement", "plan-exec.commit-authorization"],
      // Lo que SÍ se movió es el sello `done`, y va después de Git. Este test lo
      // fijaba al revés con una justificación que el aislamiento dejó sin objeto:
      // el `done` iba antes del commit "para que la escritura del estado entre en
      // ese mismo commit". Con la corrida editando en una unidad eso ya no puede
      // pasar —el plan-doc vive en el workspace y el commit aterriza en la rama de
      // la unidad, que son dos repos— así que lo único que quedaba del orden viejo
      // era sellar `done` sobre trabajo que todavía no estaba en ninguna rama de
      // trabajo. El orden nuevo dice la verdad: commitear la unidad, integrarla, y
      // recién entonces declarar cerrado el plan.
      ["plan-exec.commit-authorization", "plan-exec.commit-execution"],
      ["plan-exec.commit-execution", "plan-exec.unit-integration"],
      ["plan-exec.unit-integration", "plan-exec.plan-done"],
    ]) {
      expect(at(EXEC, later), `${earlier} → ${later}`).toBeGreaterThan(at(EXEC, earlier));
    }
  });

  it("la integración es la única fila del recorrido que escribe fuera de la corrida", () => {
    const integration = rowOf(EXEC, "plan-exec.unit-integration");
    expect(effectsOf(integration)).toEqual(["execute", "mutate_overwrite"]);
    // Sin custodia, a propósito: `custody: "run"` cubre lo que la corrida se
    // escribe a sí misma, y un merge sobre la rama de trabajo de la fuente es lo
    // contrario. Por eso para en una frontera de autorización, y por eso NO
    // alcanza con la aprobación de los commits: aprobar qué se registra en la
    // unidad propia y aprobar que eso aterrice en la rama compartida son dos
    // decisiones, y sólo la segunda puede chocar con el trabajo de otro.
    expect(integration.custody).toBeUndefined();
    expect(
      EXEC.filter((row) => actionOf(row) !== null && row.custody === undefined).map((r) => r.id),
    ).toContain("plan-exec.unit-integration");
    // Delegada aunque este CLI tenga el servicio: su modo de falla —un conflicto—
    // abre un recorrido de persona (`aw fix-git`), no de ejecutor.
    expect(actionOf(integration)?.execution.kind).toBe("external");
    expect(actionOf(integration)?.invocation.args).toEqual([
      "worktree",
      "integrate",
      "--code",
      "{code}",
    ]);
    // Re-entrante: es la transición a la que VUELVE un conflicto resuelto.
    expect(actionOf(integration)?.idempotent).toBe(true);
    expect(actionOf(integration)?.recovery).toContain("fix-git");
  });

  it("autorizar no es ejecutar: el commit es un efecto propio con su evidencia", () => {
    const approval = rowOf(EXEC, "plan-exec.commit-authorization");
    expect(approval.authority).toBe("human");
    expect(actionOf(approval)).toBeNull();

    const commit = rowOf(EXEC, "plan-exec.commit-execution");
    expect(commit.authority).toBe("cli");
    expect(effectsOf(commit)).toContain("execute");
    expect(actionOf(commit)?.evidence).toEqual(["plan.commits-por-fuente"]);
    // Un commit no es re-ejecutable a ciegas, y la fila lo dice.
    expect(actionOf(commit)?.idempotent).toBe(false);
  });

  it("el cierre de tareas y fase pasa por un único CAS interno, no por ediciones manuales", () => {
    const close = rowOf(EXEC, "plan-exec.batch-close");
    expect(effectsOf(close)).toContain("mutate_overwrite");
    expect(actionOf(close)?.execution).toEqual({
      kind: "internal",
      operation: "plan-exec.batch-close",
    });
    expect(actionOf(close)?.evidence).toEqual(["plan.batch-publicado"]);
    expect(EXEC.map((row) => row.id)).not.toEqual(
      expect.arrayContaining([
        "plan-exec.pending-effects",
        "plan-exec.task-marking",
        "plan-exec.phase-state-transition",
      ]),
    );

    // `done` remains a distinct final seal after Git/integration; it cannot be
    // confused with accrediting one batch's checkboxes and phase state.
    const done = rowOf(EXEC, "plan-exec.plan-done");
    expect(actionOf(done)?.execution).toEqual({
      kind: "internal",
      operation: "plan-exec.plan-done",
    });
    expect(actionOf(done)?.invocation.args).toEqual(["flow", "advance", "--code", "{code}"]);
    expect(actionOf(done)?.evidence).toEqual(["plan.estado-done-sellado"]);
  });

  it("ninguna fila de flow acredita una escritura que nada ejecutó", () => {
    // El recorrido real de refine lo destapó: `normalize-on-write` se autorizaba y
    // se aplicaba sola, así que la corrida registraba "normalizado" sin que nadie
    // hubiera escrito nada. La regla vale para TODO flow migrado — un efecto que
    // el motor no puede materializar tiene que volver con resultado.
    const SELF = ["read_only", "local_additive"];
    const offenders = FLOW_DECISIONS.filter(
      (row) =>
        row.ownership === "cli-owned" &&
        flowOfScope(row.scope) !== null &&
        actionOf(row) === null &&
        effectsOf(row).some((effect) => !SELF.includes(effect)),
    );
    expect(offenders.map((row) => row.id)).toEqual([]);
  });

  it("la precondición de rama nunca es una lectura que pasa sola", () => {
    // `aw check-branch` sin --source no resuelve ningún target y contesta
    // `match: true` incondicional: nombrarlo acá habría acreditado "rama
    // verificada" contra un comando que no miró nada. Lo destapó el recorrido
    // real, igual que el defecto del flag en el tramo QUICK.
    //
    // `quick` sigue leyendo TODAS las fuentes declaradas, que es su caso: edita
    // el checkout. `plan-exec` no — edita en unidades, y `aw sources` informa el
    // checkout compartido, así que con dos corridas sobre el mismo source esa
    // lectura daba verde por la rama de trabajo de otro. Su evidencia es la
    // lectura ligada a la sesión, donde una fuente sin unidad simplemente no
    // aparece.
    const quick = FLOW_DECISIONS.find((d) => d.id === "quick.branch-precondition") as FlowDecision;
    expect(actionOf(quick)?.invocation.args).toEqual(["sources", "--verbose"]);

    const exec = rowOf(EXEC, "plan-exec.branch-precondition");
    expect(actionOf(exec)?.invocation.args).toEqual(["worktree", "list", "--code", "{code}"]);
    expect(actionOf(exec)?.evidence).toEqual(["plan.rama-verificada"]);
    // Y el commit se acredita sobre las mismas unidades, por lo mismo: el commit
    // aterriza en la rama de la unidad, no en el checkout.
    const commit = rowOf(EXEC, "plan-exec.commit-execution");
    expect(actionOf(commit)?.invocation.args).toEqual(["worktree", "list", "--code", "{code}"]);
  });

  it("la unidad se adquiere ANTES de la primera escritura, y sobre el scope que el CLI validó", () => {
    // El orden ES la regla: una unidad obtenida después de la primera edición es
    // un aislamiento que no aisló nada. Y el scope va antes que la adquisición
    // porque es lo que dice cuántas unidades hay que adquirir.
    for (const [earlier, later] of [
      ["plan-exec.source-scope", "plan-exec.unit-acquisition"],
      ["plan-exec.unit-acquisition", "plan-exec.branch-precondition"],
      ["plan-exec.branch-precondition", "plan-exec.implementation"],
    ]) {
      expect(at(EXEC, later), `${earlier} → ${later}`).toBeGreaterThan(at(EXEC, earlier));
    }
    const scope = rowOf(EXEC, "plan-exec.source-scope");
    // Juicio del agente, sin acción ni efecto propio: lo que la respuesta trae son
    // datos, y validarlos es del CLI.
    expect(scope.authority).toBe("agent");
    expect(actionOf(scope)).toBeNull();
    expect(scope.scopes_sources).toBe(true);

    const acquire = rowOf(EXEC, "plan-exec.unit-acquisition");
    expect(acquire.authority).toBe("cli");
    expect(effectsOf(acquire)).toEqual(["local_additive"]);
    // Interna: el CLI tiene el servicio de worktrees y pedirle a otro que lo corra
    // sería devolverle trabajo que este proceso hace. Idempotente, que es lo que
    // hace que reanudar reutilice la misma unidad en vez de cortar otra.
    expect(actionOf(acquire)?.execution).toEqual({
      kind: "internal",
      operation: "worktree.ensure",
    });
    expect(actionOf(acquire)?.idempotent).toBe(true);
  });

  it("cada acción delegada del tramo invoca un comando registrado", () => {
    const registered = new Set(ALL_COMMANDS.map((command) => command.name));
    for (const journey of [NEW, REFINE, EXEC]) {
      for (const decision of journey) {
        const action = actionOf(decision);
        if (action === null) continue;
        expect(action.invocation.program, decision.id).toBe("aw");
        expect(registered.has(action.invocation.args[0] ?? ""), decision.id).toBe(true);
        expect(action.evidence.length, decision.id).toBeGreaterThan(0);
        expect(action.recovery.trim().length, decision.id).toBeGreaterThan(0);
      }
    }
  });

  it("la elegibilidad del batch es la misma regla en las tres jornadas", () => {
    for (const [scope, journey] of [
      ["plan-new", NEW],
      ["plan-refine", REFINE],
      ["plan-exec", EXEC],
    ] as const) {
      const isolation = journey.find((row) => row.id.endsWith(".batch-isolation"));
      const condition = conditionOf(isolation as FlowDecision);
      // Un solo hecho basta: "anything else is `isolated`" es exactamente eso.
      expect(condition?.threshold.min, scope).toBe(1);
      // Y observa la fila de SU jornada: un umbral que mira otra jornada nunca
      // dispara, y eso sería un paso borrado sin que nadie lo decida.
      expect(condition?.threshold.observed, scope).toBe(`${scope}.batch-eligibility-signal`);
      expect(condition?.otherwise.length, scope).toBeGreaterThan(0);
    }
  });

  it("el gate de división aplica el mismo umbral en las dos jornadas que lo tienen", () => {
    for (const [scope, journey, gated] of [
      ["plan-new", NEW, "plan-new.split-choice"],
      ["plan-refine", REFINE, "plan-refine.split-in-place"],
    ] as const) {
      const condition = conditionOf(rowOf(journey, gated));
      expect(condition?.threshold.min, scope).toBe(2);
      expect(condition?.threshold.observed, scope).toBe(`${scope}.split-signal`);
    }
  });

  it("los dos documentos compartidos que PLAN no podía tocar siguen sin ser suyos", () => {
    // PLAN's boundary, asserted from PLAN's side. When this tranche ran, the two
    // documents were still doctrine's and the case said so by listing them. The
    // closing tranche resolved each on its own terms, so what PLAN can still claim
    // is the thing that never changed: neither document is cited by a PLAN row.
    const planned = ["plan-new", "plan-refine", "plan-exec"].flatMap((scope) =>
      decisionsOfScope(scope),
    );
    expect(planned.map((row) => row.document)).not.toContain("modules/SPLIT-GATE.md");
    // PLAN cites `DESIGN-REFERENCES` exactly once, and NOT as part of the tranche:
    // `plan-exec.design-precondition` was already owned by a shipped command
    // before any of this, and it is attributed to that capability rather than to
    // the marker this tranche put in PLAN's nine documents.
    const design = planned.filter((row) => row.document === "modules/DESIGN-REFERENCES.md");
    expect(design.map((row) => row.id)).toEqual(["plan-exec.design-precondition"]);
    expect(design[0]?.attribution).toBe("`aw designs --plan`");
  });
});

describe("PLAN dirigido — sobre una corrida real en disco", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-tramo-plan-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — tramo plan\n\n## Objective\nejecutar el plan de prueba\n",
      "utf8",
    );
    // El workspace de verdad, porque el scope se valida contra él: la tabla de
    // Fuentes es lo único que decide si un alias existe, y el plan es el
    // documento contra el que se comprueba que ese alias esté nombrado.
    await writeFile(join(workdir, "CLAUDE.md"), WORKSPACE_BLOCK, "utf8");
    await mkdir(join(workdir, "docs", "plans"), { recursive: true });
    await writeFile(
      join(workdir, PLAN_DOC),
      `# Plan 031 — tramo\n\n> Límite de ejecución: checkout\n\n## Tasks\n\n### F1 — tramo\n> Fuentes: ${ALIAS}\n\n- [ ] T1.1 — recorrer el tramo _(fuentes: ${ALIAS})_\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function current() {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return {
      state: read.state,
      resolved: resolveBoundary(read.state, journeyForState(read.state)),
    };
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
                invocation: { artifact: "tests/unit/flow-tramo-plan.test.ts" },
              },
            }
          : {}),
      })),
      effects: { planned: [...declared], approved: [], applied: [...declared] },
      output: null,
      ...overrides,
    };
  }

  /** Whatever the boundary in force admits, with `signals` declared where they fit. */
  function bodyFor(
    resolved: Awaited<ReturnType<typeof current>>["resolved"],
    signals: string[],
  ): Record<string, unknown> {
    const stopped = resolved.stopped as FlowDecision;
    if (resolved.kind === "execution") return resultFor(resolved);
    if (resolved.kind === "semantic") {
      const vocabulary = stopped.signals ?? [];
      return {
        input_digest: resolved.seal,
        signals: signals.filter((signal) => vocabulary.includes(signal)),
        decisions:
          stopped.scopes_sources === true
            ? { plan: PLAN_DOC, sources: [ALIAS] }
            : { paso: stopped.id },
      };
    }
    return { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" };
  }

  /** Adopt the run and answer up to the boundary of `id`, declaring `signals` where admissible. */
  async function walkTo(id: string, signals: string[]): Promise<void> {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "plan-exec", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    for (let step = 0; step < 40; step += 1) {
      const { resolved } = await current();
      if (resolved.stopped === null || resolved.stopped.id === id) return;
      const approval =
        resolved.kind === "authorization"
          ? effectApprovalDigest(resolved.stopped.id, resolved.authorization?.planned ?? [])
          : null;
      await answer(
        approval === null
          ? bodyFor(resolved, signals)
          : { input_digest: resolved.seal, choice: "Autorizar el efecto" },
        approval,
      );
    }
    throw new Error(`el recorrido nunca llegó a '${id}'`);
  }

  it("la sesión de ejecución no se da por abierta sin leerla", async () => {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "plan-exec", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    expect(adopted.directive.boundary.kind).toBe("execution");
    expect(adopted.directive.boundary.transition).toBe("plan-exec.session");

    // Una narración no es un resultado.
    const claimed = await answer({
      input_digest: adopted.directive.state_digest,
      outcome: "completed",
      invocation: adopted.directive.action?.invocation,
      validations: [{ id: "plan.session-present", passed: true, detail: "  " }],
      effects: { planned: ["local_additive"], approved: [], applied: ["local_additive"] },
      output: null,
    });
    expect(claimed.error?.code).toBe("FLOW_EVIDENCE_MISSING");
    // Los dos pasos transversales del prefijo ya se aplicaron —fijan la carpeta
    // escribible y el tope de intentos antes de que nada corra—, así que lo que
    // se afirma es lo que el resultado NO acreditó: la sesión sigue sin abrirse.
    expect((await current()).state.applied).not.toContain("plan-exec.session");
  });

  it("sin hueco declarado, ni la severidad ni la normalización se preguntan", async () => {
    await walkTo("plan-exec.batch-eligibility-signal", []);
    const { state } = await current();
    expect(state.skipped).toContain("plan-exec.entry-gap-severity");
    expect(state.skipped).toContain("plan-exec.normalization-consent");
  });

  it("un hueco menor abre la consulta; uno estructural clasifica pero no la ofrece", async () => {
    await walkTo("plan-exec.normalization-consent", ["plan.entry-gap-minor"]);
    const minor = await current();
    expect(minor.resolved.kind).toBe("human");
    expect(minor.resolved.choices.map((choice) => choice.label)).toEqual([
      "Normalizar y ejecutar",
      "Ir a plan-refine",
      "Compactar",
      "Cerrar",
    ]);
    expect(minor.state.skipped).not.toContain("plan-exec.entry-gap-severity");
  });

  it("declarar SOLO el hueco estructural no ofrece normalizar nada", async () => {
    await walkTo("plan-exec.batch-eligibility-signal", ["plan.entry-gap-structural"]);
    const { state } = await current();
    // La severidad se clasificó —hubo un hueco— y la normalización quedó omitida.
    expect(state.skipped).not.toContain("plan-exec.entry-gap-severity");
    expect(state.skipped).toContain("plan-exec.normalization-consent");
  });

  it("sin hecho que rompa la elegibilidad, el rango no se aísla", async () => {
    await walkTo("plan-exec.branch-precondition", []);
    const { state } = await current();
    expect(state.skipped).toContain("plan-exec.batch-isolation");
  });

  it("un hecho declarado aísla el rango, y la omisión desaparece", async () => {
    await walkTo("plan-exec.branch-precondition", ["plan.recovery-boundary"]);
    const { state } = await current();
    expect(state.skipped).not.toContain("plan-exec.batch-isolation");
    expect(state.applied).toContain("plan-exec.batch-isolation");
  });

  it("un batch se cierra después de validar y revisar, antes del resto del cierre", () => {
    expect(at(EXEC, "plan-exec.batch-close")).toBeGreaterThan(
      at(EXEC, "plan-exec.validation-execution"),
    );
    expect(at(EXEC, "plan-exec.batch-close")).toBeGreaterThan(
      at(EXEC, "plan-exec.review-findings"),
    );
    expect(at(EXEC, "plan-exec.batch-close")).toBeLessThan(at(EXEC, "plan-exec.final-validation"));
  });

  it("una validación de fase en rojo no habilita nada de lo que viene después", async () => {
    await walkTo("plan-exec.validation-execution", []);
    // Correr las pruebas que el plan declara es la corrida verificándose a sí
    // misma: custodia cubre el `execute` y la frontera llega como ejecución. Lo
    // innegociable no era el preflight sino la salida real, y eso queda.
    const running = await current();
    expect(running.resolved.stopped?.id).toBe("plan-exec.validation-execution");
    expect(running.resolved.kind).toBe("execution");

    const failed = await answer(
      resultFor(running.resolved, {
        validations: [
          { id: "plan.validaciones-de-fase-verdes", passed: false, detail: "2 pruebas en rojo" },
        ],
      }),
    );
    expect(failed.error?.code).toBe("FLOW_EVIDENCE_MISSING");
    // La transición sigue pendiente, así que la habilitación del commit —que está
    // detrás de ella— es inalcanzable.
    const after = await current();
    expect(after.state.applied).not.toContain("plan-exec.validation-execution");
    expect(after.state.applied).not.toContain("plan-exec.commit-enablement");
    expect(after.resolved.stopped?.id).toBe("plan-exec.validation-execution");
  });

  it("aprobar los commits ES el grant, y el commit sigue exigiendo su resultado real", async () => {
    await walkTo("plan-exec.commit-authorization", []);
    const approval = await current();
    expect(approval.resolved.kind).toBe("human");
    expect(approval.resolved.choices.map((choice) => choice.label)).toEqual([
      "Aprobar los commits del batch",
      "Dejar el batch sin commitear",
      "Compactar",
      "Cerrar",
    ]);

    const approved = await answer({
      input_digest: approval.resolved.seal,
      choice: "Aprobar los commits del batch",
    });
    // La aprobación aplicó la preferencia Y registró el grant sobre el sello
    // exacto de la ejecución del commit: decidir una vez es autorizar una vez, y
    // el grant no cubre ninguna otra transición. Lo siguiente ES el commit, que es
    // el orden que el aislamiento impone: primero se registra el trabajo en la
    // unidad, después se lo lleva a la rama compartida, y sólo al final se sella el
    // plan.
    expect(approved.boundary.transition).toBe("plan-exec.commit-execution");
    const after = await current();
    expect(after.state.applied).toContain("plan-exec.commit-authorization");
    expect(after.state.applied).not.toContain("plan-exec.commit-execution");
    const commitSeal = effectApprovalDigest("plan-exec.commit-execution", [
      ...effectsOf(rowOf(EXEC, "plan-exec.commit-execution")),
    ]);
    expect(after.state.authorizations.map((grant) => grant.digest)).toContain(commitSeal);

    // El commit no re-pregunta: el grant humano ya viaja con la corrida y la
    // frontera emitida nombra la invocación — que todavía tiene que volver con el
    // estado git real. Y esa invocación es la lectura por unidad, ligada al código
    // de la sesión: el commit del batch aterriza en la rama de la unidad, y leer el
    // checkout compartido acá dejaría verde un batch que no commiteó nada.
    expect(after.resolved.kind).toBe("execution");
    expect(approved.action?.invocation.args).toEqual(["worktree", "list", "--code", SESSION]);
    // El grant no aplicó nada: la transición del commit sigue pendiente de su
    // salida real (el `execute` del ledger es el de la validación ya corrida).
    const committed = await answer(resultFor(after.resolved));

    // Y acá está la frontera que el grant del commit NO cubre: integrar escribe en
    // la rama que todos leen, no en los libros de la corrida, así que se pregunta.
    // Que sea una autorización distinta es el enunciado: aprobar los commits de un
    // batch no es aprobar que aterricen sobre el trabajo de otro.
    expect(committed.boundary.transition).toBe("plan-exec.unit-integration");
    expect(committed.boundary.kind).toBe("authorization");
    const pending = await current();
    const authorized = await answer(
      { input_digest: pending.resolved.seal, choice: "Autorizar el efecto" },
      effectApprovalDigest(
        "plan-exec.unit-integration",
        pending.resolved.authorization?.planned ?? [],
      ),
    );
    expect(authorized.boundary.kind).toBe("execution");
    expect(authorized.action?.invocation.args).toEqual([
      "worktree",
      "integrate",
      "--code",
      SESSION,
    ]);

    // Recién después del merge se sella el plan: el `done` es la marca de avance
    // del propio plan-doc (custodia de la corrida) y ahora es verdad de una rama
    // que alguien puede leer.
    const integrated = await answer(resultFor((await current()).resolved));
    expect(integrated.boundary.transition).toBe("plan-exec.plan-done");
    expect(integrated.boundary.kind).toBe("execution");
    expect(integrated.action?.invocation.args).toEqual(["flow", "advance", "--code", SESSION]);
    expect((await current()).state.applied).toContain("plan-exec.unit-integration");
  });
});
