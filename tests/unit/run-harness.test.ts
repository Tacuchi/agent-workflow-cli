import { describe, expect, it } from "vitest";
import { runHarness } from "../../src/application/dev-only-services.js";

function env(vars: Record<string, string>): (k: string) => string | undefined {
  return (k) => vars[k];
}

const KNOWN = ["claude-code", "codex", "oz", "warp", "unknown"];

describe("runHarness — detección data-driven desde HARNESSES registry", () => {
  it.each([
    ["CLAUDECODE", "claude-code", "env:CLAUDECODE"],
    ["CLAUDE_PLUGIN_ROOT", "claude-code", "env:CLAUDE_PLUGIN_ROOT"],
    ["CLAUDE_AGENT_ID", "claude-code", "env:CLAUDE_AGENT_ID"],
    ["CODEX_THREAD_ID", "codex", "env:CODEX_THREAD_ID"],
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
    const result = runHarness(env({ SOME_OTHER_VAR: "1" }));
    expect(result.harness).toBe("unknown");
    expect(result.agent_host).toBe("unknown");
    expect(result.terminal_host).toBe("unknown");
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

  it("expone el despacho nativo del host, no una excepción para Claude", () => {
    expect(runHarness(env({ CLAUDECODE: "1" })).supports_plan_subagent).toBe(true);
    expect(runHarness(env({ CODEX_HOME: "1" })).supports_plan_subagent).toBe(true);
    expect(runHarness(env({ OZ_RUN_ID: "1" })).supports_plan_subagent).toBe(false);
    expect(runHarness(env({ TERM_PROGRAM: "WarpTerminal" })).supports_plan_subagent).toBe(false);
  });

  it("la identidad enlazada gana al terminal y ambos quedan visibles", () => {
    const result = runHarness(
      env({ WARP_IS_LOCAL_SHELL_SESSION: "1", TERM_PROGRAM: "WarpTerminal" }),
      "codex",
    );
    expect(result.harness).toBe("codex");
    expect(result.agent_host).toBe("codex");
    expect(result.terminal_host).toBe("warp");
    expect(result.detected_via).toBe("binding:codex");
    expect(result.resource_policy.deterministic).toMatchObject({
      strategy: "none",
      model_workers: 0,
      max_subagents: 0,
    });
    expect(result.resource_policy.semantic_default).toMatchObject({
      strategy: "inline",
      model_workers: 1,
      max_subagents: 0,
    });
  });

  it("un marcador de agente gana a Warp sin requerir binding", () => {
    const result = runHarness(env({ CODEX_THREAD_ID: "thread", WARP_IS_LOCAL_SHELL_SESSION: "1" }));
    expect(result.agent_host).toBe("codex");
    expect(result.terminal_host).toBe("warp");
  });

  it("known_harnesses siempre incluye todos los harnesses + unknown", () => {
    const result = runHarness(env({}));
    for (const id of KNOWN) {
      expect(result.known_harnesses).toContain(id);
    }
  });
});
