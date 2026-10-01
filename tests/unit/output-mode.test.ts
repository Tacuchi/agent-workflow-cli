import { describe, expect, it } from "vitest";
import { type OutputModeResolution, resolveOutputMode } from "../../src/cli/output-mode.js";
import { parseArgv } from "../../src/cli/parser.js";

const TTY = true;
const PIPE = false;

function resolve(argv: string[], isTTY: boolean): OutputModeResolution {
  return resolveOutputMode(parseArgv(argv), isTTY);
}

function mode(argv: string[], isTTY: boolean) {
  const resolution = resolve(argv, isTTY);
  if (!resolution.ok) throw new Error(`expected a resolved mode, got: ${resolution.message}`);
  return resolution.mode;
}

function failure(argv: string[], isTTY: boolean): string {
  const resolution = resolve(argv, isTTY);
  if (resolution.ok) throw new Error("expected the resolution to fail");
  return resolution.message;
}

describe("resolveOutputMode — default without any override", () => {
  // The compatibility guarantee: every installed wrapper, hook and script runs
  // through a pipe. If this flipped to human, all of them would break at once.
  it("keeps JSON in a pipe", () => {
    expect(mode(["status"], PIPE)).toEqual({ format: "json", detail: false, ascii: false });
  });

  it("reads human in a terminal", () => {
    expect(mode(["status"], TTY)).toEqual({ format: "human", detail: false, ascii: false });
  });
});

describe("resolveOutputMode — explicit declaration beats the TTY", () => {
  it("--json forces JSON inside a terminal", () => {
    expect(mode(["status", "--json"], TTY).format).toBe("json");
  });

  it("--format human forces human through a pipe", () => {
    expect(mode(["status", "--format", "human"], PIPE).format).toBe("human");
  });

  it("--format json forces JSON inside a terminal", () => {
    expect(mode(["status", "--format", "json"], TTY).format).toBe("json");
  });

  it("--format=json is the same declaration as --format json", () => {
    expect(mode(["status", "--format=json"], TTY).format).toBe("json");
  });

  it("accepts --json alongside a matching --format json", () => {
    expect(mode(["status", "--json", "--format", "json"], TTY).format).toBe("json");
  });
});

describe("resolveOutputMode — contradictions fail instead of picking a winner", () => {
  it("rejects --json together with --format human", () => {
    expect(failure(["status", "--json", "--format", "human"], TTY)).toContain("contradice");
  });

  it("rejects an unknown format value", () => {
    expect(failure(["status", "--format", "yaml"], TTY)).toContain("human o json");
  });

  it("rejects --format with no value at all", () => {
    expect(failure(["status", "--format"], TTY)).toContain("requiere un valor");
  });
});

describe("resolveOutputMode — --detail belongs to the human projection", () => {
  // A command that narrows its default JSON keeps the full model for --detail.
  it("carries --detail through an explicit --json", () => {
    expect(mode(["status", "--detail", "--json"], TTY)).toEqual({
      format: "json",
      detail: true,
      ascii: false,
    });
  });

  it("carries --detail through an explicit --format json", () => {
    expect(mode(["status", "--detail", "--format", "json"], PIPE)).toEqual({
      format: "json",
      detail: true,
      ascii: false,
    });
  });

  // Asking for the wide view IS asking for the human projection; erroring here
  // would make `aw status --detail | less` unusable for no gain.
  it("selects human when --detail arrives with no declared format, even in a pipe", () => {
    expect(mode(["status", "--detail"], PIPE)).toEqual({
      format: "human",
      detail: true,
      ascii: false,
    });
  });

  it("carries detail through an explicit --format human", () => {
    expect(mode(["status", "--detail", "--format", "human"], PIPE).detail).toBe(true);
  });

  it("leaves detail off when it was never requested", () => {
    expect(mode(["status", "--format", "human"], PIPE).detail).toBe(false);
  });
});

// Regression guard for the parser's manual BOOLEAN_FLAGS inventory: a boolean
// flag missing from that list consumes the next token as its value, so the
// command silently loses its positional argument.
describe("output flags never swallow the following positional", () => {
  it("keeps the positional after --json", () => {
    const parsed = parseArgv(["session-artifacts", "--json", "049"]);
    expect(parsed.rest).toContain("049");
    expect(parsed.flags.has("--json")).toBe(true);
    expect(parsed.values.get("json")).toBeUndefined();
  });

  it("keeps the positional after --detail", () => {
    const parsed = parseArgv(["resume", "--detail", "009"]);
    expect(parsed.rest).toContain("009");
    expect(parsed.flags.has("--detail")).toBe(true);
    expect(parsed.values.get("detail")).toBeUndefined();
  });

  it("still lets --format consume its value", () => {
    const parsed = parseArgv(["status", "--format", "human"]);
    expect(parsed.values.get("format")).toBe("human");
    expect(parsed.rest).not.toContain("human");
  });
});

describe("resolveOutputMode — the ASCII mark", () => {
  it("--ascii marks the human projection and never picks the format", () => {
    expect(mode(["status", "--ascii"], TTY)).toEqual({
      format: "human",
      detail: false,
      ascii: true,
    });
    expect(mode(["status", "--ascii"], PIPE).format).toBe("json");
  });

  it("refuses --ascii with an explicit JSON declaration, like --detail", () => {
    expect(failure(["status", "--ascii", "--json"], TTY)).toContain("--ascii");
    expect(failure(["status", "--ascii", "--format", "json"], PIPE)).toContain("--ascii");
  });

  it("AW_ASCII=1 is never refused, not even with an explicit --json", () => {
    expect(resolveOutputMode(parseArgv(["status", "--json"]), TTY, "1")).toMatchObject({
      ok: true,
      mode: { format: "json" },
    });
  });

  it("AW_ASCII=1 sets the mark; any other value does not", () => {
    expect(resolveOutputMode(parseArgv(["status"]), TTY, "1")).toMatchObject({
      mode: { ascii: true },
    });
    expect(resolveOutputMode(parseArgv(["status"]), TTY, "0")).toMatchObject({
      mode: { ascii: false },
    });
  });
});
