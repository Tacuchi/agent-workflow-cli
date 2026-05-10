import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeMcpEntry } from "../../src/application/mcp-host-writer.js";
import { buildMcpEntry } from "../../src/domain/mcp-entry.js";

describe("writeMcpEntry — Claude (.mcp.json, project scope)", () => {
  let scopeDir: string;

  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-writer-claude-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("crea .mcp.json inicial con la entrada cert", () => {
    const result = writeMcpEntry("claude", buildMcpEntry("cert"), { scopeDir });
    expect(result.action).toBe("written");
    expect(result.backup).toBeNull();
    const mcpJsonPath = join(scopeDir, ".mcp.json");
    expect(result.target).toBe(mcpJsonPath);
    const content = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(content.mcpServers.cert).toEqual({
      command: "agent-workflow",
      args: ["mcp", "dbhub", "cert"],
      env: { MAX_ROWS: "1000", READONLY: "true", TRANSPORT: "stdio" },
    });
  });

  it("idempotencia: re-ejecutar con misma entrada retorna skipped-idempotent y no crea backup nuevo", () => {
    writeMcpEntry("claude", buildMcpEntry("cert"), { scopeDir });
    const second = writeMcpEntry("claude", buildMcpEntry("cert"), { scopeDir });
    expect(second.action).toBe("skipped-idempotent");
    expect(second.backup).toBeNull();
    const baks = readdirSync(scopeDir).filter((f) => f.startsWith(".mcp.json.bak."));
    expect(baks).toHaveLength(0);
  });

  it("preserva otras entradas existentes en .mcp.json", () => {
    const mcpJsonPath = join(scopeDir, ".mcp.json");
    const initial = {
      mcpServers: { other: { command: "x", args: [], env: {} } },
    };
    writeFileSync(mcpJsonPath, JSON.stringify(initial, null, 2));
    writeMcpEntry("claude", buildMcpEntry("prod"), { scopeDir });
    const content = JSON.parse(readFileSync(mcpJsonPath, "utf-8"));
    expect(content.mcpServers.other).toBeDefined();
    expect(content.mcpServers.prod).toBeDefined();
  });

  it("dry-run no escribe el archivo aunque haya cambios", () => {
    const mcpJsonPath = join(scopeDir, ".mcp.json");
    expect(existsSync(mcpJsonPath)).toBe(false);
    const result = writeMcpEntry("claude", buildMcpEntry("cert"), { scopeDir }, { dryRun: true });
    expect(result.action).toBe("dry-run");
    expect(result.diff).toBeDefined();
    expect(existsSync(mcpJsonPath)).toBe(false);
  });

  it("backup transitorio: tras write OK no quedan .bak.<ts> en disco y result.backup es null", () => {
    const mcpJsonPath = join(scopeDir, ".mcp.json");
    writeFileSync(
      mcpJsonPath,
      JSON.stringify({ mcpServers: { cert: { command: "old", args: [], env: {} } } }, null, 2),
    );
    const result = writeMcpEntry("claude", buildMcpEntry("cert"), { scopeDir });
    expect(result.action).toBe("written");
    expect(result.backup).toBeNull();
    const baks = readdirSync(scopeDir).filter((f) => f.startsWith(".mcp.json.bak."));
    expect(baks).toHaveLength(0);
  });

  it("purga .bak.<ts> históricos al iniciar el write", () => {
    const mcpJsonPath = join(scopeDir, ".mcp.json");
    writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: {} }, null, 2));
    writeFileSync(`${mcpJsonPath}.bak.1`, "stale");
    writeFileSync(`${mcpJsonPath}.bak.99999`, "stale");
    writeMcpEntry("claude", buildMcpEntry("cert"), { scopeDir });
    const baks = readdirSync(scopeDir).filter((f) => f.startsWith(".mcp.json.bak."));
    expect(baks).toHaveLength(0);
  });

  it("limpia entrada legacy en .claude/settings.json al escribir", () => {
    const legacyPath = join(scopeDir, ".claude", "settings.json");
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          permissions: { additionalDirectories: ["/some/path"] },
          mcpServers: { cert: { command: "old", args: [], env: {} } },
        },
        null,
        2,
      ),
    );
    writeMcpEntry("claude", buildMcpEntry("cert"), { scopeDir });
    const legacy = JSON.parse(readFileSync(legacyPath, "utf-8"));
    expect(legacy.permissions.additionalDirectories).toEqual(["/some/path"]);
    expect(legacy.mcpServers).toBeUndefined();
  });

  it("limpia entrada legacy en .claude/settings.json conservando otras entradas mcpServers", () => {
    const legacyPath = join(scopeDir, ".claude", "settings.json");
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          mcpServers: {
            cert: { command: "old", args: [], env: {} },
            keep: { command: "x", args: [], env: {} },
          },
        },
        null,
        2,
      ),
    );
    writeMcpEntry("claude", buildMcpEntry("cert"), { scopeDir });
    const legacy = JSON.parse(readFileSync(legacyPath, "utf-8"));
    expect(legacy.mcpServers.cert).toBeUndefined();
    expect(legacy.mcpServers.keep).toBeDefined();
  });
});

