import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advanceFlowRun, resolveBoundary } from "../../src/application/flow/advance.js";
import { advanceFlow } from "../../src/application/flow/flow-service.js";
import { locateRun, readRun } from "../../src/application/flow/run-state-service.js";
import { submitFlow } from "../../src/application/flow/submit.js";
import { PathsService } from "../../src/application/paths-service.js";
import {
  type EffectClass,
  SELF_AUTHORIZABLE_CLASSES,
} from "../../src/domain/capability/effects.js";
import type { FlowDecision } from "../../src/domain/flow/authority.js";
import { decisionsOfScope, effectsOf } from "../../src/domain/flow/authority.js";
import { authorizeTransition, effectApprovalDigest } from "../../src/domain/flow/authorization.js";
import type { FlowDirective } from "../../src/domain/flow/directive.js";
import { FLOW_RUN_STATE_FILE, newRunState } from "../../src/domain/flow/run-state.js";
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
 * The automatic advance never widens an authorization.
 *
 * What an invocation may grant itself is the taxonomy's own answer — reading, and
 * creating something new inside the target already named. Overwriting, running
 * code, leaving the machine and destroying stop the run at a boundary that names
 * the effect, and the ledger says planned / approved / applied so a partial effect
 * is expressible instead of guessed.
 */

const SESSION = "001-prueba-efectos";
const fs = new NodeFileSystem();

function decision(id: string, effects?: readonly EffectClass[]): FlowDecision {
  return {
    id,
    scope: "quick",
    title: `transición ${id} del fixture de efectos`,
    authority: "cli",
    // The engine only applies what the CLI owns: a fixture still marked `legacy`
    // would stop at its first step, which is the migration's rule, not this
    // file's subject.
    ownership: "cli-owned",
    document: "loops/quick-loop/LOOP.md",
    ...(effects === undefined ? {} : { effects }),
  };
}

describe("autorización por transición — una sola política, la ya entregada", () => {
  it("una decisión sin efectos declarados es read_only", () => {
    expect(effectsOf(decision("fixture.calcula"))).toEqual(["read_only"]);
  });

  it("lo que la invocación puede darse a sí misma es exactamente la taxonomía", () => {
    for (const effect of SELF_AUTHORIZABLE_CLASSES) {
      const verdict = authorizeTransition(decision("fixture.x", [effect]), []);
      expect(verdict.missing, effect).toEqual([]);
      expect(verdict.covered, effect).toEqual([effect]);
    }
  });

  it("sobrescribir, ejecutar, salir de la máquina y destruir exigen aprobación", () => {
    const guarded: EffectClass[] = [
      "mutate_overwrite",
      "execute",
      "network_external",
      "destructive",
    ];
    for (const effect of guarded) {
      const verdict = authorizeTransition(decision("fixture.x", [effect]), []);
      expect(verdict.missing, effect).toEqual([effect]);
    }
  });

  it("una autorización previa cubre SU clase y ninguna otra", () => {
    const granted: EffectClass[] = ["mutate_overwrite"];
    expect(
      authorizeTransition(decision("fixture.x", ["mutate_overwrite"]), granted).missing,
    ).toEqual([]);
    // Nothing inherits: approving an overwrite never buys running code.
    expect(authorizeTransition(decision("fixture.y", ["execute"]), granted).missing).toEqual([
      "execute",
    ]);
    expect(authorizeTransition(decision("fixture.z", ["destructive"]), granted).missing).toEqual([
      "destructive",
    ]);
  });

  it("el sello de aprobación describe el CONJUNTO, no el orden en que se listó", () => {
    const one = effectApprovalDigest("fixture.x", ["execute", "mutate_overwrite"]);
    const other = effectApprovalDigest("fixture.x", ["mutate_overwrite", "execute"]);
    expect(one).toBe(other);
    // …and it is bound to the transition it approves.
    expect(effectApprovalDigest("fixture.y", ["execute", "mutate_overwrite"])).not.toBe(one);
  });
});

