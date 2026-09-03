import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { validatePlanSourceBoundary } from "../../src/application/source-boundary-policy.js";
import { type FlowDecision, effectsOf, journeyForState } from "../../src/domain/flow/authority.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import {
  FLOW_RUN_STATE_FILE,
  type FlowRunState,
  attemptAccountingAt,
  attemptReconciliationsOf,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { acceptAdaptiveRoute } from "../helpers/accept-adaptive-route.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * El incidente, reproducido de punta a punta.
 *
 * La forma exacta que lo produjo, en un solo caso: un plan de migración de otro
 * proyecto, cuyas validaciones de fase son inspecciones locales sobre rutas que
 * no empiezan por ninguno de los cinco prefijos de ESTE repo, y una corrida cuya
 * contabilidad quedó desajustada con una única lectura posible — el contador
 * declarando más intentos que las filas persistidas, que es lo que deja
 * restaurar una copia anterior del ledger.
 *
 * Lo que se fija es el resultado que el usuario pidió: el recorrido llega a su
 * primera tarea sin ningún refinamiento y sin ninguna interacción humana además
 * de las que ya tenía.
 */

const fs = new NodeFileSystem();
const SESSION = "001-migracion-plan-exec";
const CODE = "001";
const ALIAS = "selva";
const PLAN_DOC = "docs/plans/001-plan-migracion.md";

const WORKSPACE_BLOCK = `<!-- AGENT-WORKFLOW-PROJECT-START -->
## Proyecto

Migración de otro proyecto.

## Fuentes

| Alias | Path | Rama principal |
|---|---|---|
| ${ALIAS} | /tmp/selva | main |

## Status

- Ramas de trabajo actuales:
  - ${ALIAS}: main
<!-- AGENT-WORKFLOW-PROJECT-END -->
`;

/**
 * El plan del incidente: sus validaciones describen comprobaciones locales
 * perfectamente reproducibles, y no contienen NINGUNO de los términos que la
 * compuerta usaba como lista blanca.
 */
const PLAN_TEXT = [
  "# Plan 001 — migración",
  "",
  "> Límite de ejecución: checkout",
  "> Estado: open",
  "",
  "## Tasks",
  "",
  "### F1 — Las columnas nuevas existen",
  "> Estado: pendiente",
  `> Fuentes: ${ALIAS}`,
  "",
  `- [ ] T1.1 — Agregar las tres columnas al esquema _(fuentes: ${ALIAS})_`,
  "",
  "**Resultado:** el esquema declara las tres columnas nuevas.",
  "**Validación de fase:** aplicar `migraciones/003_add_columns.sql` sobre una base de trabajo y comparar la salida con `db/esperado/003.txt`.",
  "**Condición de salida:** el catálogo declara las tres columnas.",
  "",
  "## Execution batches",
  "",
  "- B1 · isolated · F1",
  "",
  "## Validations",
  "",
  "- El catálogo queda igual al aplicar `migraciones/` completo dos veces seguidas.",
  "",
].join("\n");

