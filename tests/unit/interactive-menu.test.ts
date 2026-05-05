import { describe, expect, it } from "vitest";
import { shouldShowInteractiveMenu } from "../../src/cli/interactive-menu.js";

describe("shouldShowInteractiveMenu", () => {
  it("true when no command + TTY + no help flag", () => {
    expect(shouldShowInteractiveMenu({ command: undefined, isTTY: true, hasHelp: false })).toBe(
      true,
    );
  });
  it("false when command provided", () => {
    expect(shouldShowInteractiveMenu({ command: "sessions", isTTY: true, hasHelp: false })).toBe(
      false,
    );
  });
  it("false when --help flag", () => {
    expect(shouldShowInteractiveMenu({ command: undefined, isTTY: true, hasHelp: true })).toBe(
      false,
    );
  });
  it("false when not TTY", () => {
    expect(shouldShowInteractiveMenu({ command: undefined, isTTY: false, hasHelp: false })).toBe(
      false,
    );
  });
});
