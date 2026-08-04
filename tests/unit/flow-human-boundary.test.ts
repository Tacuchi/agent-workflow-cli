import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceFlowRun, resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import type { FlowAuthority, FlowDecision } from "../../src/domain/flow/authority.js";
import { decisionsOfScope, effectsOf } from "../../src/domain/flow/authority.js";
import {
  FLOW_RUN_STATE_FILE,
  applyTransition,
  newRunState,
  serializeRunState,
  withBoundary,
  withObservation,
} from "../../src/domain/flow/run-state.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";
import { NodeFileSystem } from "../helpers/real-fs.js";

// The engine walks only what the CLI owns, and no tranche is migrated yet: over the
// live rows this run would stop at its first `legacy` boundary and this file would
// be testing the migration instead of its own subject. The service resolves the
// journey from the registry, so the flip happens here — same flip, same reason as
// `tests/helpers/owned-journey.ts`, which the direct callers use.
vi.mock("../../src/domain/flow/authority.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/domain/flow/authority.js")>();
  return {
    ...real,
    decisionsOfScope: (scope: string) =>
      real.decisionsOfScope(scope).map((row) => ({ ...row, ownership: "cli-owned" as const })),
  };
});

/**
 * When the preference is human, the advance stops with the alternatives on the
 * table: no rule breaks the tie, so nobody breaks it by age, order, host or
 * convenience — and the choice that comes back is validated against the exact set
 * that was emitted.
 */

const SESSION = "001-prueba-plan";
const fs = new NodeFileSystem();

function decision(id: string, authority: FlowAuthority): FlowDecision {
  return {
    id,
    scope: "plan-exec",
    title: `transición ${id} del fixture`,
    authority,
    // The engine only applies what the CLI owns: a fixture still marked `legacy`
    // would stop at its first step, which is the migration's rule, not this
    // file's subject.
    ownership: "cli-owned",
    document: "loops/plan-exec-loop/LOOP.md",
  };
}

describe("frontera humana — el avance se detiene con las alternativas puestas", () => {
  it("dos continuaciones válidas y ninguna regla que desempate: no elige, se detiene", () => {
    const journey = [decision("fixture.uno", "cli"), decision("fixture.preferencia", "human")];
    const result = advanceFlowRun({ state: newRunState("plan-exec", SESSION), journey });
    if (!result.ok) throw new Error(`esperaba avanzar: ${result.failure.code}`);

    expect(result.directive.boundary.kind).toBe("human");
    expect(result.directive.outcome).toBe("needs_input");
    expect(result.directive.applied.map((step) => step.transition)).toEqual(["fixture.uno"]);
    // Nothing past the boundary was applied: the preference is still open.
    expect(result.directive.pending).toEqual(["fixture.preferencia"]);
  });

  it("la directiva trae cada alternativa con su etiqueta y su consecuencia", () => {
    const journey = [decision("fixture.preferencia", "human")];
    const result = advanceFlowRun({ state: newRunState("plan-exec", SESSION), journey });
    if (!result.ok) throw new Error("esperaba una frontera humana");
    expect(result.directive.choices.length).toBeGreaterThanOrEqual(2);
    for (const choice of result.directive.choices) {
      expect(choice.label.trim().length).toBeGreaterThan(0);
      expect(choice.consequence.trim().length).toBeGreaterThan(0);
    }
  });

  it("la recomendación va primero y es una sola: la persona ratifica, no arranca en frío", () => {
    const journey = [decision("fixture.preferencia", "human")];
    const result = advanceFlowRun({ state: newRunState("plan-exec", SESSION), journey });
    if (!result.ok) throw new Error("esperaba una frontera humana");
    const recommended = result.directive.choices.filter((choice) => choice.recommended);
    expect(recommended).toHaveLength(1);
    expect(result.directive.choices[0]?.recommended).toBe(true);
    // The flow control is apart from the content: declining is its own alternative,
    // never a third content option dressed up as one.
    expect(result.directive.choices.map((choice) => choice.label)).toContain("Cerrar");
  });

  it("la frontera humana no lleva pedido semántico: no se le pide juicio a nadie", () => {
    const journey = [decision("fixture.preferencia", "human")];
    const result = advanceFlowRun({ state: newRunState("plan-exec", SESSION), journey });
    if (!result.ok) throw new Error("esperaba una frontera humana");
    expect(result.directive.request).toBeNull();
  });
});

