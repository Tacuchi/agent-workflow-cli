import { describe, expect, it } from "vitest";
import { renderSessionMarkdown } from "../../src/application/templates/session.js";

describe("renderSessionMarkdown — SESSION.md descriptor (new model)", () => {
  it("renders the canonical section skeleton with H1 = name", () => {
    const md = renderSessionMarkdown({
      name: "investiga-x",
      type: "research",
      objetivo: "Investigar el patrón X",
    });
    expect(md).toContain("# SESSION — investiga-x");
    expect(md).toContain("## Objective\nInvestigar el patrón X");
    expect(md).toContain("## Type\nresearch");
    expect(md).toContain("## Origin");
    expect(md).toContain("## Components");
    expect(md).toContain("## Success criteria");
  });

  it("emits blank checklists for Components and Success criteria", () => {
    const md = renderSessionMarkdown({
      name: "s",
      type: "exec",
      objetivo: "do it",
    });
    // One blank checkbox under each checklist section.
    expect(md).toMatch(/## Components\n<!--[\s\S]*?-->\n- \[ \]/);
    expect(md).toMatch(/## Success criteria\n<!--[\s\S]*?-->\n- \[ \]/);
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
