import { describe, expect, it } from "vitest";
import { buildOpenCommand } from "../../src/application/open-external.js";

describe("open-external — per-OS command", () => {
  const path = "/home/u/.agent-workflow/logs/agent-workflow-2026-07-01.log";

  it("macOS: default opens in the default TEXT editor (open -t)", () => {
    expect(buildOpenCommand("darwin", { path })).toEqual({ cmd: "open", args: ["-t", path] });
  });

  it("macOS: with an app uses open -a <App>", () => {
    expect(buildOpenCommand("darwin", { path, app: "Visual Studio Code" })).toEqual({
      cmd: "open",
      args: ["-a", "Visual Studio Code", path],
    });
  });

  it("Windows: default uses cmd /c start with an empty title", () => {
    expect(buildOpenCommand("win32", { path })).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", path],
    });
  });

  it("Windows: with an app passes the app before the path", () => {
    expect(buildOpenCommand("win32", { path, app: "notepad" })).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", "notepad", path],
    });
  });

  it("Linux: default uses xdg-open", () => {
    expect(buildOpenCommand("linux", { path })).toEqual({ cmd: "xdg-open", args: [path] });
  });

  it("Linux: with an app runs <app> <path>", () => {
    expect(buildOpenCommand("linux", { path, app: "gedit" })).toEqual({
      cmd: "gedit",
      args: [path],
    });
  });

  it("unknown platform falls back to xdg-open (best effort)", () => {
    expect(buildOpenCommand("aix", { path })).toEqual({ cmd: "xdg-open", args: [path] });
  });
});
