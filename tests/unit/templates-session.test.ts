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
    expect(md).toContain("## Type\nresearch");
    expect(md).toContain("## Origin");
    // Components is never rendered; Success criteria is research-only.
    expect(md).not.toContain("## Components");
    expect(md).toContain("## Success criteria");
  });

  it("never emits a Components section, for any type", () => {
    for (const type of ["research", "refine", "exec", "quick"]) {
      const md = renderSessionMarkdown({ name: "s", type, objetivo: "do it" });
      expect(md).not.toContain("## Components");
    }
  });

  it("emits a blank Success criteria checklist for research only", () => {
    const research = renderSessionMarkdown({ name: "s", type: "research", objetivo: "do it" });
    // One blank checkbox under the research checklist section.
    expect(research).toMatch(/## Success criteria\n<!--[\s\S]*?-->\n- \[ \]/);

    for (const type of ["refine", "exec", "quick"]) {
      const md = renderSessionMarkdown({ name: "s", type, objetivo: "do it" });
      expect(md).not.toContain("## Success criteria");
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