describe("el avance con autorización suficiente aplica y lo registra", () => {
  it("aplica los efectos autoautorizables y los deja en planned y applied", () => {
    const journey = [decision("fixture.crea", ["local_additive"]), decision("fixture.lee")];
    const result = advanceFlowRun({ state: newRunState("quick", SESSION), journey });
    if (!result.ok) throw new Error(`esperaba avanzar: ${result.failure.code}`);
    expect(result.directive.applied.map((step) => step.transition)).toEqual([
      "fixture.crea",
      "fixture.lee",
    ]);
    expect(result.state.effects.planned.sort()).toEqual(["local_additive", "read_only"]);
    expect(result.state.effects.applied.sort()).toEqual(["local_additive", "read_only"]);
    expect(result.state.effects.approved).toEqual([]);
  });

  it("el que necesita aprobación nueva detiene el avance sin aplicar nada", () => {
    const journey = [
      decision("fixture.lee"),
      decision("fixture.sobrescribe", ["mutate_overwrite"]),
      decision("fixture.despues"),
    ];
    const result = advanceFlowRun({ state: newRunState("quick", SESSION), journey });
    if (!result.ok) throw new Error("esperaba una frontera de autorización");

    expect(result.directive.boundary.kind).toBe("authorization");
    expect(result.directive.boundary.transition).toBe("fixture.sobrescribe");
    expect(result.directive.applied.map((step) => step.transition)).toEqual(["fixture.lee"]);
    // Planned, because that is what is being asked for — and NOT applied.
    expect(result.directive.effects.planned).toContain("mutate_overwrite");
    expect(result.directive.effects.applied).not.toContain("mutate_overwrite");
    expect(result.state.effects.applied).not.toContain("mutate_overwrite");
    // Nothing past it ran either: the run does not step over the boundary.
    expect(result.directive.pending).toEqual(["fixture.sobrescribe", "fixture.despues"]);
  });

  it("la frontera nombra el efecto, su consecuencia y el sello a aprobar", () => {
    const journey = [decision("fixture.corre", ["execute"])];
    const result = advanceFlowRun({ state: newRunState("quick", SESSION), journey });
    if (!result.ok) throw new Error("esperaba una frontera de autorización");
    expect(result.directive.choices.some((choice) => choice.consequence.includes("execute"))).toBe(
      true,
    );
    expect(result.directive.next_action).toContain(
      effectApprovalDigest("fixture.corre", ["execute"]),
    );
  });

  it("con la autorización ya concedida, la misma transición avanza", () => {
    const journey = [decision("fixture.sobrescribe", ["mutate_overwrite"])];
    const seeded = { ...newRunState("quick", SESSION), authorizations: ["mutate_overwrite"] };
    const result = advanceFlowRun({
      state: { ...seeded, digest: newRunState("quick", SESSION).digest },
      journey,
    });
    // The seeded state is re-sealed by the engine's own writes, so what matters
    // here is the verdict, not the digest of the hand-built input.
    if (!result.ok) throw new Error("esperaba avanzar con la autorización concedida");
    expect(result.directive.applied.map((step) => step.transition)).toEqual([
      "fixture.sobrescribe",
    ]);
    expect(result.directive.boundary.kind).toBe("final");
  });
});

