import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { advanceFlowRun, resolveBoundary } from "../../src/application/flow/advance.js";
import { SELF_AUTHORIZABLE_CLASSES } from "../../src/domain/capability/effects.js";
import { parseFlowAnswer } from "../../src/domain/flow/answer.js";
import {
  FLOW_DECISIONS,
  type FlowDecision,
  journeyOfFlow,
} from "../../src/domain/flow/authority.js";
import { effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import { renderDirectiveHuman } from "../../src/domain/flow/directive.js";
import { newRunState, withApproval } from "../../src/domain/flow/run-state.js";

/**
 * The migration is observable, or it is a claim.
 *
 * Three things are checked here. The doctrine ATTRIBUTES every decision this CLI
 * owns — the day a document stops saying who decides is the day the two sources
 * start drifting, and that day the suite fails. The directive carries the
 * ownership of every step, so whoever executes sees with what authority the run
 * advanced instead of inferring it. And a step whose ownership the registry does
 * not declare STOPS the run: there is no document left to hand it to, so it comes
 * back `blocked` naming itself, and no answer advances past it. That third one
 * used to describe the opposite mechanism — the fallback — and it is the shape of
 * its retirement that the cases below pin.
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
const legacy = FLOW_DECISIONS.filter((decision) => decision.ownership !== "cli-owned");

/**
 * A row that does not declare the CLI's ownership.
 *
 * The cast is the point, not a shortcut. The vocabulary has one member since the
 * fallback was retired, so no literal can express this and the compiler is the
 * first line of defence. The second line is the engine, and a guard that could
 * not build the offending row would be asserting nothing about it.
 */
function unowned(row: Omit<FlowDecision, "ownership">): FlowDecision {
  return { ...row, ownership: "sin-declarar" } as unknown as FlowDecision;
}

/** A two-step journey: the first owned, the second declaring no ownership. */
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
    unowned({
      id: "fixture.sin-propiedad",
      scope: "quick",
      title: "el paso cuya propiedad el registro no declara",
      authority: "cli",
      document: "loops/CODE-POLICIES.md",
    }),
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

  it("no queda ninguna fila decidiendo desde la doctrina, y por eso el fallback se fue", () => {
    // The axis used to be asserted in BOTH directions, and the reason was real: a
    // registry with nothing left `legacy` would have left the fallback path
    // untested. This phase emptied that set, so the guard says the thing that is
    // now true and the mechanism travelled out in the same commit — an untested
    // path is not what replaced it, an absent one is.
    expect(legacy).toEqual([]);
    expect(owned).toHaveLength(FLOW_DECISIONS.length);
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

describe("una transición sin propiedad del CLI bloquea, no vuelve a la doctrina", () => {
  const journey = mixedJourney();

  it("la primera usa exclusivamente el resultado del CLI y la segunda detiene la corrida", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey });
    if (!result.ok) throw new Error(`esperaba avanzar: ${result.failure.code}`);

    // Applied: only the owned one, and the trace says with what authority.
    expect(result.directive.applied).toEqual([
      {
        transition: "fixture.migrada",
        authority: "cli",
        ownership: "cli-owned",
        outcome: "applied",
        reason: null,
      },
    ]);
    // Stopped: the unowned one, `blocked` — not a semantic request, not a set of
    // alternatives, and no longer a kind of its own that sends the reader to a
    // document. The engine has no standing to ask about it and nowhere to send it.
    expect(result.directive.boundary.kind).toBe("blocked");
    expect(result.directive.boundary.transition).toBe("fixture.sin-propiedad");
    expect(result.directive.request).toBeNull();
    expect(result.directive.choices).toEqual([]);
    expect(result.directive.pending).toEqual(["fixture.sin-propiedad"]);
  });

  it("el bloqueo nombra la transición y dice que la ausencia de propiedad es el error", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey });
    if (!result.ok) throw new Error("esperaba la frontera bloqueada");
    expect(result.directive.error?.code).toBe("FLOW_TRANSITION_UNOWNED");
    expect(result.directive.error?.message).toContain("fixture.sin-propiedad");
    // And it says so out loud: what used to be a fallback is now a defect.
    expect(result.directive.error?.action).toMatch(/es un error, no un fallback/);
  });

  it("la proyección humana ya no ofrece ningún documento como regla a aplicar", () => {
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey });
    if (!result.ok) throw new Error("esperaba la frontera bloqueada");
    const human = renderDirectiveHuman(result.directive);
    expect(human).toContain("fixture.migrada (cli · cli-owned)");
    expect(human).toContain("detenido en fixture.sin-propiedad");
    // The line that used to send the reader to a document is gone with it.
    expect(human).not.toContain("fallback declarado");
    expect(human).not.toContain("loops/CODE-POLICIES.md");
  });

  it("no hay respuesta que la haga avanzar: un bloqueo no se contesta", () => {
    const state = newRunState("quick", "001-p-quick");
    const advanced = advanceFlowRun({ state, journey });
    if (!advanced.ok) throw new Error("esperaba la frontera bloqueada");
    const resolved = resolveBoundary(advanced.state, journey);

    // This is the whole retirement in one assertion. Before, naming the document
    // in `fallback` advanced the journey — the doctrine decided and the run took
    // its word for it. There is no field left that does that.
    const parsed = parseFlowAnswer({
      raw: JSON.stringify({ input_digest: resolved.seal, fallback: "loops/CODE-POLICIES.md" }),
      boundary: resolved.kind,
      decision: resolved.stopped as FlowDecision,
      seal: resolved.seal,
      choices: resolved.choices,
      approval: null,
      expectedApproval: null,
    });
    if (parsed.ok) throw new Error("una frontera bloqueada no admite respuesta");
    expect(parsed.failure.code).toBe("FLOW_ANSWER_NOT_EXPECTED");
    expect(parsed.failure.action).toMatch(/resolvé el bloqueo/);
  });
});

