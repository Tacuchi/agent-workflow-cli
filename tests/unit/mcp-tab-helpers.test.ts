import { describe, expect, it } from "vitest";
import {
  installActionLabel,
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
  it("maps the workspace install status to a labelled pill", () => {
    expect(installStatusPill("si")).toEqual({ label: "installed", tone: "ok" });
    expect(installStatusPill("drift")).toEqual({ label: "drift", tone: "warn" });
    expect(installStatusPill("no")).toEqual({ label: "registered", tone: "dim" });
  });
});

describe("installActionLabel", () => {
  it("adapts the install action label to the current status", () => {
    expect(installActionLabel("no")).toBe("Install to workspace");
    expect(installActionLabel("drift")).toBe("Update .mcp.json");
    expect(installActionLabel("si")).toBe("Reinstall to workspace");
  });
});
