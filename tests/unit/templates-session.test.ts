import { describe, expect, it } from "vitest";
import { renderSessionMarkdown } from "../../src/application/templates/session.js";

describe("renderSessionMarkdown — SESSION.md descriptor (new model)", () => {
  it("renders the canonical section skeleton with H1 = name (research)", () => {
    const md = renderSessionMarkdown({
      name: "investiga-x",
      type: "research",
      objetivo: "Investigar el patrón X",
    });
    expect(md).toContain("# SESSION — investiga-x");
    expect(md).toContain("## Objective\nInvestigar el patrón X");
    expect(md).toContain("## Origin");
    // Components is never rendered; Success criteria is seeded for all types (verification-first).
    expect(md).not.toContain("## Components");
    expect(md).toContain("## Success criteria");
  });

  it("never emits a Components section, for any type", () => {
    for (const type of ["research", "refine", "exec", "quick"]) {
      const md = renderSessionMarkdown({ name: "s", type, objetivo: "do it" });
      expect(md).not.toContain("## Components");
    }
  });

  it("omits Type when the loop descriptor already encodes it (artifact-slim round)", () => {
    // The 5 loop suffixes: the type is chrome there — the resolver derives it.
    const derivable: ReadonlyArray<[string, string]> = [
      ["042-foo-spec-refine", "refine"],
      ["042-foo-plan-new", "refine"],
      ["042-foo-plan-refine", "refine"],
      ["043-foo-plan-exec", "exec"],
      ["044-foo-quick", "quick"],
    ];
    for (const [name, type] of derivable) {
      const md = renderSessionMarkdown({ name, type, objetivo: "do it" });
      expect(md, name).not.toContain("## Type");
    }
  });

  it("keeps Type when the name does not encode it (write↔read must round-trip)", () => {
    // A free-form descriptor has no <slug>-<flow> suffix to read back: dropping
    // the declared type here would silently lose it (e.g. --type research).
    for (const [name, type] of [
      ["investiga-x", "research"],
      ["s", "exec"],
    ] as const) {
      const md = renderSessionMarkdown({ name, type, objetivo: "do it" });
      expect(md, name).toContain(`## Type\n${type}`);
    }
  });

  it("emits a blank Success criteria checklist for every type (verification-first)", () => {
    // verification-first: the done-condition is seeded for ALL session types, not
    // just research — a blank falsifiable checklist the loop fills before executing.
    for (const type of ["research", "refine", "exec", "quick"]) {
      const md = renderSessionMarkdown({ name: "s", type, objetivo: "do it" });
      expect(md).toMatch(/## Success criteria\n<!--[\s\S]*?-->\n- \[ \]/);
    }
  });

  it("renders the Origin placeholder comment when no origin is given", () => {
    const md = renderSessionMarkdown({ name: "s", type: "refine", objetivo: "o" });
    expect(md).toContain("Who created it and from where");
    // Placeholder is a single empty bullet under Origin.
    expect(md).toMatch(/## Origin\n<!--[\s\S]*?-->\n- /);
  });

  it("splits a comma-separated origin string into a bullet list", () => {
    const md = renderSessionMarkdown({
      name: "s",
      type: "exec",
      objetivo: "o",
      origin: "loop exec, docs/plan-004.md",
    });
    expect(md).toContain("## Origin\n- loop exec\n- docs/plan-004.md");
    expect(md).not.toContain("Who created it and from where");
  });

  it("renders a single-item origin without splitting", () => {
    const md = renderSessionMarkdown({
      name: "s",
      type: "quick",
      objetivo: "o",
      origin: "parent loop quick",
    });
    expect(md).toContain("## Origin\n- parent loop quick");
  });

  it("treats a whitespace-only origin as absent (placeholder)", () => {
    const md = renderSessionMarkdown({ name: "s", type: "exec", objetivo: "o", origin: "   " });
    expect(md).toContain("Who created it and from where");
  });
});
