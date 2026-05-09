import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpEntry } from "../../src/application/mcp-host-reader.js";

describe("readMcpEntry — Claude", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-reader-claude-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("retorna exists=false si settings.json no existe", () => {
    const snap = readMcpEntry("claude", scopeDir, "cert");
    expect(snap.exists).toBe(false);
  });

  it("retorna exists=false si la entrada no está", () => {
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(scopeDir, ".claude", "settings.json"),
      JSON.stringify({ mcpServers: { other: { command: "x", args: [], env: {} } } }),
    );
    const snap = readMcpEntry("claude", scopeDir, "cert");
    expect(snap.exists).toBe(false);
  });

  it("extrae command/args/env si la entrada existe", () => {
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(scopeDir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          cert: {
            command: "agent-workflow",
            args: ["mcp", "dbhub", "cert"],
            env: { MAX_ROWS: "1000", READONLY: "true", TRANSPORT: "stdio" },
          },
        },
      }),
    );
    const snap = readMcpEntry("claude", scopeDir, "cert");
    expect(snap.exists).toBe(true);
    expect(snap.command).toBe("agent-workflow");
    expect(snap.args).toEqual(["mcp", "dbhub", "cert"]);
    expect(snap.env).toEqual({ MAX_ROWS: "1000", READONLY: "true", TRANSPORT: "stdio" });
  });

  it("retorna exists=false si JSON inválido", () => {
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(join(scopeDir, ".claude", "settings.json"), "{ not valid json");
    const snap = readMcpEntry("claude", scopeDir, "cert");
    expect(snap.exists).toBe(false);
  });
});

describe("readMcpEntry — Codex", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-reader-codex-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("extrae command/args/env desde TOML válido", () => {
    mkdirSync(join(scopeDir, ".codex"), { recursive: true });
    writeFileSync(
      join(scopeDir, ".codex", "config.toml"),
      `
[mcp_servers.prod]
command = "agent-workflow"
args = ["mcp", "dbhub", "prod"]

[mcp_servers.prod.env]
MAX_ROWS = "1000"
READONLY = "true"
TRANSPORT = "stdio"
`,
    );
    const snap = readMcpEntry("codex", scopeDir, "prod");
    expect(snap.exists).toBe(true);
    expect(snap.command).toBe("agent-workflow");
    expect(snap.args).toEqual(["mcp", "dbhub", "prod"]);
    expect(snap.env).toEqual({ MAX_ROWS: "1000", READONLY: "true", TRANSPORT: "stdio" });
  });

  it("retorna exists=false si TOML inválido", () => {
    mkdirSync(join(scopeDir, ".codex"), { recursive: true });
    writeFileSync(join(scopeDir, ".codex", "config.toml"), "[invalid =");
    const snap = readMcpEntry("codex", scopeDir, "cert");
    expect(snap.exists).toBe(false);
  });
});
