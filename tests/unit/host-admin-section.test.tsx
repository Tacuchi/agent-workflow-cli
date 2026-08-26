import { describe, expect, it } from "vitest";
import { mcpPartialDetail } from "../../src/cli/tui/components/host-admin-section.js";

describe("HostAdminSection MCP partial detail", () => {
  it("keeps the foreign-entry conflict actionable after the file step completed", () => {
    expect(
      mcpPartialDetail({
        status: "partial",
        mcp_server: [{ host: "codex", state: "conflict" }],
      }),
    ).toBe("Files changed; MCP conflict on codex: the same-named foreign entry was preserved.");
  });

  it("includes host-specific writer failures and ignores ordinary non-partial results", () => {
    expect(
      mcpPartialDetail({
        status: "partial",
        mcp_server: [{ host: "codex", state: "failed", error: "config.toml inválido" }],
      }),
    ).toBe("Files changed; MCP write failed on codex (config.toml inválido).");
    expect(mcpPartialDetail({ status: "installed", mcp_server: [] })).toBeUndefined();
  });
});
