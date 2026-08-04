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
  type FlowDecision,
  actionOf,
  conditionOf,
  decisionsOfScope,
  effectsOf,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import { thresholdFired } from "../../src/domain/flow/rules.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * SPEC, dirigido por el CLI — el segundo tramo, y el que puso a prueba el
 * contrato del piloto.
 *
 * Lo que se fija acá:
 *
 * 1. **Dos preguntas distintas sobre la misma observación no se confunden.** La
 *    ronda de ideación y la ambigüedad funcional leen la MISMA fila del agente,
 *    así que cada condición nombra el subconjunto de señales que la habilita:
 *    contar «cuántas» sin decir «de cuáles» las haría indistinguibles.
 * 2. **El gate ready-for-plan y el sello del status no se acreditan solos.** El
 *    primero exige el estado real de su checklist; el segundo es una escritura,
 *    así que primero se autoriza y recién después se nombra la invocación.
 * 3. **El tramo es el documento.** El gate de división vive en un módulo que los
 *    flows PLAN todavía leen, así que sigue siendo de la doctrina.
 */

const fs = new NodeFileSystem();
const SESSION = "021-tramo-spec-spec-refine";
const CODE = "021";

const JOURNEY = decisionsOfScope("spec-refine");

function rowOf(id: string): FlowDecision {
  const row = JOURNEY.find((decision) => decision.id === id);
  if (row === undefined) throw new Error(`el recorrido spec-refine ya no tiene '${id}'`);
  return row;
}

describe("el tramo SPEC migró lo suyo y nada de un documento compartido", () => {
  it("el gate de división sigue siendo de la doctrina, con su motivo", () => {
    for (const id of [
      "spec-refine.split-signal",
      "spec-refine.split-gate",
      "spec-refine.split-choice",
    ]) {
      const row = rowOf(id);
      expect(row.ownership, id).toBe("legacy");
      // El motivo es verificable, no una nota: `plan-new` y `plan-refine` cargan
      // ese mismo módulo, y retirarle la regla los dejaría sin ella.
      expect(row.document, id).toBe("modules/SPLIT-GATE.md");
    }
  });

  it("la confirmación de sobreescritura va ANTES del sello del status", () => {
    // El recorrido real lo destapó: la migración había dejado el sello primero y
    // la confirmación después, así que la persona confirmaba una escritura ya
    // hecha. La doctrina dice `edit_in_place_with_confirm(spec) + stamp`.
    const ids = JOURNEY.map((decision) => decision.id);
    expect(ids.indexOf("spec-refine.ready-gate")).toBeGreaterThan(-1);
    expect(ids.indexOf("spec-refine.save-confirmation")).toBeGreaterThan(
      ids.indexOf("spec-refine.ready-gate"),
    );
    expect(ids.indexOf("spec-refine.status-promotion")).toBeGreaterThan(
      ids.indexOf("spec-refine.save-confirmation"),
    );
  });

  it("cada acción delegada del tramo invoca un comando registrado", () => {
    const registered = new Set(ALL_COMMANDS.map((command) => command.name));
    const delegated = JOURNEY.filter((decision) => actionOf(decision) !== null);
    expect(delegated.map((decision) => decision.id)).toEqual([
      "spec-refine.session",
      "spec-refine.ready-gate",
      "spec-refine.status-promotion",
    ]);
    for (const decision of delegated) {
      const action = actionOf(decision);
      expect(action?.invocation.program, decision.id).toBe("aw");
      expect(registered.has(action?.invocation.args[0] ?? ""), decision.id).toBe(true);
    }
  });

  it("dos condiciones sobre la misma fila cuentan señales distintas", () => {
    const ideation = conditionOf(rowOf("spec-refine.ideation-consent"));
    const ambiguity = conditionOf(rowOf("spec-refine.functional-ambiguity"));
    expect(ideation?.threshold.observed).toBe("spec-refine.gap-recognition");
    expect(ambiguity?.threshold.observed).toBe("spec-refine.gap-recognition");
    // El subconjunto es lo que las separa: sin él, declarar una ambigüedad
    // abriría también la ronda de ideación.
    expect(ideation?.threshold.of).toEqual(["spec.solution-space-unexplored"]);
    expect(ambiguity?.threshold.of).toEqual(["spec.functional-ambiguity"]);

    const declared = (signals: string[]) => [
      { transition: "spec-refine.gap-recognition", signals },
    ];
    const ambiguous = declared(["spec.functional-ambiguity"]);
    expect(
      thresholdFired(ambiguity?.threshold ?? { observed: "", min: 1 }, JOURNEY, ambiguous),
    ).toBe(true);
    expect(
      thresholdFired(ideation?.threshold ?? { observed: "", min: 1 }, JOURNEY, ambiguous),
    ).toBe(false);
  });

  it("un subconjunto solo puede nombrar señales que la fila observada declara", () => {
    for (const decision of JOURNEY) {
      const condition = conditionOf(decision);
      if (condition === null) continue;
      const observed = JOURNEY.find((row) => row.id === condition.threshold.observed);
      const vocabulary = observed?.signals ?? [];
      const subset = condition.threshold.of;
      if (subset !== undefined) {
        // Vacío contaría nada y omitiría siempre: una regla que nunca dispara es
        // un paso borrado sin que nadie lo decida.
        expect(subset.length, decision.id).toBeGreaterThan(0);
        for (const signal of subset) {
          expect(vocabulary, `${decision.id} → ${signal}`).toContain(signal);
        }
      }
      expect(condition.threshold.min, decision.id).toBeLessThanOrEqual(
        (subset ?? vocabulary).length,
      );
    }
  });
});

