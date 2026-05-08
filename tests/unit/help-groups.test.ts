import { describe, expect, it } from "vitest";
import { groupCommands, renderGroupedCommandLines } from "../../src/cli/help-groups.js";

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
