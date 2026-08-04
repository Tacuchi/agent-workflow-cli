import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceFlowRun, resolveBoundary } from "../../src/application/flow/advance.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import { SELF_AUTHORIZABLE_CLASSES } from "../../src/domain/capability/effects.js";
import { parseFlowAnswer } from "../../src/domain/flow/answer.js";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  decisionsOfScope,
  effectsOf,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import { renderDirectiveHuman } from "../../src/domain/flow/directive.js";
import {
  FLOW_RUN_STATE_FILE,
  type FlowRunState,
  applyTransition,
  newRunState,
  serializeRunState,
  withBoundary,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

/**
 * The migration is observable, or it is a claim.
 *
 * Three things are checked here. The doctrine ATTRIBUTES every decision this CLI
 * already owns — the day a document stops saying who decides is the day the two
 * sources start drifting, and that day the suite fails. The directive carries the
 * ownership of every step, so whoever executes sees with what authority the run
 * advanced instead of inferring it. And a step still owned by doctrine DECLARES
 * its fallback before running: the engine does not apply it, it hands it back
 * naming the document, and an answer that never names that document does not
 * advance the journey.
 *
 * What the attribution guard catches and what it does not, stated so nobody reads
 * more into it: it catches a document that STOPS attributing a migrated decision
 * — the observable symptom of doctrine taking a rule back — and it cannot catch
 * prose that restates a rule while still attributing it. The other half of that
 * defence is the engine itself: a `cli-owned` transition never becomes a
 * boundary, so no surface is ever asked for its own verdict on one. When a
 * cutover phase REMOVES a rule from a document, that is the moment to pin the
 * removed text as a negative marker — real text, from that document's history,
 * rather than a phrase invented here to have something to assert.
 */

const BUNDLE = resolve(__dirname, "..", "..", "skills", "w");

/** How the corpus names the decider: an invocation, the CLI, or the capability. */
const ATTRIBUTES_THE_DECIDER = /\baw [a-z-]+|CLI|capability|this command/;

const owned = FLOW_DECISIONS.filter((decision) => decision.ownership === "cli-owned");
const legacy = FLOW_DECISIONS.filter((decision) => decision.ownership === "legacy");

/** A two-step journey: the first migrated, the second still doctrine's. */
function mixedJourney(): readonly FlowDecision[] {
  return [
    {
      id: "fixture.migrada",
      scope: "quick",
      title: "el paso que este CLI ya decide",
      authority: "cli",
      ownership: "cli-owned",
      document: "loops/quick-loop/LOOP.md",
      attribution: "aw flow advance",
    },
    {
      id: "fixture.legacy",
      scope: "quick",
      title: "el paso que la doctrina todavía decide",
      authority: "cli",
      ownership: "legacy",
      document: "loops/CODE-POLICIES.md",
    },
  ];
}

describe("la propiedad de cada transición sale de un solo lugar", () => {
  it("toda fila cli-owned declara el texto con el que su documento atribuye la decisión", async () => {
    const offenders: string[] = [];
    for (const decision of owned) {
      const marker = decision.attribution;
      if (marker === undefined) {
        offenders.push(`${decision.id}: sin atribución declarada`);
        continue;
      }
      const body = await readFile(join(BUNDLE, decision.document), "utf8");
      if (!body.includes(marker)) {
        offenders.push(`${decision.id}: '${marker}' ya no está en ${decision.document}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(owned.length).toBeGreaterThan(0);
  });

  it("ninguna atribución es decorativa: nombra al decisor, no al paso", async () => {
    for (const decision of owned) {
      const marker = decision.attribution ?? "";
      expect(marker.length, decision.id).toBeGreaterThanOrEqual(8);
      expect(marker, decision.id).toMatch(ATTRIBUTES_THE_DECIDER);
      // A marker that merely quotes the row back would pass any document.
      expect(decision.title.includes(marker), decision.id).toBe(false);
      expect(decision.id.includes(marker), decision.id).toBe(false);
    }
  });

  it("ninguna fila legacy se atribuye por adelantado", () => {
    const premature = legacy.filter((decision) => decision.attribution !== undefined);
    expect(premature.map((decision) => decision.id)).toEqual([]);
    // The axis is real in both directions: this plan starts with most rows legacy.
    expect(legacy.length).toBeGreaterThan(owned.length);
  });

  it("el documento de cada fila existe en el bundle, atribuya o no", async () => {
    const missing: string[] = [];
    for (const decision of FLOW_DECISIONS) {
      try {
        await readFile(join(BUNDLE, decision.document), "utf8");
      } catch {
        missing.push(`${decision.id} → ${decision.document}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("el escenario de la spec: una migrada seguida de una legacy", () => {
  const journey = mixedJourney();

  it("la primera usa exclusivamente el resultado del CLI y la segunda se detiene", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey });
    if (!result.ok) throw new Error(`esperaba avanzar: ${result.failure.code}`);

    // Applied: only the migrated one, and the trace says with what authority.
    expect(result.directive.applied).toEqual([
      { transition: "fixture.migrada", authority: "cli", ownership: "cli-owned" },
    ]);
    // Stopped: the legacy one, as a boundary of its own kind — not as a semantic
    // request nor as a set of alternatives the engine has no standing to offer.
    expect(result.directive.boundary.kind).toBe("legacy");
    expect(result.directive.boundary.transition).toBe("fixture.legacy");
    expect(result.directive.boundary.ownership).toBe("legacy");
    expect(result.directive.request).toBeNull();
    expect(result.directive.choices).toEqual([]);
    expect(result.directive.pending).toEqual(["fixture.legacy"]);
  });

  it("el fallback queda declarado ANTES de ejecutarlo, con documento y acción", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey });
    if (!result.ok) throw new Error("esperaba la frontera legacy");
    expect(result.directive.boundary.document).toBe("loops/CODE-POLICIES.md");
    expect(result.directive.next_action).toContain("loops/CODE-POLICIES.md");
    expect(result.directive.next_action).toMatch(/aplicá la regla vigente/);
  });

  it("la proyección humana dice con qué autoridad avanzó cada paso y cuál es el fallback", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey });
    if (!result.ok) throw new Error("esperaba la frontera legacy");
    const human = renderDirectiveHuman(result.directive);
    expect(human).toContain("fixture.migrada (cli · cli-owned)");
    expect(human).toContain("fallback declarado: la regla vigente de loops/CODE-POLICIES.md");
    expect(human).toContain("detenido en fixture.legacy · legacy");
  });

  it("una respuesta que no declara el fallback no avanza el recorrido", () => {
    const state = newRunState("quick", "001-p-quick");
    const advanced = advanceFlowRun({ state, journey });
    if (!advanced.ok) throw new Error("esperaba la frontera legacy");
    const resolved = resolveBoundary(advanced.state, journey);

    const parsed = parseFlowAnswer({
      raw: JSON.stringify({ input_digest: resolved.seal }),
      boundary: resolved.kind,
      decision: resolved.stopped as FlowDecision,
      seal: resolved.seal,
      choices: resolved.choices,
      approval: null,
      expectedApproval: null,
      declineLabel: "Cerrar",
    });
    if (parsed.ok) throw new Error("una respuesta sin fallback declarado no puede pasar");
    expect(parsed.failure.code).toBe("FLOW_FALLBACK_UNDECLARED");
    expect(parsed.failure.action).toContain("loops/CODE-POLICIES.md");
  });

  it("declarar OTRO documento tampoco sirve: el fallback es el que la frontera nombró", () => {
    const state = newRunState("quick", "001-p-quick");
    const advanced = advanceFlowRun({ state, journey });
    if (!advanced.ok) throw new Error("esperaba la frontera legacy");
    const resolved = resolveBoundary(advanced.state, journey);

    const parsed = parseFlowAnswer({
      raw: JSON.stringify({ input_digest: resolved.seal, fallback: "loops/CHASSIS.md" }),
      boundary: resolved.kind,
      decision: resolved.stopped as FlowDecision,
      seal: resolved.seal,
      choices: resolved.choices,
      approval: null,
      expectedApproval: null,
      declineLabel: "Cerrar",
    });
    if (parsed.ok) throw new Error("un fallback distinto del declarado no puede pasar");
    expect(parsed.failure.code).toBe("FLOW_FALLBACK_UNDECLARED");
  });

  it("declarado el fallback, la respuesta sobrevive y el paso queda trazado como legacy", () => {
    const state = newRunState("quick", "001-p-quick");
    const advanced = advanceFlowRun({ state, journey });
    if (!advanced.ok) throw new Error("esperaba la frontera legacy");
    const resolved = resolveBoundary(advanced.state, journey);

    const parsed = parseFlowAnswer({
      raw: JSON.stringify({ input_digest: resolved.seal, fallback: "loops/CODE-POLICIES.md" }),
      boundary: resolved.kind,
      decision: resolved.stopped as FlowDecision,
      seal: resolved.seal,
      choices: resolved.choices,
      approval: null,
      expectedApproval: null,
      declineLabel: "Cerrar",
    });
    if (!parsed.ok) throw new Error(`esperaba una respuesta válida: ${parsed.failure.code}`);
    expect(parsed.answer.fallback).toBe("loops/CODE-POLICIES.md");
  });
});