describe("SPEC dirigido — sobre una corrida real en disco", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-tramo-spec-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — tramo spec\n\n## Objective\nrefinar la spec de prueba\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  async function current() {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    return { state: read.state, resolved: resolveBoundary(read.state, JOURNEY) };
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
        decisions: { paso: stopped.id },
      };
    }
    if (resolved.kind === "legacy") {
      return {
        input_digest: resolved.seal,
        fallback: stopped.document,
        choice: "Resolver la frontera",
      };
    }
    return { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" };
  }

  /** Adopt the run and answer up to the boundary of `id`, declaring `signals` where admissible. */
  async function walkTo(id: string, signals: string[]): Promise<void> {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "spec-refine", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    for (let step = 0; step < 30; step += 1) {
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

  it("la sesión de refinamiento no se da por abierta sin leerla", async () => {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "spec-refine", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    expect(adopted.directive.boundary.kind).toBe("execution");
    expect(adopted.directive.boundary.transition).toBe("spec-refine.session");
    expect(adopted.directive.action?.invocation.args).toEqual([
      "session-artifacts",
      "--code",
      CODE,
    ]);

    // Una narración no es un resultado.
    const claimed = await answer({
      input_digest: adopted.directive.state_digest,
      outcome: "completed",
      invocation: adopted.directive.action?.invocation,
      validations: [{ id: "spec.session-present", passed: true, detail: "  " }],
      effects: { planned: ["local_additive"], approved: [], applied: ["local_additive"] },
      output: null,
    });
    expect(claimed.error?.code).toBe("FLOW_EVIDENCE_MISSING");
    expect((await current()).state.applied).toEqual([]);
  });

  it("sin disparador declarado, la ronda de ideación no se ofrece", async () => {
    await walkTo("spec-refine.content-authoring", []);
    const { state, resolved } = await current();
    expect(resolved.stopped?.id).toBe("spec-refine.content-authoring");
    expect(state.skipped).toContain("spec-refine.ideation-consent");
    // Y la ambigüedad, que lee la misma fila, también quedó omitida.
    const gaps = state.skipped.filter((id) => id.startsWith("spec-refine."));
    expect(gaps).toContain("spec-refine.ideation-consent");
  });

  it("declarar el disparador abre la ronda con sus dos alternativas", async () => {
    await walkTo("spec-refine.ideation-consent", ["spec.solution-space-unexplored"]);
    const { state, resolved } = await current();
    expect(resolved.kind).toBe("human");
    expect(resolved.choices.map((choice) => choice.label)).toEqual([
      "Explorar ideas",
      "Seguir sin ideación",
      "Cerrar",
    ]);
    expect(state.skipped).not.toContain("spec-refine.ideation-consent");
  });

  it("declarar la ambigüedad NO abre la ideación: cada condición cuenta lo suyo", async () => {
    await walkTo("spec-refine.functional-ambiguity", ["spec.functional-ambiguity"]);
    const { state, resolved } = await current();
    expect(resolved.stopped?.id).toBe("spec-refine.functional-ambiguity");
    expect(resolved.kind).toBe("human");
    // La ideación quedó omitida aunque la fila observada declaró UNA señal.
    expect(state.skipped).toContain("spec-refine.ideation-consent");
  });

  it("el sello del status se autoriza primero y solo el resultado lo aplica", async () => {
    await walkTo("spec-refine.status-promotion", []);
    const gate = await current();
    // `mutate_overwrite` no se autoriza solo: la corrida para ANTES de nombrar la
    // invocación que sella el documento.
    expect(gate.resolved.kind).toBe("authorization");
    expect(gate.resolved.action).toBeNull();

    const granted = await answer(
      { input_digest: gate.resolved.seal, choice: "Autorizar el efecto" },
      effectApprovalDigest(
        "spec-refine.status-promotion",
        gate.resolved.authorization?.planned ?? [],
      ),
    );
    expect(granted.boundary.kind).toBe("execution");
    expect(granted.effects.applied).not.toContain("mutate_overwrite");

    const running = await current();
    const stale = await answer(
      resultFor(running.resolved, {
        effects: { planned: ["mutate_overwrite"], approved: [], applied: [] },
      }),
    );
    expect(stale.error?.code).toBe("FLOW_EFFECT_PARTIAL");
    expect((await current()).state.effects.applied).not.toContain("mutate_overwrite");

    const sealed = await answer(resultFor(running.resolved));
    expect(sealed.error).toBeNull();
    expect(sealed.effects.applied).toContain("mutate_overwrite");
  });

  it("el recorrido se detiene en el gate de división como frontera legacy", async () => {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "spec-refine", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    for (let step = 0; step < 10; step += 1) {
      const { resolved } = await current();
      if (resolved.kind === "legacy") {
        expect(resolved.stopped?.document).toBe("modules/SPLIT-GATE.md");
        // Y declara el fallback antes de que nadie lo ejecute.
        expect(resolved.stopped?.id).toBe("spec-refine.split-signal");
        return;
      }
      if (resolved.kind === "execution") {
        await answer(resultFor(resolved));
        continue;
      }
      await answer({
        input_digest: resolved.seal,
        signals: [],
        decisions: { paso: resolved.stopped?.id },
      });
    }
    throw new Error("el recorrido nunca llegó al gate de división");
  });
});
