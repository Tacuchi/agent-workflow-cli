import { describe, expect, it } from "vitest";
import { parseProjectBlock } from "../../src/application/parsers/project-block.js";
import { blockFromParsed, renderProjectBlock } from "../../src/application/render/project-block.js";

const BASE = {
  proyecto: "X",
  fuentes: [{ alias: "core", path: "/p", main_branch: "certificacion" }],
  stack: {},
  lastActivity: "2026-01-01 00:00",
} as const;

describe("project-block default_branches", () => {
  it("renders a 'Ramas por defecto' entry when defaults are declared", () => {
    const out = renderProjectBlock({
      ...BASE,
      defaultBranches: { principal: "main", desarrollo: "development", qa: "qa" },
    });
    expect(out).toContain("- Ramas por defecto:");
    expect(out).toContain("  - principal: main");
    expect(out).toContain("  - desarrollo: development");
    expect(out).toContain("  - qa: qa");
  });

  it("renders only the declared roles (partial defaults)", () => {
    const out = renderProjectBlock({ ...BASE, defaultBranches: { qa: "release/qa" } });
    expect(out).toContain("  - qa: release/qa");
    expect(out).not.toContain("principal:");
    expect(out).not.toContain("desarrollo:");
  });

  it("omits the entry when defaults are empty/undefined", () => {
    expect(renderProjectBlock(BASE)).not.toContain("Ramas por defecto");
    expect(renderProjectBlock({ ...BASE, defaultBranches: {} })).not.toContain("Ramas por defecto");
  });

  it("places the entry BEFORE the branch lists (old parsers ignore it there)", () => {
    const out = renderProjectBlock({
      ...BASE,
      defaultBranches: { principal: "main" },
      workingBranches: { core: "feature/x" },
      qaBranches: { core: "desarrollo" },
    });
    expect(out.indexOf("- Ramas por defecto:")).toBeLessThan(
      out.indexOf("- Ramas de trabajo actuales:"),
    );
    expect(out.indexOf("- Ramas por defecto:")).toBeLessThan(out.indexOf("- Ramas QA actuales:"));
  });

  it("does not leak defaults into working_branches / qa_branches", () => {
    const out = renderProjectBlock({
      ...BASE,
      defaultBranches: { principal: "main", desarrollo: "development", qa: "qa" },
      workingBranches: { core: "feature/x" },
      qaBranches: { core: "desarrollo" },
    });
    const parsed = parseProjectBlock(out);
    expect(parsed?.working_branches).toEqual({ core: "feature/x" });
    expect(parsed?.qa_branches).toEqual({ core: "desarrollo" });
  });

  it("parses the entry into default_branches and ignores unknown roles", () => {
    const out = renderProjectBlock({
      ...BASE,
      defaultBranches: { principal: "main", qa: "qa" },
    }).replace("  - qa: qa", "  - qa: qa\n  - inventado: nope");
    const parsed = parseProjectBlock(out);
    expect(parsed?.default_branches).toEqual({ principal: "main", qa: "qa" });
  });

  it("defaults to an empty object when no entry is present", () => {
    expect(parseProjectBlock(renderProjectBlock(BASE))?.default_branches).toEqual({});
  });

  it("round-trips through blockFromParsed", () => {
    const first = renderProjectBlock({
      ...BASE,
      defaultBranches: { principal: "main", desarrollo: "development", qa: "qa" },
      workingBranches: { core: "feature/x" },
    });
    const parsed = parseProjectBlock(first);
    if (!parsed) throw new Error("expected parsed block");
    const second = blockFromParsed(parsed);
    expect(second).toBe(first);
    expect(parseProjectBlock(second)?.default_branches).toEqual({
      principal: "main",
      desarrollo: "development",
      qa: "qa",
    });
  });

  it("a block without defaults re-renders identical (no phantom entry)", () => {
    const first = renderProjectBlock({ ...BASE, workingBranches: { core: "feature/x" } });
    const parsed = parseProjectBlock(first);
    if (!parsed) throw new Error("expected parsed block");
    expect(blockFromParsed(parsed)).toBe(first);
  });
});

describe("project-block main_branch (nullable)", () => {
  it("parses a populated legacy cell as-is", () => {
    const parsed = parseProjectBlock(renderProjectBlock(BASE));
    expect(parsed?.fuentes[0]?.main_branch).toBe("certificacion");
  });

  it("parses an empty cell as null instead of the legacy 'certificacion' literal", () => {
    const out = renderProjectBlock({
      ...BASE,
      fuentes: [{ alias: "core", path: "/p", main_branch: null }],
    });
    expect(out).toContain("| core | /p |  |");
    expect(parseProjectBlock(out)?.fuentes[0]?.main_branch).toBeNull();
  });

  it("round-trips a null main_branch", () => {
    const first = renderProjectBlock({
      ...BASE,
      fuentes: [{ alias: "core", path: "/p", main_branch: null }],
    });
    const parsed = parseProjectBlock(first);
    if (!parsed) throw new Error("expected parsed block");
    expect(blockFromParsed(parsed)).toBe(first);
  });
});