describe("writeMcpEntry — Claude (~/.claude.json, global scope)", () => {
  let scopeDir: string;

  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-writer-claude-global-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("escribe en .claude.json cuando scope.kind=global, preservando otras claves del archivo", () => {
    const claudeJsonPath = join(scopeDir, ".claude.json");
    writeFileSync(claudeJsonPath, JSON.stringify({ numStartups: 42, mcpServers: {} }, null, 2));
    const result = writeMcpEntry("claude", buildMcpEntry("cert"), {
      scopeDir,
      kind: "global",
    });
    expect(result.action).toBe("written");
    expect(result.target).toBe(claudeJsonPath);
    const content = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    expect(content.numStartups).toBe(42);
    expect(content.mcpServers.cert).toBeDefined();
  });
});

describe("writeMcpEntry — Codex (config.toml)", () => {
  let scopeDir: string;

  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-writer-codex-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("crea config.toml inicial con [mcp_servers.cert] y [mcp_servers.cert.env]", () => {
    const result = writeMcpEntry("codex", buildMcpEntry("cert"), { scopeDir });
    expect(result.action).toBe("written");
    const configPath = join(scopeDir, ".codex", "config.toml");
    const text = readFileSync(configPath, "utf-8");
    expect(text).toContain("[mcp_servers.cert]");
    expect(text).toContain("[mcp_servers.cert.env]");
    const parsed = parseToml(text) as Record<string, unknown>;
    const mcp = (parsed.mcp_servers as Record<string, unknown>)?.cert as Record<string, unknown>;
    expect(mcp).toBeDefined();
    expect(mcp.command).toBe("agent-workflow");
    expect(mcp.args).toEqual(["mcp", "dbhub", "cert"]);
    expect(mcp.env).toEqual({ MAX_ROWS: "1000", READONLY: "true", TRANSPORT: "stdio" });
  });

  it("idempotencia en Codex: misma entrada → skipped-idempotent", () => {
    writeMcpEntry("codex", buildMcpEntry("cert"), { scopeDir });
    const second = writeMcpEntry("codex", buildMcpEntry("cert"), { scopeDir });
    expect(second.action).toBe("skipped-idempotent");
    expect(second.backup).toBeNull();
  });

  it("preserva sección anterior no relacionada (additional_writable_roots)", () => {
    const configPath = join(scopeDir, ".codex", "config.toml");
    mkdirSync(join(scopeDir, ".codex"), { recursive: true });
    writeFileSync(configPath, 'additional_writable_roots = [\n  "/path/a",\n  "/path/b"\n]\n');
    writeMcpEntry("codex", buildMcpEntry("prod"), { scopeDir });
    const text = readFileSync(configPath, "utf-8");
    expect(text).toContain("additional_writable_roots");
    expect(text).toContain('"/path/a"');
    expect(text).toContain('"/path/b"');
    expect(text).toContain("[mcp_servers.prod]");
  });

  it("dry-run no escribe config.toml", () => {
    const configPath = join(scopeDir, ".codex", "config.toml");
    expect(existsSync(configPath)).toBe(false);
    const result = writeMcpEntry("codex", buildMcpEntry("prod"), { scopeDir }, { dryRun: true });
    expect(result.action).toBe("dry-run");
    expect(result.diff).toBeDefined();
    expect(existsSync(configPath)).toBe(false);
  });

  it("ambas instancias coexisten en el mismo config.toml", () => {
    writeMcpEntry("codex", buildMcpEntry("cert"), { scopeDir });
    writeMcpEntry("codex", buildMcpEntry("prod"), { scopeDir });
    const configPath = join(scopeDir, ".codex", "config.toml");
    const parsed = parseToml(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const mcp = parsed.mcp_servers as Record<string, unknown>;
    expect(mcp.cert).toBeDefined();
    expect(mcp.prod).toBeDefined();
  });
});
