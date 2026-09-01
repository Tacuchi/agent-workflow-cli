import { describe, expect, it } from "vitest";
import {
  aggregateMcpRuntimeStates,
  installActionLabel,
  installDestination,
  installStatusPill,
  mcpRuntimeAggregatePill,
  mcpRuntimeStateSummary,
  suggestDsnVar,
} from "../../src/cli/tui/tabs/mcp-tab-helpers.js";

describe("suggestDsnVar", () => {
  it("builds DB_<ALIAS>_DSN from a kebab alias", () => {
    expect(suggestDsnVar("alpha")).toBe("DB_ALPHA_DSN");
    expect(suggestDsnVar("beta")).toBe("DB_BETA_DSN");
    expect(suggestDsnVar("my-db")).toBe("DB_MY_DB_DSN");
  });

  it("normalizes spaces, dashes and casing", () => {
    expect(suggestDsnVar("  Reporting  ")).toBe("DB_REPORTING_DSN");
    expect(suggestDsnVar("read replica")).toBe("DB_READ_REPLICA_DSN");
  });

  it("returns empty string for an empty alias (no suggestion)", () => {
    expect(suggestDsnVar("")).toBe("");
    expect(suggestDsnVar("   ")).toBe("");
  });
});

describe("installStatusPill", () => {
  it("maps the user-scope install status to a labelled pill", () => {
    expect(installStatusPill("si")).toEqual({ label: "installed", tone: "ok" });
    expect(installStatusPill("drift")).toEqual({ label: "drift", tone: "warn" });
    expect(installStatusPill("no")).toEqual({ label: "registered", tone: "dim" });
  });
});

describe("aggregateMcpRuntimeStates", () => {
  it("prioriza un fallo de cualquier host y conserva su cobertura", () => {
    const states = ["configured", "failed", "registered"] as const;
    expect(aggregateMcpRuntimeStates(states)).toEqual({ state: "failed", count: 1, total: 3 });
    expect(mcpRuntimeAggregatePill(states)).toEqual({ label: "failed 1/3", tone: "err" });
    expect(mcpRuntimeStateSummary(states)).toBe("1 failed · 1 configured · 1 registered");
  });

  it("no atribuye el estado de una conexión a Codex: resume todos los hosts", () => {
    const states = ["registered", "host-load-observed", "registered"] as const;
    expect(mcpRuntimeAggregatePill(states)).toEqual({ label: "host loaded 1/3", tone: "ok" });
    expect(mcpRuntimeStateSummary(states)).toBe("1 host loaded · 2 registered");
  });
});

describe("installActionLabel", () => {
  it("adapts the install action label to the current user-scope status", () => {
    expect(installActionLabel("no")).toBe("Install → user scope");
    expect(installActionLabel("drift")).toBe("Resolve config conflict");
    expect(installActionLabel("si")).toBe("Reinstall → user scope");
  });
});

describe("installDestination", () => {
  it("resolves the host's global config path from the harness registry", () => {
    // Same on every platform for claude; keeps TUI labels in sync with the writer.
    expect(installDestination("claude")).toBe("~/.claude.json");
    expect(installDestination("codex")).toBe("~/.codex/config.toml");
  });
});