describe("frontera humana — sobre una corrida real", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-human-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — prueba\n",
      "utf8",
    );
    // PLAN exec stops on its consented normalization — but only when a minor entry
    // gap was declared, and only after the delegated session read and entry gate
    // have come back with real output. Adopting no longer reaches it in one call,
    // so the run is POSITIONED there instead of walked: this file's subject is what
    // the boundary does, not how many submits it took to arrive. The observation is
    // seeded too, because without it the row is legitimately skipped.
    await seedRunAt("plan-exec.normalization-consent");
    const adopted = await advanceFlow(fs, paths, { code: "001", flow: "plan-exec" });
    if (!adopted.ok) throw new Error("esperaba leer la corrida posicionada");
    expect(adopted.directive.boundary.kind).toBe("human");
    expect(adopted.directive.boundary.transition).toBe("plan-exec.normalization-consent");
  });

  /** Leave a persisted run exactly where the engine would leave it: stopped at `id`. */
  async function seedRunAt(id: string): Promise<void> {
    const journey = decisionsOfScope("plan-exec");
    let state = withObservation(newRunState("plan-exec", SESSION), {
      transition: "plan-exec.entry-gap-recognition",
      signals: ["plan.entry-gap-minor"],
      decisions: {},
    });
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
  }

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  const statePath = (): string => join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE);

  async function seal(): Promise<string> {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error("esperaba leer la corrida");
    return resolveBoundary(read.state, decisionsOfScope(read.state.flow)).seal;
  }

  it("una elección fuera del conjunto emitido se rechaza con acción y no escribe", async () => {
    const before = await readFile(statePath(), "utf8");
    const result = await submitFlow(fs, paths, {
      code: "001",
      raw: JSON.stringify({ input_digest: await seal(), choice: "Lo que me parezca" }),
      approval: null,
    });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
    expect(result.directive.error?.code).toBe("FLOW_CHOICE_UNKNOWN");
    // The row declares its own alternatives now, so the rejection quotes the ones
    // the doctrine used to enumerate — not the generic pair the engine falls back
    // to for a migrated row that names none.
    expect(result.directive.error?.action).toContain("Normalizar y ejecutar");
    expect(await readFile(statePath(), "utf8")).toBe(before);
  });

  it("una respuesta sin elección es ambigua, no un default silencioso", async () => {
    const result = await submitFlow(fs, paths, {
      code: "001",
      raw: JSON.stringify({ input_digest: await seal() }),
      approval: null,
    });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
    expect(result.directive.error?.code).toBe("FLOW_ANSWER_AMBIGUOUS");
  });

  it("la elección emitida se acepta y el avance sigue desde ahí", async () => {
    const result = await submitFlow(fs, paths, {
      code: "001",
      raw: JSON.stringify({ input_digest: await seal(), choice: "Normalizar y ejecutar" }),
      approval: null,
    });
    if (!result.ok) throw new Error("esperaba que la elección se aplicara");
    expect(result.directive.error).toBeNull();
    expect(result.directive.applied.map((step) => step.transition)).toContain(
      "plan-exec.normalization-consent",
    );
  });

  it("declinar es una respuesta real y no aplica nada", async () => {
    const before = await readFile(statePath(), "utf8");
    const result = await submitFlow(fs, paths, {
      code: "001",
      raw: JSON.stringify({ input_digest: await seal(), choice: "Cerrar" }),
      approval: null,
    });
    if (!result.ok) throw new Error("declinar viaja ok:true");
    expect(result.directive.outcome).toBe("cancelled");
    expect(result.directive.error?.code).toBe("FLOW_BOUNDARY_DECLINED");
    expect(result.directive.boundary.transition).toBe("plan-exec.normalization-consent");
    expect(await readFile(statePath(), "utf8")).toBe(before);
  });
});