describe("el incidente completo — de la entrada a la primera tarea, sin refinamiento", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-incidente-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — migración\n\n## Objective\nejecutar la migración 001\n",
      "utf8",
    );
    await writeFile(join(workdir, "CLAUDE.md"), WORKSPACE_BLOCK, "utf8");
    await mkdir(join(workdir, "docs", "plans"), { recursive: true });
    await writeFile(join(workdir, PLAN_DOC), PLAN_TEXT, "utf8");
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const statePath = (): string => join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE);

  async function state(): Promise<{
    state: FlowRunState;
    resolved: ReturnType<typeof resolveBoundary>;
  }> {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return {
      state: read.state,
      resolved: resolveBoundary(read.state, journeyForState(read.state)),
    };
  }

  async function answer(body: unknown): Promise<FlowDirective> {
    const result = await submitFlow(fs, paths, { code: CODE, raw: JSON.stringify(body) });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
    return result.directive;
  }

  function evidenceFor(id: string): Record<string, unknown> {
    const base = { id, passed: true, detail: `salida real de ${id}` };
    if (id !== "workline.source-bounded") return base;
    return {
      ...base,
      proof: {
        kind: "inspection" as const,
        source: "workspace",
        relative_cwd: ".",
        checkout_digest: "test-checkout",
        invocation: { artifact: "tests/unit/flow-incidente-ceremonia.test.ts" },
      },
    };
  }

  function bodyFor(
    resolved: Awaited<ReturnType<typeof state>>["resolved"],
  ): Record<string, unknown> {
    const stopped = resolved.stopped as FlowDecision;
    if (resolved.kind === "execution") {
      const action = resolved.action;
      if (action === null) throw new Error("una frontera de ejecución sin invocación");
      const declared = effectsOf(stopped);
      return {
        input_digest: resolved.seal,
        outcome: "completed",
        invocation: action.invocation,
        validations: action.evidence.map(evidenceFor),
        effects: { planned: [...declared], approved: [], applied: [...declared] },
        output: null,
      };
    }
    return {
      input_digest: resolved.seal,
      signals: [],
      decisions:
        stopped.scopes_sources === true
          ? { plan: PLAN_DOC, sources: [ALIAS] }
          : { paso: stopped.id },
    };
  }

  /** Contesta hasta la primera frontera que EVALÚA una respuesta. */
  async function walkToFirstSemantic(): Promise<void> {
    for (let step = 0; step < 10; step += 1) {
      const current = await state();
      if (current.resolved.stopped === null) {
        throw new Error("el recorrido terminó demasiado pronto");
      }
      if (current.resolved.kind === "semantic") return;
      await answer(bodyFor(current.resolved));
    }
    throw new Error("el recorrido nunca llegó a una frontera semántica");
  }

  /** El desenlace del recorrido: qué lo paró, y qué le preguntó a una persona. */
  interface WalkOutcome {
    humanBoundaries: string[];
    errors: { code: string; action: string }[];
  }

  /** Qué es esta frontera para el recorrido: llegada, bloqueo, persona, o seguir. */
  type StepVerdict =
    | { kind: "arrived" }
    | { kind: "blocked"; code: string; action: string }
    | { kind: "human"; transition: string }
    | { kind: "answer" };

  function verdictOf(resolved: Awaited<ReturnType<typeof state>>["resolved"]): StepVerdict {
    const stopped = resolved.stopped;
    if (stopped === null || stopped.id === "plan-exec.implementation") return { kind: "arrived" };
    if (resolved.error !== null) {
      return { kind: "blocked", code: resolved.error.code, action: resolved.error.action };
    }
    if (resolved.kind === "human" || resolved.kind === "authorization") {
      return { kind: "human", transition: stopped.id };
    }
    return { kind: "answer" };
  }

  /** Contesta hasta la primera tarea, anotando todo lo que se interpuso. */
  async function walkToFirstTask(): Promise<WalkOutcome> {
    const out: WalkOutcome = { humanBoundaries: [], errors: [] };
    for (let step = 0; step < 40; step += 1) {
      const current = await state();
      const verdict = verdictOf(current.resolved);
      if (verdict.kind === "arrived") return out;
      if (verdict.kind === "blocked") {
        out.errors.push({ code: verdict.code, action: verdict.action });
        return out;
      }
      if (verdict.kind === "human") {
        out.humanBoundaries.push(verdict.transition);
        return out;
      }
      const directive = await answer(bodyFor(current.resolved));
      if (directive.error !== null) {
        out.errors.push({ code: directive.error.code, action: directive.error.action });
        return out;
      }
    }
    throw new Error("el recorrido nunca llegó a su primera tarea");
  }

  it("la compuerta acepta las cláusulas del incidente tal como están escritas", () => {
    // El punto de partida, dicho sobre los bytes del plan: ninguna cláusula de
    // cierre nombra una prueba, y ninguna es rechazada.
    expect(validatePlanSourceBoundary(PLAN_TEXT, [ALIAS])).toEqual([]);
    expect(PLAN_TEXT).not.toMatch(/\b(prueba|test|fixture|inspecci[oó]n|lint|typecheck|golden)\b/i);
  });

  it("llega a su primera tarea con los intentos intactos, sin degradación y sin frontera humana", async () => {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "plan-exec", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    await acceptAdaptiveRoute(fs, paths, SESSION);

    // Hasta la primera frontera semántica, que es donde una respuesta se EVALÚA
    // y por lo tanto cuesta un intento.
    await walkToFirstSemantic();
    const gap = await state();
    const stopped = gap.resolved.stopped;
    if (stopped === null || gap.resolved.kind !== "semantic") {
      throw new Error("esperaba una frontera semántica vigente");
    }

    // El desajuste, producido como ocurre: dos respuestas que la frontera evalúa
    // y rechaza dejan el contador en 2, y restaurar la copia anterior del estado
    // deja esas dos cuentas sobre cero filas persistidas — que es exactamente lo
    // que pasa cuando se restaura una copia anterior del ledger.
    const clean = await readFile(statePath(), "utf8");
    for (let turn = 0; turn < 3; turn += 1) {
      const current = await state();
      const refused = await answer({
        input_digest: current.resolved.seal,
        signals: ["plan.senal-que-no-existe"],
      });
      expect(refused.error).not.toBeNull();
    }
    await writeFile(statePath(), clean, "utf8");
    const broken = await state();
    const before = attemptAccountingAt(broken.state, stopped.id);
    expect(before.spent).toBe(3);
    // Ninguna fila persistida de esta frontera las respalda: eso es el desajuste,
    // y sobre el estado crudo la frontera queda AGOTADA por una cuenta que nadie
    // gastó — el bloqueo del incidente, tal cual.
    expect(before.rows).toBe(0);
    expect(before.conflicts).not.toEqual([]);
    expect(broken.resolved.error?.code).toBe("FLOW_BOUNDARY_EXHAUSTED");

    // Y el avance siguiente —lo único que el agente hace— la repara sin decir nada.
    const resumed = await advanceFlow(fs, paths, { code: CODE, adopt: false });
    if (!resumed.ok) throw new Error("esperaba avanzar sobre la contabilidad reparada");
    expect(resumed.directive.boundary.transition).toBe(stopped.id);
    expect(resumed.directive.error).toBeNull();
    expect(attemptAccountingAt((await state()).state, stopped.id).spent).toBe(0);

    // Y ahora el recorrido, hasta la primera tarea.
    const { humanBoundaries, errors } = await walkToFirstTask();
    const final = await state();
    // El resultado que el usuario pidió: la primera tarea, sin nada en el medio.
    expect(final.resolved.stopped?.id).toBe("plan-exec.implementation");
    expect(errors).toEqual([]);
    expect(humanBoundaries).toEqual([]);
    // Sin el código de evidencia local ausente, sin frontera agotada y sin
    // incontestable: la lista de errores vacía ya lo dice, y esto lo nombra.
    expect(errors.map((entry) => entry.code)).not.toContain("PLAN_SOURCE_LOCAL_PROOF_MISSING");
    expect(errors.map((entry) => entry.code)).not.toContain("FLOW_BOUNDARY_EXHAUSTED");
    // Ninguna degradación pedida ni registrada, y ningún refinamiento entregado.
    expect(final.state.degraded ?? []).toEqual([]);
    expect(final.state.handoff ?? null).toBeNull();
    // Los intentos, intactos: la reparación devolvió lo que las filas no registran.
    expect(attemptAccountingAt(final.state, stopped.id).spent).toBe(0);
    // Y la reparación quedó en la traza, para auditarla después.
    const repairs = attemptReconciliationsOf(final.state);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ transition: stopped.id });
    expect(repairs[0]?.repairs.map((repair) => repair.rule)).toEqual(["forgive-counter-excess"]);
  });
});
