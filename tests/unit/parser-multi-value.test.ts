import { describe, expect, it } from "vitest";
import { parseArgv } from "../../src/cli/parser.js";

describe("parser multi-value flags (--fuente / --working-branch)", () => {
  it("collects repeated --fuente values into valuesMulti", () => {
    const parsed = parseArgv([
      "project-md-upsert",
      "--init",
      "--fuente",
      "core:/repo/core",
      "--fuente",
      "plugin:/repo/plugin:main",
    ]);
    expect(parsed.valuesMulti.get("fuente")).toEqual([
      "core:/repo/core",
      "plugin:/repo/plugin:main",
    ]);
    expect(parsed.values.has("fuente")).toBe(false);
  });

  it("collects repeated --working-branch values into valuesMulti", () => {
    const parsed = parseArgv([
      "project-md-upsert",
      "--init",
      "--working-branch",
      "core:feature/x",
      "--working-branch",
      "plugin:feature/y",
    ]);
    expect(parsed.valuesMulti.get("working-branch")).toEqual([
      "core:feature/x",
      "plugin:feature/y",
    ]);
  });

  it("collects repeated --qa-branch values into valuesMulti", () => {
    const parsed = parseArgv([
      "workspace-init",
      "--qa-branch",
      "core:desarrollo",
      "--qa-branch",
      "plugin:qa/plugin",
    ]);
    expect(parsed.valuesMulti.get("qa-branch")).toEqual(["core:desarrollo", "plugin:qa/plugin"]);
    expect(parsed.values.has("qa-branch")).toBe(false);
  });

  it("preserves single-value semantics for --main-branch (last wins)", () => {
    const parsed = parseArgv([
      "project-md-upsert",
      "--init",
      "--main-branch",
      "first",
      "--main-branch",
      "second",
    ]);
    expect(parsed.values.get("main-branch")).toBe("second");
    expect(parsed.valuesMulti.has("main-branch")).toBe(false);
  });

  it("supports --fuente=value form alongside --fuente value form", () => {
    const parsed = parseArgv([
      "project-md-upsert",
      "--init",
      "--fuente=core:/repo/core",
      "--fuente",
      "plugin:/repo/plugin",
    ]);
    expect(parsed.valuesMulti.get("fuente")).toEqual(["core:/repo/core", "plugin:/repo/plugin"]);
  });
});
