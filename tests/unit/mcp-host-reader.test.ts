import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyMcpEntry } from "../../src/application/mcp-entry-classification.js";
import { readMcpEntry } from "../../src/application/mcp-host-reader.js";
import { writeMcpEntry } from "../../src/application/mcp-host-writer.js";
import {
  type McpHost,
  buildMcpEntry,
  knownLegacyMcpEntries,
  mcpEntryShapeForHost,
} from "../../src/domain/mcp-entry.js";

const TEST_NODE = "/opt/workline/node";
const TEST_ENTRYPOINT = "/opt/workline/dist/cli/main.js";

function entryCommand(scope: "workspace" | "global" = "workspace") {
  return scope === "global" ? TEST_NODE : "agent-workflow";
}

function entryArgs(host: McpHost, instance: string, scope: "workspace" | "global" = "workspace") {
  const serveArgs = [
    "mcp",
    "serve-db",
    "--namespace",
    "workflow",
    "--instance",
    instance,
    "--host",
    host,
    "--scope",
    scope,
    ...(scope === "global" ? ["--descriptor-generation", "23.0.0"] : []),
  ];
  return scope === "global" ? [TEST_ENTRYPOINT, ...serveArgs] : serveArgs;
}

function testEntry(host: McpHost, scope: "workspace" | "global" = "workspace") {
  return buildMcpEntry("alpha", "ALPHA_DATABASE_URL", {
    nodePath: TEST_NODE,
    entrypoint: TEST_ENTRYPOINT,
    host,
    scope,
    platform: "linux",
    descriptorGeneration: "23.0.0",
  });
}

