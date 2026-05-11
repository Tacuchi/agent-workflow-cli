import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpEntry } from "../../src/application/mcp-host-reader.js";

describe("readMcpEntry — Claude (project scope = .mcp.json)", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-reader-claude-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("retorna exists=false si .mcp.json no existe", () => {
    const snap = readMcpEntry("claude", scopeDir, "cert");
    expect(snap.exists).toBe(false);
    expect(snap.target).toBe(join(scopeDir, ".mcp.json"));
  });

  it("retorna exists=false si la entrada no está", () => {
    writeFileSync(
      join(scopeDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x", args: [], env: {} } } }),
    );
    const snap = readMcpEntry("claude", scopeDir, "cert");
    expect(snap.exists).toBe(false);
  });

  it("extrae command/args/env si la entrada existe", () => {
    writeFileSync(
      join(scopeDir, ".mcp.json"),
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
    writeFileSync(join(scopeDir, ".mcp.json"), "{ not valid json");
    const snap = readMcpEntry("claude", scopeDir, "cert");
    expect(snap.exists).toBe(false);
  });

  it("ignora .claude/settings.json legacy (project scope no lo lee)", () => {
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(scopeDir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: { cert: { command: "agent-workflow", args: [], env: {} } },
      }),
    );
    const snap = readMcpEntry("claude", scopeDir, "cert");
    expect(snap.exists).toBe(false);
  });
});

describe("readMcpEntry — Claude (global scope = ~/.claude.json)", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-reader-claude-global-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("lee de .claude.json cuando kind=global", () => {
    writeFileSync(
      join(scopeDir, ".claude.json"),
      JSON.stringify({
        numStartups: 1,
        mcpServers: {
          cert: {
            command: "agent-workflow",
            args: ["mcp", "dbhub", "cert"],
            env: { MAX_ROWS: "1000", READONLY: "true", TRANSPORT: "stdio" },
          },
        },
      }),
    );
    const snap = readMcpEntry("claude", scopeDir, "cert", "global");
    expect(snap.exists).toBe(true);
    expect(snap.target).toBe(join(scopeDir, ".claude.json"));
    expect(snap.command).toBe("agent-workflow");
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

describe("readMcpEntry — Warp (.warp/.mcp.json, DEC-W3)", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-reader-warp-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("retorna exists=false si .warp/.mcp.json no existe", () => {
    const snap = readMcpEntry("warp", scopeDir, "cert");
    expect(snap.exists).toBe(false);
    expect(snap.target).toBe(join(scopeDir, ".warp", ".mcp.json"));
  });

  it("extrae command/args/env desde .warp/.mcp.json", () => {
    mkdirSync(join(scopeDir, ".warp"), { recursive: true });
    writeFileSync(
      join(scopeDir, ".warp", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          cert: {
            command: "agent-workflow",
            args: ["mcp", "dbhub", "cert"],
            env: { MAX_ROWS: "500" },
          },
        },
      }),
    );
    const snap = readMcpEntry("warp", scopeDir, "cert");
    expect(snap.exists).toBe(true);
    expect(snap.host).toBe("warp");
    expect(snap.command).toBe("agent-workflow");
    expect(snap.args).toEqual(["mcp", "dbhub", "cert"]);
    expect(snap.env).toEqual({ MAX_ROWS: "500" });
  });

  it("retorna exists=false si la entrada no está en mcpServers", () => {
    mkdirSync(join(scopeDir, ".warp"), { recursive: true });
    writeFileSync(
      join(scopeDir, ".warp", ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );
    const snap = readMcpEntry("warp", scopeDir, "cert");
    expect(snap.exists).toBe(false);
  });
});