describe("el registro planned/approved/applied vive en el estado persistido", () => {
  let workdir: string;
  let paths: PathsService;

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "aw-flow-effects-"));
    paths = new PathsService(normalizeNamespace("agent-workflow"), workdir, workdir);
    await mkdir(join(paths.cwdSessionsDir(), SESSION), { recursive: true });
    await writeFile(
      join(paths.cwdSessionsDir(), SESSION, "SESSION.md"),
      "# SESSION — prueba\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it("QUICK se detiene en su gate de convergencia, que corre pruebas", async () => {
    // `quick.convergence-gate` really runs a test runner, so it declares `execute`
    // and cannot be self-authorized: the run has to stop and ask.
    const gate = decisionsOfScope("quick").find((row) => row.id === "quick.convergence-gate");
    expect(effectsOf(gate as FlowDecision)).toEqual(["execute"]);
  });

  /** The boundary the run currently stands on, read from the persisted state. */
  async function current() {
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error("esperaba leer la corrida");
    const resolved = resolveBoundary(read.state, decisionsOfScope("quick"));
    if (resolved.stopped === null) throw new Error("el recorrido terminó sin pedir autorización");
    return resolved;
  }

  async function answer(raw: string, approval: string | null = null): Promise<FlowDirective> {
    const result = await submitFlow(fs, paths, { code: "001", raw, approval });
    if (!result.ok) throw new Error("un rechazo de negocio viaja ok:true");
    return result.directive;
  }

  /** Answer whatever the run asks until it stands on an authorization boundary. */
  async function walkToAuthorization(): Promise<FlowDirective> {
    const adopted = await advanceFlow(fs, paths, { code: "001", flow: "quick", adopt: true });
    if (!adopted.ok) throw new Error("esperaba adoptar la corrida");
    let directive = adopted.directive;
    for (let step = 0; step < 10 && directive.boundary.kind !== "authorization"; step += 1) {
      const resolved = await current();
      const body =
        resolved.kind === "semantic"
          ? { input_digest: resolved.seal, decisions: { paso: resolved.stopped?.id } }
          : { input_digest: resolved.seal, choice: "Resolver la frontera" };
      directive = await answer(JSON.stringify(body));
    }
    return directive;
  }

  it("declinar la autorización NO exige entregar la aprobación que se está negando", async () => {
    const directive = await walkToAuthorization();
    expect(directive.boundary.kind).toBe("authorization");
    const statePath = join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE);
    const before = await readFile(statePath, "utf8");

    // The emitted alternative has to be answerable: demanding `--approval` to say
    // "no" would make `Cerrar` decorative.
    const declined = await answer(
      JSON.stringify({ input_digest: directive.state_digest, choice: "Cerrar" }),
    );
    expect(declined.outcome).toBe("cancelled");
    expect(declined.error?.code).toBe("FLOW_BOUNDARY_DECLINED");
    expect(declined.effects.applied).not.toContain("execute");
    expect(declined.authorizations).not.toContain("execute");
    expect(await readFile(statePath, "utf8")).toBe(before);
  });

  it("aprobar registra la autorización y el efecto, y recién entonces se aplica", async () => {
    const directive = await walkToAuthorization();
    expect(directive.boundary.kind).toBe("authorization");
    expect(directive.effects.planned).toContain("execute");
    expect(directive.effects.applied).not.toContain("execute");

    const statePath = join(paths.cwdSessionsDir(), SESSION, FLOW_RUN_STATE_FILE);
    const before = await readFile(statePath, "utf8");

    // The wrong approval never buys the effect.
    const wrong = await submitFlow(fs, paths, {
      code: "001",
      raw: JSON.stringify({ input_digest: directive.state_digest, choice: "Autorizar el efecto" }),
      // `state_digest` IS the seal the answer has to quote: same value the
      // semantic request would carry in its own `input_digest`.
      approval: "0".repeat(64),
    });
    if (!wrong.ok) throw new Error("un rechazo de negocio viaja ok:true");
    expect(wrong.directive.error?.code).toBe("FLOW_APPROVAL_MISMATCH");
    expect(await readFile(statePath, "utf8")).toBe(before);

    // The right one does, and the ledger records all three moments.
    const read = await readRun(fs, locateRun(paths, SESSION));
    if (!read.ok) throw new Error("esperaba leer la corrida");
    const resolved = resolveBoundary(read.state, decisionsOfScope("quick"));
    const digest = effectApprovalDigest(
      resolved.stopped?.id ?? "",
      resolved.authorization?.planned ?? [],
    );
    const granted = await submitFlow(fs, paths, {
      code: "001",
      raw: JSON.stringify({ input_digest: resolved.seal, choice: "Autorizar el efecto" }),
      approval: digest,
    });
    if (!granted.ok) throw new Error("esperaba que la aprobación se aplicara");
    expect(granted.directive.error).toBeNull();
    expect(granted.directive.authorizations).toContain("execute");
    expect(granted.directive.effects.approved).toContain("execute");
    expect(granted.directive.effects.applied).toContain("execute");

    const after = await readRun(fs, locateRun(paths, SESSION));
    if (!after.ok) throw new Error("esperaba leer la corrida");
    expect(after.state.authorizations).toContain("execute");
    expect(after.state.effects.approved).toContain("execute");
    expect(after.state.effects.applied).toContain("execute");
  });
});
