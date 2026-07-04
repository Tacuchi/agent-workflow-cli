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
          // Shape from this tool's legacy era (dbhub) — it IS ours.
          mcpServers: { cert: { command: "npx", args: ["-y", "@bytebase/dbhub"], env: {} } },
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
            cert: { command: "npx", args: ["-y", "@bytebase/dbhub"], env: {} },
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

  it("legacy cleanup conserva una entrada homónima ajena (guard de ownership)", () => {
    // Same name 'cert', but the server is the user's (mentions neither dbhub nor
    // agent-workflow): at global scope that file is the real ~/.claude/settings.json.
    const legacyPath = join(scopeDir, ".claude", "settings.json");
    mkdirSync(join(scopeDir, ".claude"), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify(
        { mcpServers: { cert: { command: "node", args: ["my-cert-server.js"], env: {} } } },
        null,
        2,
      ),
    );
    writeMcpEntry("claude", buildMcpEntry("cert"), { scopeDir });
    const legacy = JSON.parse(readFileSync(legacyPath, "utf-8"));
    expect(legacy.mcpServers.cert.args).toEqual(["my-cert-server.js"]);
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

describe("writeMcpEntry — Warp (.warp/.mcp.json, project scope)", () => {
  let scopeDir: string;

  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-writer-warp-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("crea .warp/.mcp.json inicial con mcpServers.cert", () => {
    const result = writeMcpEntry("warp", buildMcpEntry("cert"), { scopeDir });
    expect(result.action).toBe("written");
    expect(result.host).toBe("warp");
    const mcpPath = join(scopeDir, ".warp", ".mcp.json");
    expect(result.target).toBe(mcpPath);
    const content = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(content.mcpServers.cert).toEqual({
      command: "agent-workflow",
      args: ["mcp", "dbhub", "cert"],
      env: { MAX_ROWS: "1000", READONLY: "true", TRANSPORT: "stdio" },
    });
  });

  it("idempotencia: segunda corrida retorna skipped-idempotent", () => {
    writeMcpEntry("warp", buildMcpEntry("cert"), { scopeDir });
    const second = writeMcpEntry("warp", buildMcpEntry("cert"), { scopeDir });
    expect(second.action).toBe("skipped-idempotent");
    expect(second.backup).toBeNull();
  });

  it("preserva otras entradas existentes en .warp/.mcp.json", () => {
    const mcpPath = join(scopeDir, ".warp", ".mcp.json");
    mkdirSync(join(scopeDir, ".warp"), { recursive: true });
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { other: { command: "x", args: [], env: {} } } }, null, 2),
    );
    writeMcpEntry("warp", buildMcpEntry("prod"), { scopeDir });
    const content = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(content.mcpServers.other).toBeDefined();
    expect(content.mcpServers.prod).toBeDefined();
  });

  it("dry-run no escribe el archivo", () => {
    const mcpPath = join(scopeDir, ".warp", ".mcp.json");
    expect(existsSync(mcpPath)).toBe(false);
    const result = writeMcpEntry("warp", buildMcpEntry("cert"), { scopeDir }, { dryRun: true });
    expect(result.action).toBe("dry-run");
    expect(result.diff).toBeDefined();
    expect(existsSync(mcpPath)).toBe(false);
  });

  it("cert y prod coexisten en .warp/.mcp.json", () => {
    writeMcpEntry("warp", buildMcpEntry("cert"), { scopeDir });
    writeMcpEntry("warp", buildMcpEntry("prod"), { scopeDir });
    const content = JSON.parse(readFileSync(join(scopeDir, ".warp", ".mcp.json"), "utf-8"));
    expect(content.mcpServers.cert).toBeDefined();
    expect(content.mcpServers.prod).toBeDefined();
  });
});

describe("writeMcpEntry — Gemini (.gemini/settings.json, mcpServers)", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-writer-gemini-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("crea .gemini/settings.json con mcpServers.cert (shape command/args/env)", () => {
    const result = writeMcpEntry("gemini", buildMcpEntry("cert"), { scopeDir });
    expect(result.action).toBe("written");
    expect(result.host).toBe("gemini");
    const file = join(scopeDir, ".gemini", "settings.json");
    expect(result.target).toBe(file);
    const content = JSON.parse(readFileSync(file, "utf-8"));
    expect(content.mcpServers.cert).toEqual({
      command: "agent-workflow",
      args: ["mcp", "dbhub", "cert"],
      env: { MAX_ROWS: "1000", READONLY: "true", TRANSPORT: "stdio" },
    });
  });

  it("idempotencia: segunda corrida → skipped-idempotent", () => {
    writeMcpEntry("gemini", buildMcpEntry("cert"), { scopeDir });
    const second = writeMcpEntry("gemini", buildMcpEntry("cert"), { scopeDir });
    expect(second.action).toBe("skipped-idempotent");
  });

  it("preserva otras claves de settings.json (no solo mcpServers)", () => {
    const file = join(scopeDir, ".gemini", "settings.json");
    mkdirSync(join(scopeDir, ".gemini"), { recursive: true });
    writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: {} }, null, 2));
    writeMcpEntry("gemini", buildMcpEntry("prod"), { scopeDir });
    const content = JSON.parse(readFileSync(file, "utf-8"));
    expect(content.theme).toBe("dark");
    expect(content.mcpServers.prod).toBeDefined();
  });

  it("dry-run no escribe", () => {
    const file = join(scopeDir, ".gemini", "settings.json");
    const result = writeMcpEntry("gemini", buildMcpEntry("cert"), { scopeDir }, { dryRun: true });
    expect(result.action).toBe("dry-run");
    expect(existsSync(file)).toBe(false);
  });
});

