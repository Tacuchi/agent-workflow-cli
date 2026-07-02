import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  crushGlobalMcpFile,
  opencodeGlobalMcpFile,
  xdgConfigBase,
} from "../../src/application/mcp-host-paths.js";
import { readMcpEntry } from "../../src/application/mcp-host-reader.js";
import { writeMcpEntry } from "../../src/application/mcp-host-writer.js";
import { HARNESSES } from "../../src/domain/harnesses.js";
import { buildMcpEntry } from "../../src/domain/mcp-entry.js";
import { resolveHosts } from "../../src/cli/commands/mcp.js";
import type { CliContext } from "../../src/cli/types.js";
import type { ParsedArgs } from "../../src/cli/parser.js";

const HOME = "/home/u";

describe("mcp-host-paths — global config resolution (writer/reader/detect single source)", () => {
  it("xdgConfigBase honors XDG_CONFIG_HOME and falls back to ~/.config", () => {
    expect(xdgConfigBase(HOME, { XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg");
    expect(xdgConfigBase(HOME, {})).toBe(join(HOME, ".config"));
  });

  it("opencode: ~/.config on every platform (native Windows too), XDG override wins", () => {
    expect(opencodeGlobalMcpFile(HOME, {})).toBe(
      join(HOME, ".config", "opencode", "opencode.json"),
    );
    expect(opencodeGlobalMcpFile(HOME, { XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "opencode", "opencode.json"),
    );
  });

  it("crush: XDG on unix, %LOCALAPPDATA% on win32, CRUSH_GLOBAL_CONFIG overrides all", () => {
    expect(crushGlobalMcpFile(HOME, "linux", {})).toBe(join(HOME, ".config", "crush", "crush.json"));
    expect(crushGlobalMcpFile(HOME, "win32", { LOCALAPPDATA: "C:/Users/u/AppData/Local" })).toBe(
      join("C:/Users/u/AppData/Local", "crush", "crush.json"),
    );
    expect(crushGlobalMcpFile(HOME, "win32", {})).toBe(
      join(HOME, "AppData", "Local", "crush", "crush.json"),
    );
    expect(crushGlobalMcpFile(HOME, "linux", { CRUSH_GLOBAL_CONFIG: "/etc/crush.json" })).toBe(
      "/etc/crush.json",
    );
  });

  it("registry: crush win32 global points to %LOCALAPPDATA%, opencode stays ~/.config", () => {
    const crush = HARNESSES.find((h) => h.id === "crush");
    const opencode = HARNESSES.find((h) => h.id === "opencode");
    expect(crush?.globalMcpPaths?.win32.stable).toContain("%LOCALAPPDATA%");
    expect(opencode?.globalMcpPaths?.win32.stable).toBe("~/.config/opencode/opencode.json");
  });
});

describe("buildMcpEntry — Windows cmd shim", () => {
  it("posix keeps the plain bin; win32 wraps in cmd /c (npm bin is a .cmd shim)", () => {
    const posix = buildMcpEntry("cert", undefined, "darwin");
    expect(posix.command).toBe("agent-workflow");
    expect(posix.args).toEqual(["mcp", "dbhub", "cert"]);

    const win = buildMcpEntry("cert", undefined, "win32");
    expect(win.command).toBe("cmd");
    expect(win.args).toEqual(["/c", "agent-workflow", "mcp", "dbhub", "cert"]);
  });
});

describe("global-scope round-trip write↔read (opencode/crush with XDG)", () => {
  let scopeDir: string;
  let savedXdg: string | undefined;
  let savedCrushCfg: string | undefined;

  beforeEach(() => {
    scopeDir = mkdtempSync(join(tmpdir(), "aw-mcp-global-"));
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedCrushCfg = process.env.CRUSH_GLOBAL_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.CRUSH_GLOBAL_CONFIG;
  });

  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
    if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
    else delete process.env.XDG_CONFIG_HOME;
    if (savedCrushCfg !== undefined) process.env.CRUSH_GLOBAL_CONFIG = savedCrushCfg;
    else delete process.env.CRUSH_GLOBAL_CONFIG;
  });

  it("opencode global honors XDG_CONFIG_HOME end-to-end (writer and reader agree)", () => {
    process.env.XDG_CONFIG_HOME = join(scopeDir, "xdg");
    const entry = buildMcpEntry("cert", undefined, "darwin");
    const result = writeMcpEntry("opencode", entry, { scopeDir, kind: "global" });
    expect(result.action).toBe("written");
    expect(result.target).toBe(join(scopeDir, "xdg", "opencode", "opencode.json"));

    const snapshot = readMcpEntry("opencode", scopeDir, entry.name, "global");
    expect(snapshot.exists).toBe(true);
    expect(snapshot.command).toBe(entry.command);
  });

  it("crush global (unix default path) round-trips writer↔reader", () => {
    const entry = buildMcpEntry("cert", undefined, "darwin");
    const result = writeMcpEntry("crush", entry, { scopeDir, kind: "global" });
    expect(result.target).toBe(join(scopeDir, ".config", "crush", "crush.json"));
    expect(JSON.parse(readFileSync(result.target, "utf8")).mcp[entry.name]).toBeTruthy();

    const snapshot = readMcpEntry("crush", scopeDir, entry.name, "global");
    expect(snapshot.exists).toBe(true);
  });

  it("warp global round-trips writer↔reader on the registry path for this platform", () => {
    const entry = buildMcpEntry("cert", undefined, "darwin");
    const result = writeMcpEntry("warp", entry, { scopeDir, kind: "global" });
    const snapshot = readMcpEntry("warp", scopeDir, entry.name, "global");
    expect(snapshot.target).toBe(result.target);
    expect(snapshot.exists).toBe(true);
  });
});

describe("resolveHosts — host anfitrión data-driven desde el registro", () => {
  function argsNoHost(): ParsedArgs {
    return { rest: [], plugin: {}, flags: new Set(), values: new Map(), valuesMulti: new Map() };
  }
  function ctxWithEnv(vars: Record<string, string>): CliContext {
    return { env: { get: (k: string) => vars[k], homeDir: () => HOME, cwd: () => "/cwd" } } as unknown as CliContext;
  }

  it("cada harness con mcpHostId resuelve SOLO su propio host (sin fan-out)", () => {
    for (const spec of HARNESSES) {
      if (!spec.mcpHostId || spec.envMarkers.length === 0) continue;
      const marker = spec.envMarkers[0] as string;
      const result = resolveHosts(argsNoHost(), ctxWithEnv({ [marker]: "1" }));
      expect(result, `harness ${spec.id}`).toHaveProperty("value");
      if ("value" in result) expect(result.value, `harness ${spec.id}`).toEqual([spec.mcpHostId]);
    }
  });

  it("harness sin mcpHostId (oz) cae al fan-out completo", () => {
    // runHarness tiene fallback por filesystem (detecta ~/.codex real de la
    // máquina), así que el caso determinístico de fan-out es un harness
    // detectado SIN archivo de config MCP propio: oz.
    const result = resolveHosts(argsNoHost(), ctxWithEnv({ OZ_RUN_ID: "1" }));
    if (!("value" in result)) throw new Error("expected value");
    expect(result.value.length).toBeGreaterThanOrEqual(6);
  });
});
