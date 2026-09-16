import { describe, expect, it } from "vitest";
import { flagValue, parseArgv } from "../../src/cli/parser.js";

/**
 * Two globals are also argument names of `release-pass`.
 *
 * It needs a `--version <v>` on every verb and a `--detail <hecho>` on two, and
 * both were registered as boolean globals. The value fell into the positionals
 * and the verb read `undefined`, answering with its usage — and `--version` went
 * further, tripping the global check in `main`, which printed the CLI's own
 * version and exited 0. The whole family was unreachable while the exit code
 * said success.
 */
describe("--version routing", () => {
  it("a command's --version is its own value, not the global flag", () => {
    const parsed = parseArgv(["release-pass", "declare", "--version", "25.6.0", "--sources", "a"]);

    expect(flagValue(parsed, "version")).toBe("25.6.0");
    // The global check in `main` keys off this: it must stay empty here.
    expect(parsed.flags.has("--version")).toBe(false);
    // And the value must not have leaked into the positionals.
    expect(parsed.rest).toEqual(["declare"]);
  });

  it("a bare --version is still the global flag", () => {
    const parsed = parseArgv(["--version"]);

    expect(parsed.flags.has("--version")).toBe(true);
    expect(parsed.command).toBeUndefined();
  });

  it("--version followed by another option is still the global flag", () => {
    const parsed = parseArgv(["--version", "--json"]);

    expect(parsed.flags.has("--version")).toBe(true);
    expect(parsed.values.has("version")).toBe(false);
  });

  it("release-pass --detail carries its fact; elsewhere --detail stays boolean", () => {
    const pass = parseArgv([
      "release-pass",
      "arrived",
      "--version",
      "25.6.0",
      "--source",
      "cli",
      "--kind",
      "published-version",
      "--detail",
      "publicado en npm",
    ]);

    expect(flagValue(pass, "detail")).toBe("publicado en npm");
    // The fact must not have been swallowed as a positional either.
    expect(pass.rest).toEqual(["arrived"]);

    // The same name on the command it was invented for: still a boolean, and
    // still not eating the token after it.
    const status = parseArgv(["status", "--detail"]);
    expect(status.flags.has("--detail")).toBe(true);
    expect(status.values.has("detail")).toBe(false);
  });
});