describe("la propiedad no puentea el gate de efectos", () => {
  /** A legacy transition that really writes: ten of them exist in the registry. */
  function legacyWriter(): FlowDecision {
    const row = FLOW_DECISIONS.find(
      (decision) =>
        decision.ownership === "legacy" &&
        decision.authority === "cli" &&
        (decision.effects ?? []).some((effect) => !SELF_AUTHORIZABLE_CLASSES.includes(effect)),
    );
    if (row === undefined) throw new Error("el registro ya no tiene una fila legacy que escriba");
    return row;
  }

  it("un efecto sin autorizar gana sobre el eje de migración: la frontera es de autorización", () => {
    // The bug this pins: answering ownership first would hand a transition that
    // exercises `mutate_overwrite` or `execute` back to doctrine with its effects
    // unapproved — the effect gate bypassed by a field about who decides the rule.
    const writer = legacyWriter();
    const journey = [writer];
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey });
    if (!result.ok) throw new Error(`esperaba una frontera: ${result.failure.code}`);
    expect(result.directive.boundary.kind).toBe("authorization");
    expect(result.directive.boundary.ownership).toBe("legacy");
    expect(result.directive.applied).toEqual([]);
    expect(result.state.effects.applied).toEqual([]);
  });

  it("con el efecto ya autorizado vuelve a ser legacy, y sigue declarando su fallback", () => {
    const writer = legacyWriter();
    const base = newRunState("quick", "001-p-quick");
    const authorized = { ...base, authorizations: [...(writer.effects ?? [])] };
    const result = advanceFlowRun({ state: authorized, journey: [writer] });
    if (!result.ok) throw new Error("esperaba la frontera legacy");
    // Authorized, so no approval is pending — but the step is still doctrine's.
    expect(result.directive.boundary.kind).toBe("legacy");
    expect(result.directive.boundary.document).toBe(writer.document);
    expect(result.directive.applied).toEqual([]);
    // And the effect is planned without being applied: nothing ran.
    expect(result.state.effects.applied).toEqual([]);
  });
});

