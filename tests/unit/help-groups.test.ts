import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_COMMANDS } from "../../src/cli/commands/index.js";
import {
  commandHelpText,
  commandSummary,
  groupCommands,
  renderGroupedCommandLines,
} from "../../src/cli/help-groups.js";

describe("groupCommands", () => {
  it("groups known commands into their family with declared order", () => {
    const groups = groupCommands([
      "sessions",
      "session-create",
      "session-resume",
      "session-close",
      "session-artifacts",
      "self",
    ]);
    const sessionGroup = groups.find((g) => g.name === "Session lifecycle");
    expect(sessionGroup?.commands).toEqual([
      "sessions",
      "session-create",
      "session-resume",
      "session-close",
      "session-artifacts",
    ]);
    expect(groups.find((g) => g.name === "Self")?.commands).toEqual(["self"]);
  });

  it("omits empty groups when none of their commands are present", () => {
    const groups = groupCommands(["self"]);
    expect(groups.map((g) => g.name)).toEqual(["Self"]);
  });

  it("emits an 'Other' group for commands not declared in any group", () => {
    const groups = groupCommands(["self", "totally-new-command", "another-orphan"]);
    const other = groups.find((g) => g.name === "Other");
    expect(other?.commands).toEqual(["totally-new-command", "another-orphan"]);
  });

  it("does not duplicate commands between groups", () => {
    const allCommands = ["sessions", "session-create", "self", "plugin-doctor", "code-scan"];
    const groups = groupCommands(allCommands);
    const flat = groups.flatMap((g) => g.commands);
    const set = new Set(flat);
    expect(flat.length).toBe(set.size);
  });

  it("places git-flow in the Sources / Branches group", () => {
    const groups = groupCommands(["git-flow", "set-qa-branch", "self"]);
    const sources = groups.find((g) => g.name === "Sources / Branches");
    expect(sources?.commands).toContain("git-flow");
    // Not leaked into the catch-all Other group.
    expect(groups.find((g) => g.name === "Other")).toBeUndefined();
  });

  it("preserves the input order of commands within their group", () => {
    const groups = groupCommands(["session-create", "sessions", "session-close"]);
    expect(groups.find((g) => g.name === "Session lifecycle")?.commands).toEqual([
      "sessions",
      "session-create",
      "session-close",
    ]);
  });
});

describe("renderGroupedCommandLines", () => {
  it("emits a header for each group with two-space indented commands", () => {
    const lines = renderGroupedCommandLines(["self", "hook"]);
    expect(lines).toContain("Self:");
    expect(lines).toContain("Hooks:");
    expect(lines).toContain("  self");
    expect(lines).toContain("  hook");
  });

  it("inserts a blank line between groups but not after the last one", () => {
    const lines = renderGroupedCommandLines(["self", "hook"]);
    const blanks = lines.filter((l) => l === "");
    expect(blanks.length).toBe(1);
    expect(lines[lines.length - 1]).not.toBe("");
  });

  it("handles a single group cleanly", () => {
    const lines = renderGroupedCommandLines(["self"]);
    expect(lines).toEqual(["Self:", "  self"]);
  });
});

describe("guard: every registered command has a real group (no 'Other')", () => {
  it("groups all commands from the canonical registry with none left in Other", () => {
    const groups = groupCommands(ALL_COMMANDS.map((c) => c.name));
    const other = groups.find((g) => g.name === "Other");
    expect(other, `these commands fell into Other: ${other?.commands.join(", ")}`).toBeUndefined();
  });

  it("commands/index.ts lists exactly what main.ts registers (drift guard)", () => {
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    const registered = new Set(
      [...read("../../src/cli/main.ts").matchAll(/registry\.register\((\w+)\)/g)].map((m) => m[1]),
    );
    const indexSrc = read("../../src/cli/commands/index.ts");
    const arrayBody = indexSrc.slice(indexSrc.indexOf("ALL_COMMANDS"));
    const listed = new Set([...arrayBody.matchAll(/^ {2}(\w+Command),$/gm)].map((m) => m[1]));
    expect(listed).toEqual(registered);
  });
});

describe("commandSummary (global help one-liner)", () => {
  it("takes the first sentence and drops the appended Usage clause", () => {
    expect(commandSummary("Do a thing. Usage: aw x [--flag].")).toBe("Do a thing.");
  });

  it("cuts at a real sentence boundary (period + space + capital)", () => {
    expect(commandSummary("First sentence. Second one here.")).toBe("First sentence.");
  });

  it("does not truncate at an ellipsis or a non-boundary period", () => {
    expect(commandSummary("Scan files (localhost, secrets, ...). Usage: aw code-scan.")).toBe(
      "Scan files (localhost, secrets, ...).",
    );
  });

  it("elides overly long summaries with an ellipsis", () => {
    const out = commandSummary(`${"palabra ".repeat(20)}fin.`);
    expect(out.length).toBeLessThanOrEqual(72);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("renderGroupedCommandLines with describes", () => {
  it("renders `name  <first sentence>` aligned when a describe map is given", () => {
    const describes = new Map([
      ["self", "Self-management umbrella. Usage: aw self <sub>."],
      ["hook", "Run a workflow hook."],
    ]);
    const lines = renderGroupedCommandLines(["self", "hook"], describes);
    expect(lines.some((l) => /self\s+Self-management umbrella\./.test(l))).toBe(true);
    expect(lines.some((l) => /hook\s+Run a workflow hook\./.test(l))).toBe(true);
    // The Usage clause is NOT spilled into the global list.
    expect(lines.every((l) => !l.includes("Usage:"))).toBe(true);
  });

  it("falls back to name-only for commands missing from the describe map", () => {
    const lines = renderGroupedCommandLines(["self"], new Map());
    expect(lines).toEqual(["Self:", "  self"]);
  });
});

describe("commandHelpText", () => {
  it("renders the command name and its describe (per-subcommand help, not the global list)", () => {
    const out = commandHelpText({
      name: "workspace-init",
      describe: "Inicializa un workspace. Flags: --proyecto, --source, --working-branch.",
    });
    expect(out).toContain("agent-workflow workspace-init");
    expect(out).toContain("Flags: --proyecto, --source, --working-branch.");
    // Must NOT spill the global command list (the bug it replaces).
    expect(out).not.toContain("Session lifecycle:");
  });

  it("falls back to a placeholder when describe is missing", () => {
    const out = commandHelpText({ name: "foo" });
    expect(out).toContain("agent-workflow foo");
    expect(out).toContain("(sin descripción)");
  });
});