describe("el gate de efectos y la propiedad, en el orden que quedó", () => {
  /** A transition that really writes, and whose effect no run may grant itself. */
  function writer(overrides: Partial<FlowDecision> = {}): FlowDecision {
    const row: FlowDecision = {
      id: "fixture.escritura",
      scope: "quick",
      title: "una transición que escribe",
      authority: "cli",
      ownership: "cli-owned",
      document: "loops/quick-loop/LOOP.md",
      attribution: "aw flow advance",
      effects: ["mutate_overwrite"],
      ...overrides,
    };
    const gap = (row.effects ?? []).filter((effect) => !SELF_AUTHORIZABLE_CLASSES.includes(effect));
    if (gap.length === 0) throw new Error("el fixture dejó de necesitar autorización");
    return row;
  }

  it("sobre una fila del CLI, un efecto sin autorizar sigue siendo frontera de autorización", () => {
    const result = advanceFlowRun({
      state: newRunState("quick", "001-p-quick"),
      journey: [writer()],
    });
    if (!result.ok) throw new Error(`esperaba una frontera: ${result.failure.code}`);
    expect(result.directive.boundary.kind).toBe("authorization");
    expect(result.directive.boundary.ownership).toBe("cli-owned");
    expect(result.directive.applied).toEqual([]);
    expect(result.state.effects.applied).toEqual([]);
  });

  it("sin propiedad declarada NO se pide la autorización: bloquea antes de preguntar", () => {
    // The order flipped here, deliberately. While the fallback existed the effect
    // gate outranked ownership, because a doctrine-owned write still had to be
    // approved before doctrine applied it. Nothing applies it now, so asking would
    // be asking somebody to authorize an effect for a step that is going nowhere.
    const row = unowned({
      id: "fixture.escritura",
      scope: "quick",
      title: "una transición que escribe y no declara propiedad",
      authority: "cli",
      document: "loops/quick-loop/LOOP.md",
      effects: ["mutate_overwrite"],
    });
    const result = advanceFlowRun({ state: newRunState("quick", "001-p-quick"), journey: [row] });
    if (!result.ok) throw new Error(`esperaba una frontera: ${result.failure.code}`);
    expect(result.directive.boundary.kind).toBe("blocked");
    expect(result.directive.error?.code).toBe("FLOW_TRANSITION_UNOWNED");
    expect(result.directive.choices).toEqual([]);
    // Nothing approved, nothing applied, nothing planned as if it were about to be.
    expect(result.state.authorizations).toEqual([]);
    expect(result.state.effects.applied).toEqual([]);
    expect(result.directive.applied).toEqual([]);
  });

  it("y una autorización ya concedida tampoco la desbloquea", () => {
    // The sharpest form: approving the effect first does not buy the step. What
    // was missing was never the approval.
    const row = unowned({
      id: "fixture.escritura",
      scope: "plan-exec",
      title: "una transición que escribe y no declara propiedad",
      authority: "cli",
      document: "loops/plan-exec-loop/LOOP.md",
      effects: ["mutate_overwrite"],
    });
    const granted = advanceFlowRun({
      state: withApproval(newRunState("plan-exec", "001-prueba-plan"), {
        digest: effectApprovalDigest("fixture.escritura", ["mutate_overwrite"]),
        destinations: [],
        classes: ["mutate_overwrite"],
      }),
      journey: [row],
    });
    if (!granted.ok) throw new Error(`esperaba una frontera: ${granted.failure.code}`);
    expect(granted.directive.boundary.kind).toBe("blocked");
    expect(granted.directive.error?.code).toBe("FLOW_TRANSITION_UNOWNED");
    expect(granted.directive.effects.applied).not.toContain("mutate_overwrite");
    expect(granted.state.applied).not.toContain(row.id);
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

  it("sobre el registro vivo ningún recorrido puede bloquearse por propiedad", () => {
    // The honest state of the migration, asserted rather than described. This case
    // used to walk each flow expecting it to STOP at its first doctrine-owned row,
    // and each cutover shrank what it found until the last tranche left it walking
    // over an empty branch. Turned around, it is the closing claim: no journey has
    // a row that could produce the block above.
    for (const flow of ["quick", "spec-refine", "plan-new", "plan-refine", "plan-exec"] as const) {
      const rows = journeyOfFlow(flow);
      expect(rows.length, flow).toBeGreaterThan(0);
      expect(
        rows.filter((row) => row.ownership !== "cli-owned").map((row) => row.id),
        flow,
      ).toEqual([]);
      const result = advanceFlowRun({ state: newRunState(flow, `001-p-${flow}`), journey: rows });
      if (!result.ok) throw new Error(`esperaba avanzar en ${flow}: ${result.failure.code}`);
      expect(result.directive.error?.code, flow).not.toBe("FLOW_TRANSITION_UNOWNED");
    }
  });
});
