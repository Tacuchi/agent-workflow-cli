import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  crushGlobalMcpFile,
  opencodeGlobalMcpFile,
  xdgConfigBase,
} from "../../src/application/mcp-host-paths.js";
import { readMcpEntry } from "../../src/application/mcp-host-reader.js";
import { writeMcpEntry } from "../../src/application/mcp-host-writer.js";
import { resolveHosts } from "../../src/cli/commands/mcp.js";
import type { ParsedArgs } from "../../src/cli/parser.js";
import type { CliContext } from "../../src/cli/types.js";
import { HARNESSES, MCP_FILE_HOSTS } from "../../src/domain/harnesses.js";
import { buildMcpEntry } from "../../src/domain/mcp-entry.js";

const HOME = "/home/u";
const TEST_NODE = "/opt/workline/node";
const TEST_ENTRYPOINT = "/opt/workline/dist/cli/main.js";

function testEntry(host: "opencode" | "crush" | "warp") {
  return buildMcpEntry("alpha", "ALPHA_DATABASE_URL", {
    nodePath: TEST_NODE,
    entrypoint: TEST_ENTRYPOINT,
    host,
    scope: "global",
    namespace: "tenant-a",
  });
}

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
    expect(crushGlobalMcpFile(HOME, "linux", {})).toBe(
      join(HOME, ".config", "crush", "crush.json"),
    );
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
    expect(crush?.globalMcpPaths?.win32).toContain("%LOCALAPPDATA%");
    expect(opencode?.globalMcpPaths?.win32).toBe("~/.config/opencode/opencode.json");
  });
});

describe("buildMcpEntry — descriptor fiable", () => {
  it("usa Node y entrypoint absolutos, sin PATH, shell, npx ni DSN", () => {
    const entry = buildMcpEntry("alpha", "ALPHA_DATABASE_URL", {
      nodePath: TEST_NODE,
      entrypoint: TEST_ENTRYPOINT,
      host: "codex",
      scope: "global",
      namespace: "tenant-a",
      descriptorGeneration: "23.0.0",
    });

    expect(entry.command).toBe(TEST_NODE);
    expect(isAbsolute(entry.command)).toBe(true);
    expect(entry.args).toEqual([
      TEST_ENTRYPOINT,
      "mcp",
      "serve-db",
      "--namespace",
      "tenant-a",
      "--instance",
      "alpha",
      "--host",
      "codex",
      "--scope",
      "global",
      "--descriptor-generation",
      "23.0.0",
    ]);
    expect(isAbsolute(entry.args[0] ?? "")).toBe(true);
    expect(entry.env).toEqual({});
    expect(entry.optional).toBe(true);
    expect(entry.command).not.toContain("npx");
    expect(entry.args).not.toContain("dbhub");
  });

  it("mantiene el descriptor workspace portable dependiente de PATH en Windows", () => {
    const workspaceEntry = buildMcpEntry("alpha", "ALPHA_DATABASE_URL", "win32");
    expect(workspaceEntry.command).toBe("cmd");
    expect(workspaceEntry.args).toEqual(
      expect.arrayContaining(["/c", "agent-workflow", "mcp", "serve-db", "--scope", "workspace"]),
    );
    expect(workspaceEntry.args[0]).not.toBe(TEST_ENTRYPOINT);
  });

  it("rechaza rutas relativas en un descriptor global", () => {
    expect(() =>
      buildMcpEntry("alpha", "ALPHA_DATABASE_URL", {
        nodePath: "node",
        entrypoint: "dist/cli/main.js",
        host: "codex",
        scope: "global",
      }),
    ).toThrow("requieren Node y entrypoint absolutos");
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
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
    Reflect.deleteProperty(process.env, "CRUSH_GLOBAL_CONFIG");
  });

  afterEach(() => {
    rmSync(scopeDir, { recursive: true, force: true });
    if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
    else Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
    if (savedCrushCfg !== undefined) process.env.CRUSH_GLOBAL_CONFIG = savedCrushCfg;
    else Reflect.deleteProperty(process.env, "CRUSH_GLOBAL_CONFIG");
  });

  it("opencode global honors XDG_CONFIG_HOME end-to-end (writer and reader agree)", () => {
    process.env.XDG_CONFIG_HOME = join(scopeDir, "xdg");
    const entry = testEntry("opencode");
    const result = writeMcpEntry("opencode", entry, { scopeDir, kind: "global" });
    expect(result.action).toBe("written");
    expect(result.target).toBe(join(scopeDir, "xdg", "opencode", "opencode.json"));

    const snapshot = readMcpEntry("opencode", scopeDir, entry.name, "global");
    expect(snapshot.exists).toBe(true);
    expect(snapshot.command).toBe(entry.command);
  });

  it("crush global (unix default path) round-trips writer↔reader", () => {
    const entry = testEntry("crush");
    const result = writeMcpEntry("crush", entry, { scopeDir, kind: "global" });
    expect(result.target).toBe(join(scopeDir, ".config", "crush", "crush.json"));
    expect(JSON.parse(readFileSync(result.target, "utf8")).mcp[entry.name]).toBeTruthy();

    const snapshot = readMcpEntry("crush", scopeDir, entry.name, "global");
    expect(snapshot.exists).toBe(true);
  });

  it("warp global round-trips writer↔reader on the registry path for this platform", () => {
    const entry = testEntry("warp");
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
    return {
      env: { get: (k: string) => vars[k], homeDir: () => HOME, cwd: () => "/cwd" },
    } as unknown as CliContext;
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

  // INVERTIDO A PROPÓSITO. Antes, un harness sin archivo de configuración MCP
  // (oz) hacía fan-out a TODOS los hosts: escribía en configuraciones que el
  // usuario nunca eligió por no poder decidir en cuál estaba. Ahora pide el
  // destino.
  it("harness sin mcpHostId (oz) sin --host: pide el host en vez de escribir en todos", () => {
    const result = resolveHosts(argsNoHost(), ctxWithEnv({ OZ_RUN_ID: "1" }));
    if ("value" in result) throw new Error("expected a refusal, got a host list");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HOST_REQUIRED");
    expect(result.error?.message).toMatch(/--host/);
    expect(result.error?.message).toMatch(/detect-hosts/);
  });

  it("harness sin marcadores de entorno (kimi) sin --host: misma negativa instructiva", () => {
    const result = resolveHosts(argsNoHost(), ctxWithEnv({}));
    if ("value" in result) throw new Error("expected a refusal, got a host list");
    expect(result.error?.code).toBe("HOST_REQUIRED");
    expect(result.error?.message).toMatch(/no exporta marcadores/);
  });

  it("--host all sigue siendo la forma EXPLÍCITA de abarcar todos los hosts", () => {
    const args: ParsedArgs = {
      rest: [],
      plugin: {},
      flags: new Set(),
      values: new Map([["host", "all"]]),
      valuesMulti: new Map(),
    };
    const result = resolveHosts(args, ctxWithEnv({}));
    if (!("value" in result)) throw new Error("expected value");
    expect(result.value.length).toBe(MCP_FILE_HOSTS.length);
  });
});
