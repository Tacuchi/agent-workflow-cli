import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitError,
  formatArgvError,
  formatUnknownCommand,
  renderError,
} from "../../src/cli/render.js";

describe("error envelope — formatArgvError", () => {
  it("returns ARGS_INVALID code with the raw error message", () => {
    const env = formatArgvError("--flow requires one of core|dev|design|analyze (got 'bogus')");
    expect(env.code).toBe("ARGS_INVALID");
    expect(env.message).toContain("bogus");
    expect(env.details).toBeUndefined();
  });
});

describe("error envelope — formatUnknownCommand", () => {
  it("returns UNKNOWN_COMMAND with details.command + help_hint + available_commands", () => {
    const env = formatUnknownCommand("nope", ["sessions", "session-create", "self"]);
    expect(env.code).toBe("UNKNOWN_COMMAND");
    expect(env.message).toBe("Unknown command: nope");
    expect(env.details).toBeDefined();
    expect(env.details?.command).toBe("nope");
    expect(env.details?.help_hint).toContain("--help");
    expect(env.details?.available_commands).toEqual(["sessions", "session-create", "self"]);
  });

  it("preserves the input command list verbatim (no copy/sort)", () => {
    const cmds = ["zeta", "alpha", "beta"];
    const env = formatUnknownCommand("foo", cmds);
    expect(env.details?.available_commands).toEqual(cmds);
  });
});

describe("error envelope — renderError", () => {
  it("emits a parseable JSON envelope with ok=false", () => {
    const out = renderError({ code: "X", message: "y" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("X");
    expect(parsed.error.message).toBe("y");
  });

  it("preserves details when provided", () => {
    const out = renderError({
      code: "UNKNOWN_COMMAND",
      message: "Unknown command: foo",
      details: { command: "foo", available_commands: ["a", "b"] },
    });
    const parsed = JSON.parse(out);
    expect(parsed.error.details.command).toBe("foo");
    expect(parsed.error.details.available_commands).toEqual(["a", "b"]);
  });

  it("ends with a trailing newline (so it composes well with TTY output)", () => {
    const out = renderError({ code: "X", message: "y" });
    expect(out.endsWith("\n")).toBe(true);
  });

  it("does NOT include `ok: true` accidentally", () => {
    const out = renderError({ code: "X", message: "y" });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(Object.keys(parsed)).toEqual(["ok", "error"]);
  });
});

describe("error envelope — emitError writes to stdout (not stderr)", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("calls process.stdout.write with the JSON envelope", () => {
    emitError({ code: "FOO", message: "bar" });
    expect(stdoutSpy).toHaveBeenCalledTimes(1);
    const written = stdoutSpy.mock.calls[0]?.[0];
    expect(typeof written).toBe("string");
    const parsed = JSON.parse(written as string);
    expect(parsed).toEqual({ ok: false, error: { code: "FOO", message: "bar" } });
  });

  it("does NOT call process.stderr.write (post-G3 contract)", () => {
    emitError({ code: "FOO", message: "bar" });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe("error envelope — round-trip integration (formatXxx → emitError → JSON.parse)", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("ARGS_INVALID round-trip", () => {
    emitError(formatArgvError("--flow requires one of core|dev|design|analyze (got 'X')"));
    const written = stdoutSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(written);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("ARGS_INVALID");
    expect(parsed.error.message).toContain("--flow");
  });

  it("UNKNOWN_COMMAND round-trip preserves available_commands list", () => {
    emitError(formatUnknownCommand("typo", ["sessions", "self"]));
    const written = stdoutSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(written);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("UNKNOWN_COMMAND");
    expect(parsed.error.details.available_commands).toEqual(["sessions", "self"]);
  });
});
