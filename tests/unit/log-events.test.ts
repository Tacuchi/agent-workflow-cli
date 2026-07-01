import { describe, expect, it } from "vitest";
import {
  formatCommandError,
  formatCommandInvocation,
  formatCommandOutcome,
} from "../../src/application/logging/log-events.js";
import type { ParsedArgs } from "../../src/cli/parser.js";

function parsed(over: Partial<ParsedArgs>): ParsedArgs {
  return {
    rest: [],
    plugin: {},
    flags: new Set(),
    values: new Map(),
    valuesMulti: new Map(),
    ...over,
  };
}

describe("log-events", () => {
  it("renders a plain command", () => {
    expect(formatCommandInvocation(parsed({ command: "status" }))).toBe("status");
  });

  it("renders command + rest + flags + values", () => {
    const p = parsed({
      command: "mcp",
      rest: ["add"],
      flags: new Set(["dry-run"]),
      values: new Map([["name", "db"]]),
    });
    expect(formatCommandInvocation(p)).toBe("mcp add --dry-run --name=db");
  });

  it("outcome carries the command and exit code", () => {
    expect(formatCommandOutcome("status", 0)).toBe("status → exit 0");
    expect(formatCommandOutcome("git-flow", 1)).toBe("git-flow → exit 1");
  });

  it("error carries the command and message", () => {
    expect(formatCommandError("status", new Error("boom"))).toBe("status → error: boom");
  });
});
