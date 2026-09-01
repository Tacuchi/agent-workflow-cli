import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveMcpConnectionSelection,
  upsertMcpConnection,
} from "../../src/application/mcp-connections-service.js";
import { PathsService } from "../../src/application/paths-service.js";
import { parseArgv } from "../../src/cli/parser.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("MCP connection selection", () => {
  let root: string;
  let paths: PathsService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-connection-selection-"));
    paths = new PathsService(normalizeNamespace("workflow"), root, root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when the registry is empty", () => {
    const result = resolveMcpConnectionSelection(paths);
    expect(result).toMatchObject({ ok: false, code: "NO_MCP_CONNECTIONS" });
  });

  it("selects the sole registered connection without an instance flag", () => {
    upsertMcpConnection(paths, { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" });
    const result = resolveMcpConnectionSelection(paths);
    expect(result).toEqual({
      ok: true,
      connections: [{ name: "alpha", dsnVar: "ALPHA_DATABASE_URL", provider: "postgres" }],
    });
  });

  it("requires an explicit instance when multiple connections exist", () => {
    upsertMcpConnection(paths, { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" });
    upsertMcpConnection(paths, { name: "beta", dsnVar: "BETA_DATABASE_URL" });

    const ambiguous = resolveMcpConnectionSelection(paths);
    expect(ambiguous).toMatchObject({ ok: false, code: "MCP_INSTANCE_REQUIRED" });

    const selected = resolveMcpConnectionSelection(paths, { instance: "beta" });
    expect(selected).toEqual({
      ok: true,
      connections: [{ name: "beta", dsnVar: "BETA_DATABASE_URL", provider: "postgres" }],
    });
  });

  it("uses --all-connections only for an intentional fan-out", () => {
    upsertMcpConnection(paths, { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" });
    upsertMcpConnection(paths, { name: "beta", dsnVar: "BETA_DATABASE_URL" });
    const result = resolveMcpConnectionSelection(paths, { allConnections: true });
    expect(result).toEqual({
      ok: true,
      connections: [
        { name: "alpha", dsnVar: "ALPHA_DATABASE_URL", provider: "postgres" },
        { name: "beta", dsnVar: "BETA_DATABASE_URL", provider: "postgres" },
      ],
    });
  });

  it("rejects an unregistered name and mutually exclusive selectors", () => {
    upsertMcpConnection(paths, { name: "alpha", dsnVar: "ALPHA_DATABASE_URL" });
    expect(resolveMcpConnectionSelection(paths, { instance: "beta" })).toMatchObject({
      ok: false,
      code: "MCP_CONNECTION_NOT_REGISTERED",
    });
    expect(
      resolveMcpConnectionSelection(paths, { instance: "alpha", allConnections: true }),
    ).toMatchObject({ ok: false, code: "MCP_CONNECTION_SELECTION_CONFLICT" });
  });
});

describe("--all-connections parser routing", () => {
  it("keeps the selector as a boolean flag", () => {
    const args = parseArgv(["mcp", "setup", "--all-connections", "--host", "claude"]);
    expect(args.flags.has("--all-connections")).toBe(true);
    expect(args.values.get("host")).toBe("claude");
  });
});
