import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKLINE_FLOWS } from "../../src/application/capability/compose.js";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import {
  CHASSIS_SCOPE,
  COMMAND_EXCLUSIONS,
  FLOW_AUTHORITIES,
  FLOW_DECISIONS,
  FLOW_TRANCHES,
  TRANSITION_OWNERSHIPS,
  actionOf,
  commandOfScope,
  decisionsOfScope,
  flowOfScope,
  hasLegacyOwnership,
  trancheOfFlow,
} from "../../src/domain/flow/authority.js";

/**
 * The authority registry, checked in BOTH directions.
 *
 * Forward: every row points at a flow, the chassis or a real command, and at a
 * document the bundle actually ships. Backward: every registered command is
 * either classified or excluded on the record — the two together are what makes
 * "exhaustive" a checkable claim instead of a promise.
 *
 * What no test can prove is exhaustiveness against the PROSE: whether the
 * doctrine holds a rule nobody transcribed is a judgment, and it is covered by
 * the document→rows checklist recorded in the execution session, not here.
 */

const BUNDLE = resolve(__dirname, "..", "..", "skills", "w");
const registered = new Set(ALL_COMMANDS.map((command) => command.name));

describe("registro de autoridad — forma y unicidad", () => {
  it("cada decisión tiene un id único", () => {
    const seen = new Map<string, number>();
    for (const decision of FLOW_DECISIONS) {
      seen.set(decision.id, (seen.get(decision.id) ?? 0) + 1);
    }
    expect([...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id)).toEqual([]);
  });

  it("cada decisión declara UNA autoridad y UNA propiedad del vocabulario cerrado", () => {
    for (const decision of FLOW_DECISIONS) {
      expect(FLOW_AUTHORITIES, decision.id).toContain(decision.authority);
      expect(TRANSITION_OWNERSHIPS, decision.id).toContain(decision.ownership);
    }
  });

  it("ninguna decisión cli-owned delega en juicio del agente o preferencia humana", () => {
    const impossible = FLOW_DECISIONS.filter(
      (decision) => decision.ownership === "cli-owned" && decision.authority !== "cli",
    );
    expect(impossible.map((decision) => decision.id)).toEqual([]);
  });

  it("solo una decisión del CLI puede delegar su ejecución", () => {
    // An `agent` or `human` row already hands control back for a different reason;
    // a second one would make the boundary ambiguous — two answers admissible at
    // the same stop, and the caller choosing which.
    const offenders = FLOW_DECISIONS.filter(
      (decision) => actionOf(decision) !== null && decision.authority !== "cli",
    );
    expect(offenders.map((decision) => decision.id)).toEqual([]);
  });

  it("toda acción delegada es reproducible, verificable y recuperable", () => {
    for (const decision of FLOW_DECISIONS) {
      const action = actionOf(decision);
      if (action === null) continue;
      // Reproducible: the caller must never have to reconstruct the call.
      expect(action.invocation.program.trim().length, decision.id).toBeGreaterThan(0);
      expect(action.invocation.target.trim().length, decision.id).toBeGreaterThan(0);
      // Verifiable: an action nobody can check is a confirmation with extra steps.
      expect(action.evidence.length, decision.id).toBeGreaterThan(0);
      for (const id of action.evidence) expect(id.trim().length, decision.id).toBeGreaterThan(0);
      // Recoverable: a partial result has to have somewhere to go.
      expect(action.recovery.trim().length, decision.id).toBeGreaterThan(10);
    }
  });

  it("cada título dice qué se decide, en una línea", () => {
    for (const decision of FLOW_DECISIONS) {
      expect(decision.title.trim().length, decision.id).toBeGreaterThan(10);
      expect(decision.title, decision.id).not.toContain("\n");
    }
  });
});

describe("registro de autoridad — cada entrada apunta a algo real", () => {
  it("todo scope resuelve a un flow, al chasis o a un comando registrado", () => {
    const orphans: string[] = [];
    for (const decision of FLOW_DECISIONS) {
      if (decision.scope === CHASSIS_SCOPE) continue;
      if (flowOfScope(decision.scope) !== null) continue;
      const command = commandOfScope(decision.scope);
      if (command !== null && registered.has(command)) continue;
      orphans.push(`${decision.id} → ${decision.scope}`);
    }
    expect(orphans).toEqual([]);
  });

  it("todo documento citado existe en el bundle", () => {
    const missing = FLOW_DECISIONS.filter(
      (decision) => !existsSync(join(BUNDLE, decision.document)),
    );
    expect(missing.map((decision) => `${decision.id} → ${decision.document}`)).toEqual([]);
  });

  it("los cinco flows y el chasis tienen decisiones declaradas", () => {
    for (const flow of WORKLINE_FLOWS) {
      expect(decisionsOfScope(flow).length, flow).toBeGreaterThan(0);
    }
    expect(decisionsOfScope(CHASSIS_SCOPE).length).toBeGreaterThan(0);
  });

  it("cada flow pertenece a un tramo declarado", () => {
    for (const flow of WORKLINE_FLOWS) {
      expect(FLOW_TRANCHES, flow).toContain(trancheOfFlow(flow));
    }
  });
});

describe("registro de autoridad — el universo es el command registry", () => {
  it("todo comando registrado tiene entradas o una exclusión con motivo", () => {
    const classified = new Set(
      FLOW_DECISIONS.map((decision) => commandOfScope(decision.scope)).filter(
        (command): command is string => command !== null,
      ),
    );
    const excluded = new Set(COMMAND_EXCLUSIONS.map((entry) => entry.command));
    const unclassified = [...registered].filter(
      (command) => !classified.has(command) && !excluded.has(command),
    );
    expect(unclassified).toEqual([]);
  });

  it("ninguna exclusión viene sin motivo", () => {
    for (const entry of COMMAND_EXCLUSIONS) {
      expect(entry.reason.trim().length, entry.command).toBeGreaterThan(10);
    }
  });

  it("ningún comando está a la vez clasificado y excluido", () => {
    const classified = new Set(
      FLOW_DECISIONS.map((decision) => commandOfScope(decision.scope)).filter(
        (command): command is string => command !== null,
      ),
    );
    const both = COMMAND_EXCLUSIONS.filter((entry) => classified.has(entry.command));
    expect(both.map((entry) => entry.command)).toEqual([]);
  });

  it("toda exclusión nombra un comando que existe", () => {
    const ghosts = COMMAND_EXCLUSIONS.filter((entry) => !registered.has(entry.command));
    expect(ghosts.map((entry) => entry.command)).toEqual([]);
  });
});

describe("registro de autoridad — la migración arranca observable", () => {
  it("todo tramo de flow todavía decide algo desde la doctrina", () => {
    for (const flow of WORKLINE_FLOWS) {
      expect(hasLegacyOwnership(flow), flow).toBe(true);
    }
    expect(hasLegacyOwnership(CHASSIS_SCOPE)).toBe(true);
  });

  it("lo cli-owned es lo que un comando ya entregado posee hoy", () => {
    const owned = FLOW_DECISIONS.filter((decision) => decision.ownership === "cli-owned");
    expect(owned.length).toBeGreaterThan(0);
    // No flow tranche is migrated yet: the cutovers are F11 · F13 · F14 · F15.
    const inFlows = owned.filter((decision) => flowOfScope(decision.scope) !== null);
    expect(inFlows.map((decision) => decision.id)).toEqual([
      "spec-refine.design-publication",
      "plan-new.numbering",
      "plan-exec.design-precondition",
    ]);
  });
});
