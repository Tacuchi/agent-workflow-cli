// The host run's scenario (plan 085, T1.1): one step per surface, every fixed
// answer a literal label the CLI emits, one invocation per covered host.

import { describe, expect, it } from "vitest";
import {
  ALL_HOSTS,
  COVERED_HOSTS,
  HOSTS,
  NOT_COVERED,
  SURFACES,
} from "../../scripts/host-run/hosts.mjs";
import {
  FLOW_CONTROLS,
  STEPS,
  buildScenario,
  resolveSteps,
  scenarioAnswers,
  stepForHost,
} from "../../scripts/host-run/scenario.mjs";
import { FLOW_DECISIONS } from "../../src/domain/flow/authority.js";
import { PAUSE_LABEL, STOP_LABEL } from "../../src/domain/flow/directive.js";
import { ROUTE_ACCEPT_LABEL, ROUTE_ADJUST_LABEL } from "../../src/domain/flow/route.js";
import { HARNESSES } from "../../src/domain/harnesses.js";

/** Every label the flow registry can emit at a boundary, by transition id. */
function registryLabels(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const d of FLOW_DECISIONS) {
    const alternatives = (d as { alternatives?: { label: string }[] }).alternatives;
    if (alternatives)
      map.set(
        d.id,
        alternatives.map((a) => a.label),
      );
  }
  map.set("chassis.route-evaluation", [ROUTE_ACCEPT_LABEL, ROUTE_ADJUST_LABEL]);
  return map;
}

describe("host-run scenario", () => {
  it("has exactly one step per surface of the matrix", () => {
    expect(STEPS.map((s) => s.surface).sort()).toEqual([...SURFACES].sort());
  });

  it("uses the flow controls the CLI emits", () => {
    expect(FLOW_CONTROLS).toEqual([PAUSE_LABEL, STOP_LABEL]);
  });

  it("every fixed answer is a literal label of its boundary", () => {
    const registry = registryLabels();
    for (const step of STEPS) {
      for (const b of step.boundaries) {
        expect([...b.labels, ...FLOW_CONTROLS], `${step.surface}/${b.id}`).toContain(b.answer);
        const emitted = registry.get(b.id);
        // Boundaries whose options the agent authors (doctor, recall) carry no
        // registry labels: only the flow controls are literal there.
        if (emitted) expect(b.labels, b.id).toEqual(emitted);
        else expect(b.labels, b.id).toEqual([]);
      }
    }
  });

  it("answers the quick size gate with Recortar alcance and stops before the commit", () => {
    const quick = STEPS.find((s) => s.surface === "structured-choice");
    const gate = quick?.boundaries.find((b) => b.id === "quick.gate-choice");
    expect(gate?.answer).toBe("Recortar alcance");
    expect(quick?.boundaries.map((b) => b.id)).not.toContain("quick.commit-authorization");
  });

  it("closes the doctor offer, the recall offer and the session with Cerrar", () => {
    for (const surface of ["commands", "host-memory", "compaction"]) {
      const step = STEPS.find((s) => s.surface === surface);
      expect(step?.boundaries.map((b) => b.answer)).toEqual([STOP_LABEL]);
    }
  });

  it("never answers with a bare confirmation", () => {
    for (const answer of scenarioAnswers()) {
      expect(answer).not.toMatch(/^(y|yes|1|enter|ok|s[ií])$/i);
    }
  });

  it("covers four hosts and leaves warp, oz, kimi and crush (both excluded by the person) out, each with its reason", () => {
    expect([...COVERED_HOSTS].sort()).toEqual(
      ["claude-code", "codex", "gemini", "opencode"].sort(),
    );
    expect(Object.keys(NOT_COVERED).sort()).toEqual(["crush", "kimi", "oz", "warp"]);
    expect(NOT_COVERED.crush).toBe(
      "provider timeout in the auth probe (3 attempts, 2026-09-30); left out by the person to limit cost",
    );
    expect(NOT_COVERED.kimi).toMatch(/subscription cancelled by the person/);
    for (const reason of Object.values(NOT_COVERED)) expect(reason.length).toBeGreaterThan(20);
    expect(ALL_HOSTS).toEqual(HARNESSES.map((h) => h.id));
  });

  it("maps every covered host onto its catalog install and MCP target", () => {
    for (const id of COVERED_HOSTS) {
      const harness = HARNESSES.find((h) => h.id === id);
      expect(HOSTS[id].installTarget, id).toBe(harness?.installTarget);
      expect(HOSTS[id].mcpHost, id).toBe(harness?.mcpHostId);
      expect(harness?.runtime.bins, id).toContain(HOSTS[id].bin);
    }
  });

  it("invokes each command through the host's packaging in HARNESS.md", () => {
    const doctor = STEPS.find((s) => s.surface === "commands");
    if (!doctor) throw new Error("no commands step");
    const text = (h: string) => stepForHost(doctor, h).invocation.text;
    expect(text("claude-code")).toBe("/w:doctor");
    // codex: text after a bare mention, so Enter submits instead of picking the completion.
    expect(text("codex")).toBe("$w-doctor (no arguments)");
    expect(text("opencode")).toBe("/w/doctor");
    expect(text("kimi")).toBe("/skill:w-doctor");
    expect(text("gemini")).toContain("w-doctor");
    expect(stepForHost(doctor, "crush").invocation).toEqual({
      text: "user:w:doctor",
      via: "palette",
    });
  });

  it("falls back to resume where a host has no compaction command", () => {
    const compaction = STEPS.find((s) => s.surface === "compaction");
    if (!compaction) throw new Error("no compaction step");
    expect(stepForHost(compaction, "claude-code").invocation.text).toBe("/compact");
    expect(stepForHost(compaction, "crush")).toMatchObject({
      fallback: true,
      invocation: { text: "user:w:resume", via: "palette" },
    });
  });

  it("builds the same scenario data for every covered host", () => {
    const scenario = buildScenario(COVERED_HOSTS);
    expect(scenario.steps).toHaveLength(SURFACES.length);
    for (const step of scenario.steps)
      expect(Object.keys(step.hosts).sort()).toEqual([...COVERED_HOSTS].sort());
  });

  it("the quick step's stop points carry the registry's own labels", () => {
    const registry = registryLabels();
    const quickStep = STEPS.find((st) => st.surface === "structured-choice");
    expect(quickStep?.stopAt?.map((b: { id: string }) => b.id)).toContain(
      "quick.commit-authorization",
    );
    for (const b of quickStep?.stopAt ?? []) expect(b.labels, b.id).toEqual(registry.get(b.id));
  });

  it("--steps adds what a step depends on, and refuses an unknown surface", () => {
    const hooks = resolveSteps(["hooks"]);
    expect(hooks.steps.map((s) => s.surface)).toEqual(["structured-choice", "hooks", "compaction"]);
    expect(hooks.added.sort()).toEqual(["compaction", "structured-choice"]);
    expect(resolveSteps(["mcp"])).toMatchObject({ added: [] });
    expect(() => resolveSteps(["nope"])).toThrow(/unknown surface nope/);
  });
});
