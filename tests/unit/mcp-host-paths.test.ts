import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  crushGlobalMcpFile,
  opencodeGlobalMcpFile,
  xdgConfigBase,
} from "../../src/application/mcp-host-paths.js";
import { HARNESSES } from "../../src/domain/harnesses.js";

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
