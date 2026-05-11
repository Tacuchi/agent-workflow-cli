import { describe, expect, it } from "vitest";
import { runHarness } from "../../src/application/dev-only-services.js";

function env(vars: Record<string, string>): (k: string) => string | undefined {
  return (k) => vars[k];
}

// Prevent filesystem fallback from hitting real ~/.codex in tests
const noHomedir = () => "/nonexistent/test-home";

const KNOWN = ["claude-code", "codex", "oz", "warp", "unknown"];

describe("runHarness — detección data-driven desde HARNESSES registry", () => {
  it.each([
    ["CLAUDECODE", "claude-code", "env:CLAUDECODE"],
    ["CLAUDE_PLUGIN_ROOT", "claude-code", "env:CLAUDE_PLUGIN_ROOT"],
    ["CLAUDE_AGENT_ID", "claude-code", "env:CLAUDE_AGENT_ID"],
    ["CODEX_HOME", "codex", "env:CODEX_HOME"],
    ["CODEX_CLI", "codex", "env:CODEX_CLI"],
    ["CODEX_RUNTIME", "codex", "env:CODEX_RUNTIME"],
    ["OZ_RUN_ID", "oz", "env:OZ_RUN_ID"],
    ["WARP_IS_LOCAL_SHELL_SESSION", "warp", "env:WARP_IS_LOCAL_SHELL_SESSION"],
  ])("env var %s → harness '%s'", (envVar, expectedHarness, expectedVia) => {
    const result = runHarness(env({ [envVar]: "1" }));
    expect(result.harness).toBe(expectedHarness);
    expect(result.detected_via).toBe(expectedVia);
    expect(result.known_harnesses).toEqual(expect.arrayContaining(KNOWN));
  });

  it("TERM_PROGRAM=WarpTerminal → warp", () => {
    const result = runHarness(env({ TERM_PROGRAM: "WarpTerminal" }));
    expect(result.harness).toBe("warp");
    expect(result.detected_via).toBe("env:TERM_PROGRAM=WarpTerminal");
  });

  it("sin env vars conocidas → unknown", () => {
    const result = runHarness(env({ SOME_OTHER_VAR: "1" }), noHomedir);
    expect(result.harness).toBe("unknown");
    expect(result.supports_plan_subagent).toBe(false);
  });

  it("oz tiene prioridad sobre warp cuando ambos env vars están presentes (DEC-W5)", () => {
    const result = runHarness(
      env({ OZ_RUN_ID: "abc", TERM_PROGRAM: "WarpTerminal", WARP_IS_LOCAL_SHELL_SESSION: "1" }),
    );
    expect(result.harness).toBe("oz");
  });

  it("claude-code tiene prioridad sobre codex cuando ambos env vars están presentes", () => {
    const result = runHarness(env({ CLAUDECODE: "1", CODEX_HOME: "/home/.codex" }));
    expect(result.harness).toBe("claude-code");
  });

  it("claude-code → supports_plan_subagent=true; otros → false", () => {
    expect(runHarness(env({ CLAUDECODE: "1" })).supports_plan_subagent).toBe(true);
    expect(runHarness(env({ CODEX_HOME: "1" })).supports_plan_subagent).toBe(false);
    expect(runHarness(env({ OZ_RUN_ID: "1" })).supports_plan_subagent).toBe(false);
    expect(runHarness(env({ TERM_PROGRAM: "WarpTerminal" })).supports_plan_subagent).toBe(false);
  });

  it("known_harnesses siempre incluye todos los harnesses + unknown", () => {
    const result = runHarness(env({}));
    for (const id of KNOWN) {
      expect(result.known_harnesses).toContain(id);
    }
  });
});
