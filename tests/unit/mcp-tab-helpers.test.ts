import { describe, expect, it } from "vitest";
import {
  installActionLabel,
  installDestination,
  installStatusPill,
  suggestDsnVar,
} from "../../src/cli/tui/tabs/mcp-tab-helpers.js";

describe("suggestDsnVar", () => {
  it("builds DB_<ALIAS>_DSN from a kebab alias", () => {
    expect(suggestDsnVar("cert")).toBe("DB_CERT_DSN");
    expect(suggestDsnVar("prod")).toBe("DB_PROD_DSN");
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

describe("installActionLabel", () => {
  it("adapts the install action label to the current user-scope status", () => {
    expect(installActionLabel("no")).toBe("Install → user scope");
    expect(installActionLabel("drift")).toBe("Update user config");
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
