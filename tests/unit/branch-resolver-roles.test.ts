import { describe, expect, it } from "vitest";
import {
  BRANCH_ROLE_FALLBACKS,
  resolveSourceBranches,
} from "../../src/application/branch-resolver.js";
import type {
  ParsedProjectBlock,
  ProjectFuente,
} from "../../src/application/parsers/project-block.js";

const source: ProjectFuente = { alias: "core", path: "/repo/core", main_branch: "certificacion" };

function block(over: Partial<ParsedProjectBlock> = {}): ParsedProjectBlock {
  return {
    proyecto: "X",
    fuentes: [source],
    stack: {},
    default_branches: {},
    working_branches: {},
    qa_branches: {},
    last_activity: null,
    ...over,
  };
}

describe("resolveSourceBranches — per-source → workspace default → fallback", () => {
  // Pinned against the LITERALS, not the constant: the rest of this file asserts
  // symbolically (which reads better), so without this anchor a typo or rename of
  // the floor would ship green — every source with nothing declared would then be
  // checked out onto a branch that does not exist.
  it("pins the documented fallback floor", () => {
    expect(BRANCH_ROLE_FALLBACKS).toEqual({
      principal: "main",
      desarrollo: "development",
      qa: "qa",
    });
  });

  it("uses the hardcoded fallbacks when nothing is declared", () => {
    const roles = resolveSourceBranches({ ...source, main_branch: null }, block());
    expect(roles).toEqual({
      prod: BRANCH_ROLE_FALLBACKS.principal,
      work: BRANCH_ROLE_FALLBACKS.desarrollo,
      qa: BRANCH_ROLE_FALLBACKS.qa,
      dev: BRANCH_ROLE_FALLBACKS.desarrollo,
    });
  });

  it("uses the workspace defaults over the fallbacks", () => {
    const roles = resolveSourceBranches(
      { ...source, main_branch: null },
      block({ default_branches: { principal: "trunk", desarrollo: "develop", qa: "release/qa" } }),
    );
    expect(roles).toEqual({ prod: "trunk", work: "develop", qa: "release/qa", dev: "develop" });
  });

  it("uses the per-source values over the workspace defaults", () => {
    const roles = resolveSourceBranches(
      source,
      block({
        default_branches: { principal: "trunk", desarrollo: "develop", qa: "release/qa" },
        working_branches: { core: "feature/x" },
        qa_branches: { core: "staging" },
      }),
    );
    // dev has no per-source value: it is always the workspace `desarrollo` default.
    expect(roles).toEqual({
      prod: "certificacion",
      work: "feature/x",
      qa: "staging",
      dev: "develop",
    });
  });

  it("ignores per-source empty strings and falls through", () => {
    const roles = resolveSourceBranches(
      { ...source, main_branch: "" },
      block({ working_branches: { core: "" }, qa_branches: { core: "" } }),
    );
    expect(roles.prod).toBe(BRANCH_ROLE_FALLBACKS.principal);
    expect(roles.work).toBe(BRANCH_ROLE_FALLBACKS.desarrollo);
    expect(roles.qa).toBe(BRANCH_ROLE_FALLBACKS.qa);
  });

  it("another source's declarations do not bleed in", () => {
    const roles = resolveSourceBranches(
      source,
      block({ working_branches: { other: "feature/y" }, qa_branches: { other: "staging" } }),
    );
    expect(roles.work).toBe(BRANCH_ROLE_FALLBACKS.desarrollo);
    expect(roles.qa).toBe(BRANCH_ROLE_FALLBACKS.qa);
  });

  it("resolves against a null block (no workspace)", () => {
    expect(resolveSourceBranches(source, null)).toEqual({
      prod: "certificacion",
      work: BRANCH_ROLE_FALLBACKS.desarrollo,
      qa: BRANCH_ROLE_FALLBACKS.qa,
      dev: BRANCH_ROLE_FALLBACKS.desarrollo,
    });
  });
});