describe("writeMcpEntry — OpenCode (opencode.json, mcp: type local)", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-writer-opencode-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("crea opencode.json con mcp.cert (type local, command array, environment)", () => {
    const result = writeMcpEntry("opencode", buildMcpEntry("cert"), { scopeDir });
    expect(result.action).toBe("written");
    expect(result.host).toBe("opencode");
    const file = join(scopeDir, "opencode.json");
    expect(result.target).toBe(file);
    const content = JSON.parse(readFileSync(file, "utf-8"));
    expect(content.mcp.cert).toEqual({
      type: "local",
      command: ["agent-workflow", "mcp", "dbhub", "cert"],
      environment: { MAX_ROWS: "1000", READONLY: "true", TRANSPORT: "stdio" },
      enabled: true,
    });
  });

  it("idempotencia: segunda corrida → skipped-idempotent", () => {
    writeMcpEntry("opencode", buildMcpEntry("cert"), { scopeDir });
    const second = writeMcpEntry("opencode", buildMcpEntry("cert"), { scopeDir });
    expect(second.action).toBe("skipped-idempotent");
  });

  it("preserva otras claves + otras entradas mcp", () => {
    const file = join(scopeDir, "opencode.json");
    writeFileSync(
      file,
      JSON.stringify({ model: "x", mcp: { other: { type: "local", command: ["y"] } } }, null, 2),
    );
    writeMcpEntry("opencode", buildMcpEntry("prod"), { scopeDir });
    const content = JSON.parse(readFileSync(file, "utf-8"));
    expect(content.model).toBe("x");
    expect(content.mcp.other).toBeDefined();
    expect(content.mcp.prod).toBeDefined();
  });

  it("dry-run no escribe", () => {
    const file = join(scopeDir, "opencode.json");
    const result = writeMcpEntry("opencode", buildMcpEntry("cert"), { scopeDir }, { dryRun: true });
    expect(result.action).toBe("dry-run");
    expect(existsSync(file)).toBe(false);
  });

  it("scope global → ~/.config/opencode/opencode.json (XDG)", () => {
    const result = writeMcpEntry("opencode", buildMcpEntry("cert"), {
      scopeDir,
      kind: "global",
    });
    expect(result.target).toBe(join(scopeDir, ".config", "opencode", "opencode.json"));
    const content = JSON.parse(readFileSync(result.target, "utf-8"));
    expect(content.mcp.cert.type).toBe("local");
  });
});

describe("writeMcpEntry — Crush (crush.json, mcp: type stdio)", () => {
  let scopeDir: string;
  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "mcp-writer-crush-"));
  });
  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
  });

  it("crea crush.json con mcp.cert (type stdio, command/args/env)", () => {
    const result = writeMcpEntry("crush", buildMcpEntry("cert"), { scopeDir });
    expect(result.action).toBe("written");
    expect(result.host).toBe("crush");
    const file = join(scopeDir, "crush.json");
    expect(result.target).toBe(file);
    const content = JSON.parse(readFileSync(file, "utf-8"));
    expect(content.mcp.cert).toEqual({
      type: "stdio",
      command: "agent-workflow",
      args: ["mcp", "dbhub", "cert"],
      env: { MAX_ROWS: "1000", READONLY: "true", TRANSPORT: "stdio" },
    });
  });

  it("idempotencia: segunda corrida → skipped-idempotent", () => {
    writeMcpEntry("crush", buildMcpEntry("cert"), { scopeDir });
    const second = writeMcpEntry("crush", buildMcpEntry("cert"), { scopeDir });
    expect(second.action).toBe("skipped-idempotent");
  });

  it("preserva $schema + otras entradas mcp", () => {
    const file = join(scopeDir, "crush.json");
    writeFileSync(
      file,
      JSON.stringify(
        {
          $schema: "https://charm.land/crush.json",
          mcp: { other: { type: "stdio", command: "y" } },
        },
        null,
        2,
      ),
    );
    writeMcpEntry("crush", buildMcpEntry("prod"), { scopeDir });
    const content = JSON.parse(readFileSync(file, "utf-8"));
    expect(content.$schema).toBe("https://charm.land/crush.json");
    expect(content.mcp.other).toBeDefined();
    expect(content.mcp.prod).toBeDefined();
  });

  it("dry-run no escribe", () => {
    const file = join(scopeDir, "crush.json");
    const result = writeMcpEntry("crush", buildMcpEntry("cert"), { scopeDir }, { dryRun: true });
    expect(result.action).toBe("dry-run");
    expect(existsSync(file)).toBe(false);
  });

  it("scope global → ~/.config/crush/crush.json (XDG)", () => {
    const result = writeMcpEntry("crush", buildMcpEntry("cert"), { scopeDir, kind: "global" });
    expect(result.target).toBe(join(scopeDir, ".config", "crush", "crush.json"));
    const content = JSON.parse(readFileSync(result.target, "utf-8"));
    expect(content.mcp.cert.type).toBe("stdio");
  });
});
