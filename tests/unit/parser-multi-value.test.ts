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

describe("flagValue accessor (multi-routed flags reach commands that read single values)", () => {
  // Regression: `aw release-data --source X` / `aw check-branch --source X`
  // silently dropped the flag because `source` routes to valuesMulti while the
  // commands read `values` (the write↔read family of the v14.6.0 mcp bug).
  it("returns the last valuesMulti occurrence for a multi-value flag", async () => {
    const { flagValue } = await import("../../src/cli/parser.js");
    const parsed = parseArgv(["release-data", "--source", "core", "--source", "plugin"]);
    expect(parsed.values.has("source")).toBe(false);
    expect(flagValue(parsed, "source")).toBe("plugin");
  });

  it("falls back to values for single-value flags", async () => {
    const { flagValue } = await import("../../src/cli/parser.js");
    const parsed = parseArgv(["release-data", "--since", "session012"]);
    expect(flagValue(parsed, "since")).toBe("session012");
  });
});

describe("repeated --path / --pattern route to valuesMulti", () => {
  // Regression: attach-multiroot/code-scan re-scanned raw process.argv because
  // the parser overwrote repeated non-multi values (last-wins). Now both are
  // MULTI_VALUE_FLAGS so every occurrence is captured.
  it("collects repeated --path values into valuesMulti", () => {
    const parsed = parseArgv(["attach-multiroot", "--path", "/repo/a", "--path", "/repo/b"]);
    expect(parsed.valuesMulti.get("path")).toEqual(["/repo/a", "/repo/b"]);
    expect(parsed.values.has("path")).toBe(false);
  });

  it("collects repeated --pattern values into valuesMulti", () => {
    const parsed = parseArgv([
      "code-scan",
      "--pattern",
      "todo:TODO",
      "--pattern",
      "fixme:FIXME:alta",
    ]);
    expect(parsed.valuesMulti.get("pattern")).toEqual(["todo:TODO", "fixme:FIXME:alta"]);
  });
});

describe("boolean flags never consume the following positional", () => {
  // Regression: boolean flags greedily captured the next token as their value.
  // `merge-state --all /repo` lost BOTH (--all ate "/repo"); `git-flow --dry-run
  // sync` ate the action. Now known booleans route to `flags` and leave the
  // positional in `rest`.
  it("keeps the positional for `merge-state --all <path>`", () => {
    const parsed = parseArgv(["merge-state", "--all", "/repo"]);
    expect(parsed.flags.has("--all")).toBe(true);
    expect(parsed.rest).toEqual(["/repo"]);
    expect(parsed.values.has("all")).toBe(false);
  });

  it("keeps the action for `git-flow --dry-run sync`", () => {
    const parsed = parseArgv(["git-flow", "--dry-run", "sync"]);
    expect(parsed.flags.has("--dry-run")).toBe(true);
    expect(parsed.rest).toEqual(["sync"]);
    expect(parsed.values.has("dry-run")).toBe(false);
  });

  it("does not affect value flags: `--source X` still consumes its value", () => {
    const parsed = parseArgv(["git-flow", "sync", "--source", "core"]);
    expect(parsed.rest).toEqual(["sync"]);
    expect(parsed.valuesMulti.get("source")).toEqual(["core"]);
  });

  it("keeps the trailing token for `release-data --standalone-sql <x>` (gate F1-F8)", () => {
    // Regression class caught by the review gate: the flag was read via
    // flags.has() but missing from BOOLEAN_FLAGS, so it swallowed the next token.
    const parsed = parseArgv(["release-data", "--standalone-sql", "extra"]);
    expect(parsed.flags.has("--standalone-sql")).toBe(true);
    expect(parsed.rest).toEqual(["extra"]);
    expect(parsed.values.has("standalone-sql")).toBe(false);
  });
});

describe("single-dash help alias", () => {
  // Regression: `-h` fell into `rest` (only `--` tokens become flags), so
  // `aw <cmd> -h` EXECUTED the command instead of showing its help.
  it("captures -h as a flag so main.ts help detection fires", () => {
    const parsed = parseArgv(["sessions", "-h"]);
    expect(parsed.flags.has("-h")).toBe(true);
    expect(parsed.rest).toEqual([]);
  });
});

describe("plugin-flag lookup never resolves via the prototype chain", () => {
  // Regression: PLUGIN_FLAG_KEYS was a plain object, so a command token equal
  // to an Object.prototype member (hasOwnProperty/constructor/toString/…) was
  // falsely treated as a plugin flag and swallowed the next token.
  it("treats an Object.prototype-named token as a normal command, not a plugin flag", () => {
    const parsed = parseArgv(["hasOwnProperty", "extra"]);
    expect(parsed.command).toBe("hasOwnProperty");
    expect(parsed.rest).toEqual(["extra"]);
    expect(parsed.plugin).toEqual({});
  });

  it("does not consume the next token for a `constructor` command", () => {
    const parsed = parseArgv(["constructor", "--dry-run"]);
    expect(parsed.command).toBe("constructor");
    expect(parsed.flags.has("--dry-run")).toBe(true);
  });
});