describe("readMcpEntry — Claude (project scope = .mcp.json)", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-reader-claude-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("retorna exists=false si .mcp.json no existe", () => {
    const snap = readMcpEntry("claude", scopeDir, "alpha");
    expect(snap.exists).toBe(false);
    expect(snap.target).toBe(join(scopeDir, ".mcp.json"));
  });

  it("retorna exists=false si la entrada no está", () => {
    writeFileSync(
      join(scopeDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x", args: [], env: {} } } }),
    );
    const snap = readMcpEntry("claude", scopeDir, "alpha");
    expect(snap.exists).toBe(false);
  });

  it("extrae command/args/env si la entrada existe", () => {
    writeFileSync(
      join(scopeDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          alpha: {
            command: entryCommand(),
            args: entryArgs("claude", "alpha"),
            env: {},
          },
        },
      }),
    );
    const snap = readMcpEntry("claude", scopeDir, "alpha");
    expect(snap.exists).toBe(true);
    expect(snap.command).toBe("agent-workflow");
    expect(snap.args).toEqual(entryArgs("claude", "alpha"));
    expect(snap.env).toEqual({});
  });

  it("marca present=true y exists=false si JSON inválido", () => {
    writeFileSync(join(scopeDir, ".mcp.json"), "{ not valid json");
    const snap = readMcpEntry("claude", scopeDir, "alpha");
    expect(snap.exists).toBe(false);
    expect(snap.present).toBe(true);
  });

  it("clasifica campos de descriptor con tipos inválidos como malformed", () => {
    writeFileSync(
      join(scopeDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          alpha: {
            command: "agent-workflow",
            args: ["mcp", 7],
            env: { ALPHA_DATABASE_URL: 4 },
          },
        },
      }),
    );

    const snapshot = readMcpEntry("claude", scopeDir, "alpha");
    const classified = classifyMcpEntry("claude", snapshot, testEntry("claude"), {
      name: "alpha",
      dsnVar: "ALPHA_DATABASE_URL",
    });

    expect(snapshot.malformed).toBe(true);
    expect(classified.state).toBe("malformed");
  });

  it("expone .claude/settings.json histórico para que migración lo clasifique", () => {
    const legacy = knownLegacyMcpEntries("alpha", "ALPHA_DATABASE_URL")[0];
    if (legacy === undefined) throw new Error("expected published legacy descriptor");
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(scopeDir, ".claude", "settings.json"),
      JSON.stringify({
        mcpServers: {
          alpha: mcpEntryShapeForHost("claude", legacy),
        },
      }),
    );
    const snap = readMcpEntry("claude", scopeDir, "alpha");
    expect(snap.exists).toBe(true);
    expect(snap.target).toBe(join(scopeDir, ".claude", "settings.json"));
    expect(
      classifyMcpEntry("claude", snap, testEntry("claude"), {
        name: "alpha",
        dsnVar: "ALPHA_DATABASE_URL",
      }).state,
    ).toBe("known-legacy");
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
          alpha: {
            command: entryCommand("global"),
            args: entryArgs("claude", "alpha", "global"),
            env: {},
          },
        },
      }),
    );
    const snap = readMcpEntry("claude", scopeDir, "alpha", "global");
    expect(snap.exists).toBe(true);
    expect(snap.target).toBe(join(scopeDir, ".claude.json"));
    expect(snap.command).toBe(TEST_NODE);
    expect(snap.args).toEqual(entryArgs("claude", "alpha", "global"));
  });

  it("no toma una generación de release no publicada como propia", () => {
    const current = testEntry("claude", "global");
    const prior = buildMcpEntry("alpha", "ALPHA_DATABASE_URL", {
      nodePath: TEST_NODE,
      entrypoint: TEST_ENTRYPOINT,
      host: "claude",
      scope: "global",
      platform: "linux",
      descriptorGeneration: "22.9.0",
    });
    writeFileSync(
      join(scopeDir, ".claude.json"),
      JSON.stringify({ mcpServers: { alpha: mcpEntryShapeForHost("claude", prior) } }),
    );

    const snapshot = readMcpEntry("claude", scopeDir, "alpha", "global");
    const classified = classifyMcpEntry("claude", snapshot, current, {
      name: "alpha",
      dsnVar: "ALPHA_DATABASE_URL",
    });

    expect(classified.state).toBe("foreign");
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
[mcp_servers.beta]
command = "agent-workflow"
args = ["mcp", "serve-db", "--namespace", "workflow", "--instance", "beta", "--host", "codex", "--scope", "workspace"]
required = false

[mcp_servers.beta.env]
`,
    );
    const snap = readMcpEntry("codex", scopeDir, "beta");
    expect(snap.exists).toBe(true);
    expect(snap.command).toBe("agent-workflow");
    expect(snap.args).toEqual(entryArgs("codex", "beta"));
    expect(snap.env).toEqual({});
  });

  it("marca present=true y exists=false si TOML inválido", () => {
    mkdirSync(join(scopeDir, ".codex"), { recursive: true });
    writeFileSync(join(scopeDir, ".codex", "config.toml"), "[invalid =");
    const snap = readMcpEntry("codex", scopeDir, "alpha");
    expect(snap.exists).toBe(false);
    expect(snap.present).toBe(true);
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
    const snap = readMcpEntry("warp", scopeDir, "alpha");
    expect(snap.exists).toBe(false);
    expect(snap.target).toBe(join(scopeDir, ".warp", ".mcp.json"));
  });

  it("extrae command/args/env desde .warp/.mcp.json", () => {
    mkdirSync(join(scopeDir, ".warp"), { recursive: true });
    writeFileSync(
      join(scopeDir, ".warp", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          alpha: {
            command: entryCommand(),
            args: entryArgs("warp", "alpha"),
            env: {},
          },
        },
      }),
    );
    const snap = readMcpEntry("warp", scopeDir, "alpha");
    expect(snap.exists).toBe(true);
    expect(snap.host).toBe("warp");
    expect(snap.command).toBe("agent-workflow");
    expect(snap.args).toEqual(entryArgs("warp", "alpha"));
    expect(snap.env).toEqual({});
  });

  it("retorna exists=false si la entrada no está en mcpServers", () => {
    mkdirSync(join(scopeDir, ".warp"), { recursive: true });
    writeFileSync(
      join(scopeDir, ".warp", ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );
    const snap = readMcpEntry("warp", scopeDir, "alpha");
    expect(snap.exists).toBe(false);
  });
});

// The reader must be able to READ what the writer WRITES, for every host. OpenCode
// and Crush store the entry under the top-level `mcp` key with their own shapes
// (opencode: command as array + `environment`; crush: type=stdio) — not under
// `mcpServers`. Without this real round-trip, the reader kept reading `mcpServers`
// and reported exists=false for opencode/crush even after a correct install.
describe("readMcpEntry — round-trip real vs writeMcpEntry (todos los hosts JSON)", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-reader-roundtrip-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  for (const host of ["gemini", "opencode", "crush", "kimi"] as const) {
    it(`${host}: lo escrito por writeMcpEntry se lee de vuelta idéntico`, () => {
      const entry = testEntry(host);
      const written = writeMcpEntry(host, entry, { scopeDir });
      expect(written.action).toBe("written");

      const snap = readMcpEntry(host, scopeDir, "alpha");
      expect(snap.exists).toBe(true);
      expect(snap.command).toBe(entry.command);
      expect(snap.args).toEqual(entry.args);
      expect(snap.env).toEqual(entry.env);
    });
  }
});