describe("aprobar un efecto no es decidir el paso — sobre una corrida real", () => {
  const SESSION = "001-prueba-quick";
  const fs = new NodeFileSystem();
  let workdir: string;
  let paths: PathsService;

  /** The first real QUICK row that writes or runs something, still doctrine's. */
  function writer(): FlowDecision {
    const row = decisionsOfScope("quick").find((decision) =>
      (decision.effects ?? []).some((effect) => !SELF_AUTHORIZABLE_CLASSES.includes(effect)),
    );
    if (row === undefined) throw new Error("QUICK ya no tiene una transición que escriba");
    return row;
  }

  /** Position a persisted run exactly where the engine would leave it: at `id`. */
  async function positionAt(id: string): Promise<FlowRunState> {
    const journey = decisionsOfScope("quick");
    let state = newRunState("quick", SESSION);
    for (const decision of journey) {
      if (decision.id === id) break;
      state = applyTransition(state, decision.id, effectsOf(decision));
    }
    state = withBoundary(state, id);
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE),
      serializeRunState(state),
      "utf8",
    );
    return state;
  }

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-ownership-"));
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

  it("la aprobación queda registrada y el paso legacy sigue esperando su fallback", async () => {
    const target = writer();
    const state = await positionAt(target.id);
    const resolved = resolveBoundary(state, decisionsOfScope("quick"));
    expect(resolved.kind).toBe("authorization");

    const result = await submitFlow(fs, paths, {
      code: "001",
      raw: JSON.stringify({ input_digest: resolved.seal, choice: "Autorizar el efecto" }),
      approval: effectApprovalDigest(target.id, resolved.authorization?.planned ?? []),
    });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");

    const gap = (target.effects ?? []).filter(
      (effect) => !SELF_AUTHORIZABLE_CLASSES.includes(effect),
    );
    // Recorded: the authorization. NOT recorded: the effect as applied, because
    // nothing ran — the boundary is now the `legacy` one for the SAME transition.
    for (const effect of gap) {
      expect(result.directive.authorizations).toContain(effect);
      expect(result.directive.effects.applied).not.toContain(effect);
    }
    expect(result.directive.boundary.kind).toBe("legacy");
    expect(result.directive.boundary.transition).toBe(target.id);
    expect(result.directive.boundary.document).toBe(target.document);
    expect(result.directive.applied).toEqual([]);

    // And the persisted state says the same thing: position unchanged.
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error(`esperaba leer la corrida: ${read.failure.code}`);
    expect(read.state.applied).not.toContain(target.id);
    expect(read.state.boundary).toBe(target.id);
  });
});

describe("una transición ya migrada no vuelve a manos de la doctrina", () => {
  it("el motor nunca la devuelve como frontera: la aplica y sigue", () => {
    const journey = mixedJourney();
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey });
    if (!result.ok) throw new Error("esperaba avanzar");
    // The migrated step is never offered as something to answer — there is no
    // boundary for it, so no host can send back its own verdict for it.
    expect(result.directive.boundary.transition).not.toBe("fixture.migrada");
    expect(result.state.applied).toContain("fixture.migrada");
  });

  it("sobre el registro vivo, ningún flow aplica todavía nada: todos son legacy", () => {
    // The honest state of the migration, asserted rather than described. Each
    // cutover phase moves one tranche, and this figure is what proves it moved.
    for (const flow of ["quick", "spec-refine", "plan-new", "plan-refine", "plan-exec"] as const) {
      const rows = decisionsOfScope(flow);
      expect(rows.length, flow).toBeGreaterThan(0);
      const result = advanceFlowRun({ state: newRunState(flow, `001-p-${flow}`), journey: rows });
      if (!result.ok) throw new Error(`esperaba avanzar en ${flow}: ${result.failure.code}`);
      const first = rows[0];
      if (first?.ownership === "cli-owned") continue;
      expect(result.directive.applied, flow).toEqual([]);
      expect(result.directive.boundary.kind, flow).toBe("legacy");
      expect(result.directive.boundary.document, flow).toBe(first?.document);
    }
  });
});
