import { existsSync } from "node:fs";
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
  effectsOf,
  journeyOfFlow,
  proposalContractOf,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import { thresholdFired } from "../../src/domain/flow/rules.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { acceptAdaptiveRoute } from "../helpers/accept-adaptive-route.js";
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
/** Los bytes exactos que la frontera de autoría entrega, con su sello ya dentro. */
const SPEC_ARTIFACT = (proposes: { destinations: readonly string[] }) => ({
  path: `${proposes.destinations[0]}/001-spec-tramo.md`,
  content: "---\nstatus: ready-for-plan\n---\n\n# Spec 001 — tramo\n",
});

const SESSION = "021-tramo-spec-spec-refine";
const CODE = "021";

const JOURNEY = journeyOfFlow("spec-refine");

function rowOf(id: string): FlowDecision {
  const row = JOURNEY.find((decision) => decision.id === id);
  if (row === undefined) throw new Error(`el recorrido spec-refine ya no tiene '${id}'`);
  return row;
}

describe("el tramo SPEC migró lo suyo y nada de un documento compartido", () => {
  it("el gate de división quedó en el módulo que este recorrido SÍ carga", () => {
    // El motivo por el que estas tres filas se quedaron atrás resultó no ser el
    // que esta guarda afirmaba. No era que otro recorrido cargara su módulo: era
    // que llevaban el documento de `spec-new`, que `spec-refine` no carga nunca.
    // Una corrida real se detenía acá remitiendo a un archivo que su propio
    // read-set no le había dado.
    for (const id of [
      "spec-refine.split-signal",
      "spec-refine.split-gate",
      "spec-refine.split-choice",
    ]) {
      const row = rowOf(id);
      expect(row.ownership, id).toBe("cli-owned");
      expect(row.document, id).toBe("modules/SPEC-CHANGE-SHAPE.md");
    }
    // Y el umbral es el de la doctrina: dos señales, sobre las que esta rama
    // declara — nunca las cinco del gate multi-plan.
    const choice = rowOf("spec-refine.split-choice");
    expect(choice.condition?.threshold.min).toBe(2);
    expect(choice.condition?.threshold.observed).toBe("spec-refine.split-signal");
    expect(rowOf("spec-refine.split-signal").signals).toHaveLength(4);
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
    // El sello del status ya no es una transición: viaja DENTRO de los bytes que
    // la propuesta sella, así que lo que va después de la confirmación es la
    // publicación — una sola escritura que deja documento y sello juntos.
    expect(ids).not.toContain("spec-refine.status-promotion");
    expect(ids.indexOf("spec-refine.save-proposal")).toBeGreaterThan(
      ids.indexOf("spec-refine.ready-gate"),
    );
    expect(ids.indexOf("spec-refine.publication")).toBeGreaterThan(
      ids.indexOf("spec-refine.save-confirmation"),
    );
  });

  it("cada acción delegada del tramo invoca un comando registrado", () => {
    const registered = new Set(ALL_COMMANDS.map((command) => command.name));
    const delegated = JOURNEY.filter((decision) => actionOf(decision) !== null);
    expect(delegated.map((decision) => decision.id)).toEqual([
      "spec-refine.session",
      "spec-refine.ready-gate",
      "spec-refine.publication",
      // El cierre transversal, compuesto como sufijo: escribe la fila del
      // registro durable, así que se acredita con salida real como cualquiera.
      "chassis.finalize",
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
    // Una publicación aplica lo que su propuesta sellada dice, no el techo de la
    // fila: proponer un archivo nuevo no ejerce `mutate_overwrite`.
    const declared = resolved.proposal?.effects ?? effectsOf(resolved.stopped as FlowDecision);
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
                invocation: { artifact: "tests/unit/flow-tramo-spec.test.ts" },
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
      const proposes = proposalContractOf(stopped);
      // Una frontera de autoría pide BYTES; contestarle con una decisión sería
      // llegar a la confirmación sin nada que previsualizar.
      if (proposes !== null) {
        return { input_digest: resolved.seal, artifacts: [SPEC_ARTIFACT(proposes)] };
      }
      const vocabulary = stopped.signals ?? [];
      return {
        input_digest: resolved.seal,
        signals: signals.filter((signal) => vocabulary.includes(signal)),
        decisions: { paso: stopped.id },
      };
    }
    return { input_digest: resolved.seal, choice: resolved.choices[0]?.label ?? "" };
  }

  /** Adopt the run and answer up to the boundary of `id`, declaring `signals` where admissible. */
  async function walkTo(id: string, signals: string[]): Promise<void> {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "spec-refine", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    await acceptAdaptiveRoute(fs, paths, SESSION);
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
    const started = (await acceptAdaptiveRoute(fs, paths, SESSION)) ?? adopted.directive;
    expect(started.boundary.kind).toBe("execution");
    expect(started.boundary.transition).toBe("spec-refine.session");
    expect(started.action?.invocation.args).toEqual(["session-artifacts", "--code", SESSION]);

    // Una narración no es un resultado.
    const claimed = await answer({
      input_digest: started.state_digest,
      outcome: "completed",
      invocation: started.action?.invocation,
      validations: [{ id: "spec.session-present", passed: true, detail: "  " }],
      effects: { planned: ["local_additive"], approved: [], applied: ["local_additive"] },
      output: null,
    });
    expect(claimed.error?.code).toBe("FLOW_EVIDENCE_MISSING");
    // Los dos pasos transversales del prefijo ya se aplicaron —fijan la carpeta
    // escribible y el tope de intentos antes de que nada corra—, así que lo que
    // se afirma es lo que el resultado NO acreditó: la sesión sigue sin abrirse.
    expect((await current()).state.applied).not.toContain("spec-refine.session");
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
      "Compactar",
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

  it("una sola pregunta cubre la propuesta entera: aprobar publica documento y sello juntos", async () => {
    await walkTo("spec-refine.save-confirmation", []);
    const gate = await current();
    // La vista previa viaja CON la pregunta: destino, peso y si reemplaza. Y no
    // hay una segunda frontera de autorización — el sello del status va dentro de
    // los mismos bytes, así que no queda ningún efecto suelto que aprobar aparte.
    expect(gate.resolved.kind).toBe("human");
    expect(gate.resolved.proposal?.preview.map((entry) => entry.path)).toEqual([
      "docs/specs/001-spec-tramo.md",
    ]);
    expect(gate.resolved.proposal?.effects).toEqual(["local_additive"]);
    expect(gate.resolved.choices.map((choice) => choice.label)).toEqual([
      "Aprobar y guardar",
      "Refinar",
      "Compactar",
      "Cerrar",
    ]);

    const sealed = gate.resolved.proposal?.digest;
    const approved = await answer({
      input_digest: gate.resolved.seal,
      choice: "Aprobar y guardar",
    });
    // La aprobación NO escribe: la publicación es el paso siguiente, y sin
    // ejecutor interno vuelve como la acción que alguien tiene que correr.
    expect(approved.boundary.transition).toBe("spec-refine.publication");
    expect(existsSync(join(workdir, "docs/specs/001-spec-tramo.md"))).toBe(false);

    const held = await current();
    // El grant quedó atado al sello de ESTA propuesta, y a ningún otro.
    expect(held.state.authorizations.map((grant) => grant.digest)).toEqual([sealed]);
    expect(held.state.authorizations[0]?.destinations).toEqual(["docs/specs/001-spec-tramo.md"]);

    const published = await answer(resultFor(held.resolved));
    expect(published.error).toBeNull();
    expect(published.effects.applied).toContain("local_additive");
    // Y la propuesta queda gastada: nada sigue ofreciendo previsualizar bytes que
    // ya están en disco.
    expect((await current()).state.proposal).toBeNull();
  });

  it("Refinar no produce ningún efecto y deja la propuesta intacta", async () => {
    await walkTo("spec-refine.save-confirmation", []);
    const gate = await current();

    const refined = await answer({ input_digest: gate.resolved.seal, choice: "Refinar" });
    const after = await current();
    expect(existsSync(join(workdir, "docs/specs/001-spec-tramo.md"))).toBe(false);
    expect(after.state.authorizations).toEqual([]);
    // Y la publicación no vuelve como una segunda pregunta: se salta DICIENDO que
    // no se escribió nada, en vez de pedir autorizar una sobreescritura que la
    // persona acaba de rechazar.
    expect(after.state.proposal).toBeNull();
    expect(after.state.skipped).toContain("spec-refine.publication");
    expect(
      refined.applied.find((step) => step.transition === "spec-refine.publication")?.reason,
    ).toContain("no se escribió nada");
  });

  it("el recorrido llega al gate de división y lo pregunta él mismo, sin remitir a nada", async () => {
    const adopted = await advanceFlow(fs, paths, { code: CODE, flow: "spec-refine", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    await acceptAdaptiveRoute(fs, paths, SESSION);
    for (let step = 0; step < 12; step += 1) {
      const { resolved } = await current();
      if (resolved.stopped?.id === "spec-refine.split-signal") {
        // Lo que antes era una frontera `legacy` que remitía a un documento ahora
        // es la pregunta que el motor hace: un juicio acotado, con su vocabulario.
        expect(resolved.kind).toBe("semantic");
        expect(resolved.stopped?.document).toBe("modules/SPEC-CHANGE-SHAPE.md");
        expect(resolved.error).toBeNull();
        return;
      }
      if (resolved.kind === "execution") {
        await answer(resultFor(resolved));
        continue;
      }
      if (resolved.kind === "final") break;
      await answer({
        input_digest: resolved.seal,
        signals: [],
        decisions: { paso: resolved.stopped?.id },
      });
    }
    throw new Error("el recorrido nunca llegó al gate de división");
  });
});
