import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { advanceFlowRun, resolveBoundary } from "../../src/application/flow/advance.js";
import { SELF_AUTHORIZABLE_CLASSES } from "../../src/domain/capability/effects.js";
import { parseFlowAnswer } from "../../src/domain/flow/answer.js";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  decisionsOfScope,
} from "../../src/domain/flow/authority.js";
import { renderDirectiveHuman } from "../../src/domain/flow/directive.js";
import { newRunState, withApproval } from "../../src/domain/flow/run-state.js";

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
    // The axis is real in both directions. It started with most rows legacy and
    // the PLAN tranche tipped it the other way — what the guard has to keep saying
    // is that BOTH sides exist, because a registry with nothing left legacy would
    // make the fallback path untested, and one with nothing owned would make the
    // whole engine decorative. F17 is what empties the first set, and it retires
    // the mechanism in the same phase.
    expect(legacy.length).toBeGreaterThan(0);
    expect(owned.length).toBeGreaterThan(0);
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
      {
        transition: "fixture.migrada",
        authority: "cli",
        ownership: "cli-owned",
        outcome: "applied",
        reason: null,
      },
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
  /**
   * A doctrine-owned transition that really writes.
   *
   * It used to be DERIVED from the live registry — ten rows matched — and the
   * chassis tranche took the last of them: what is still `legacy` today is four
   * SPEC rows whose module belongs to another journey plus five command rows,
   * and not one of them writes. So it is a fixture, like the twin scenario
   * below. Nothing the scenario asserts changed; only where the row comes from.
   */
  function legacyWriter(): FlowDecision {
    const row: FlowDecision = {
      id: "fixture.escritura-doctrinal",
      scope: "quick",
      title: "una transición que escribe y cuya regla sigue en el Markdown",
      authority: "cli",
      ownership: "legacy",
      document: "loops/quick-loop/LOOP.md",
      effects: ["mutate_overwrite"],
    };
    // The fixture is only useful if it still describes something the gate must
    // handle: an effect no run may grant itself.
    const gap = (row.effects ?? []).filter((effect) => !SELF_AUTHORIZABLE_CLASSES.includes(effect));
    if (gap.length === 0) throw new Error("el fixture dejó de necesitar autorización");
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

describe("aprobar un efecto no es decidir el paso", () => {
  /**
   * A doctrine-owned row that writes.
   *
   * It used to be DERIVED from the live registry — QUICK had one, then SPEC — but
   * the PLAN cutover took the last one a flow had: what is still `legacy` in a
   * flow no longer writes, and what still writes is the chassis, which no run
   * state can carry because it is not a `WorklineFlow`. So the row is a fixture
   * now. Nothing the scenario asserts changed; only where the row comes from, and
   * saying that plainly beats a search that silently finds nothing.
   */
  function legacyWriter(): FlowDecision {
    return {
      id: "fixture.escritura-legacy",
      scope: "plan-exec",
      title: "una transición que escribe y que la doctrina todavía decide",
      authority: "cli",
      ownership: "legacy",
      document: "loops/plan-exec-loop/LOOP.md",
      effects: ["mutate_overwrite"],
    };
  }

  it("la aprobación queda registrada y el paso legacy sigue esperando su fallback", () => {
    const target = legacyWriter();
    const journey = [target];
    const gap = (target.effects ?? []).filter(
      (effect) => !SELF_AUTHORIZABLE_CLASSES.includes(effect),
    );

    // Unapproved, the effect outranks the migration axis: the boundary asks for the
    // authorization even though the rule is doctrine's.
    const asked = advanceFlowRun({ state: newRunState("plan-exec", "001-prueba-plan"), journey });
    if (!asked.ok) throw new Error(`esperaba una frontera: ${asked.failure.code}`);
    expect(asked.directive.boundary.kind).toBe("authorization");

    // Approved, it becomes the `legacy` boundary for the SAME transition. Recorded:
    // the authorization. NOT recorded: the effect as applied, because nothing ran.
    const granted = advanceFlowRun({
      state: withApproval(newRunState("plan-exec", "001-prueba-plan"), gap),
      journey,
    });
    if (!granted.ok) throw new Error(`esperaba una frontera: ${granted.failure.code}`);
    for (const effect of gap) {
      expect(granted.directive.authorizations).toContain(effect);
      expect(granted.directive.effects.applied).not.toContain(effect);
    }
    expect(granted.directive.boundary.kind).toBe("legacy");
    expect(granted.directive.boundary.transition).toBe(target.id);
    expect(granted.directive.boundary.document).toBe(target.document);
    expect(granted.directive.applied).toEqual([]);
    // And the state says the same thing: position unchanged.
    expect(granted.state.applied).not.toContain(target.id);
    expect(granted.state.boundary).toBe(target.id);
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
