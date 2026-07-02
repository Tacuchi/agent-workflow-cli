import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWarpGlobalMcpPath } from "../../src/application/multiroot/warp.js";

describe("resolveWarpGlobalMcpPath — win32", () => {
  let savedLocalAppData: string | undefined;

  beforeEach(() => {
    savedLocalAppData = process.env.LOCALAPPDATA;
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: env var must be truly unset (assigning undefined stringifies to "undefined").
    if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = savedLocalAppData;
  });

  it("stable channel expands %LOCALAPPDATA% when set", () => {
    process.env.LOCALAPPDATA = "C:\\Users\\me\\AppData\\Local";
    const p = resolveWarpGlobalMcpPath("win32", "stable", () => "C:\\Users\\me");
    expect(p).toBe("C:\\Users\\me\\AppData\\Local/warp/Warp/config/.mcp.json");
  });

  it("preview channel resolves the WarpPreview path", () => {
    process.env.LOCALAPPDATA = "C:\\Users\\me\\AppData\\Local";
    const p = resolveWarpGlobalMcpPath("win32", "preview", () => "C:\\Users\\me");
    expect(p).toBe("C:\\Users\\me\\AppData\\Local/warp/WarpPreview/config/.mcp.json");
  });

  it("falls back to <home>/AppData/Local when %LOCALAPPDATA% is unset", () => {
    // biome-ignore lint/performance/noDelete: env var must be truly unset for the fallback branch.
    delete process.env.LOCALAPPDATA;
    const home = "C:\\Users\\me";
    const p = resolveWarpGlobalMcpPath("win32", "stable", () => home);
    expect(p).toBe(`${join(home, "AppData", "Local")}/warp/Warp/config/.mcp.json`);
  });
});
