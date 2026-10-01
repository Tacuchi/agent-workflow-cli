import { describe, expect, it } from "vitest";
import { parseHubBlock } from "../../src/application/parsers/hub-block.js";
import { blockFromParsed, renderHubBlock } from "../../src/application/render/hub-block.js";

describe("project-block qa_branches", () => {
  it("round-trips modo in-place y rama de excepción sin absorber notas ajenas", () => {
    const first = renderHubBlock({
      proyecto: "X",
      fuentes: [{ alias: "core", path: "/p", main_branch: "main" }],
      stack: {},
      editMode: "in-place",
      exceptionBranches: { core: "hotfix/unico" },
    });
    const parsed = parseHubBlock(first);
    if (!parsed) throw new Error("expected parsed block");
    expect(parsed?.edit_mode).toBe("in-place");
    expect(parsed?.exception_branches).toEqual({ core: "hotfix/unico" });
    expect(blockFromParsed(parsed)).toBe(first);
  });
  it("renders a 'Ramas QA actuales' section when qaBranches is non-empty", () => {
    const out = renderHubBlock({
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
    const out = renderHubBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
    });
    expect(out).not.toContain("Ramas QA actuales");
  });

  it("parses the 'Ramas QA actuales' section into qa_branches", () => {
    const out = renderHubBlock({
      proyecto: "X",
      fuentes: [{ alias: "core", path: "/p", main_branch: "certificacion" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      workingBranches: { core: "feature/x" },
      qaBranches: { core: "desarrollo" },
    });
    const parsed = parseHubBlock(out);
    expect(parsed).not.toBeNull();
    expect(parsed?.qa_branches).toEqual({ core: "desarrollo" });
    expect(parsed?.working_branches).toEqual({ core: "feature/x" });
  });

  it("defaults qa_branches to an empty object when no QA section is present", () => {
    const out = renderHubBlock({
      proyecto: "X",
      fuentes: [{ alias: "a", path: "/p", main_branch: "b" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
    });
    const parsed = parseHubBlock(out);
    expect(parsed?.qa_branches).toEqual({});
  });

  it("round-trips qa_branches through blockFromParsed", () => {
    const first = renderHubBlock({
      proyecto: "X",
      fuentes: [{ alias: "core", path: "/p", main_branch: "certificacion" }],
      stack: {},
      lastActivity: "2026-01-01 00:00",
      qaBranches: { core: "desarrollo" },
    });
    const parsed = parseHubBlock(first);
    if (!parsed) throw new Error("expected parsed block");
    const second = blockFromParsed(parsed);
    expect(second).toContain("- Ramas QA actuales:");
    expect(second).toContain("  - core: desarrollo");
    const reparsed = parseHubBlock(second);
    expect(reparsed?.qa_branches).toEqual({ core: "desarrollo" });
  });
});
