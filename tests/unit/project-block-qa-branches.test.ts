import { describe, expect, it } from "vitest";
import { parseProjectBlock } from "../../src/application/parsers/project-block.js";
import { blockFromParsed, renderProjectBlock } from "../../src/application/render/project-block.js";

describe("project-block qa_branches", () => {
  it("renders a 'Ramas QA actuales' section when qaBranches is non-empty", () => {
    const out = renderProjectBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      qaBranches: { a: "desarrollo" },
    });
    expect(out).toContain("- Ramas QA actuales:");
    expect(out).toContain("  - a: desarrollo");
  });

  it("omits the QA section when qaBranches is empty/undefined", () => {
    const out = renderProjectBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
    });
    expect(out).not.toContain("Ramas QA actuales");
  });

  it("parses the 'Ramas QA actuales' section into qa_branches", () => {
    const out = renderProjectBlock({
      proyecto: "X",
      fuentes: [{ alias: "core", path: "/p", main_branch: "certificacion" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      workingBranches: { core: "feature/x" },
      qaBranches: { core: "desarrollo" },
    });
    const parsed = parseProjectBlock(out);
    expect(parsed).not.toBeNull();
    expect(parsed?.qa_branches).toEqual({ core: "desarrollo" });
    expect(parsed?.working_branches).toEqual({ core: "feature/x" });
  });

  it("defaults qa_branches to an empty object when no QA section is present", () => {
    const out = renderProjectBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
    });
    const parsed = parseProjectBlock(out);
    expect(parsed?.qa_branches).toEqual({});
  });

  it("round-trips qa_branches through blockFromParsed", () => {
    const first = renderProjectBlock({
      proyecto: "X",
      fuentes: [{ alias: "core", path: "/p", main_branch: "certificacion" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      qaBranches: { core: "desarrollo" },
    });
    const parsed = parseProjectBlock(first);
    if (!parsed) throw new Error("expected parsed block");
    const second = blockFromParsed(parsed);
    expect(second).toContain("- Ramas QA actuales:");
    expect(second).toContain("  - core: desarrollo");
    const reparsed = parseProjectBlock(second);
    expect(reparsed?.qa_branches).toEqual({ core: "desarrollo" });
  });
});
