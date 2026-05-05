import { describe, expect, it } from "vitest";
import { PathsService } from "../../src/application/paths-service.js";
import { normalizeNamespace } from "../../src/runtime/namespace.js";

describe("PathsService", () => {
  const qtcPaths = new PathsService(normalizeNamespace("qtc"), "/home/u", "/cwd");

  it("resolves user-level dirs for namespace 'qtc'", () => {
    expect(qtcPaths.userRoot()).toBe("/home/u/.qtc");
    expect(qtcPaths.userDevDir()).toBe("/home/u/.qtc/dev");
    expect(qtcPaths.userDsnFile()).toBe("/home/u/.qtc/dev/dsn.env");
    expect(qtcPaths.userLogsDir()).toBe("/home/u/.qtc/logs");
    expect(qtcPaths.userLibConfigDir()).toBe("/home/u/.qtc/lib/config");
    expect(qtcPaths.userRuntimeJson()).toBe("/home/u/.qtc/agent-workflow/runtime.json");
    expect(qtcPaths.userConfigMd()).toBe("/home/u/.qtc/user-config.md");
  });

  it("resolves cwd-level dirs for namespace 'qtc'", () => {
    expect(qtcPaths.cwdRoot()).toBe("/cwd/.qtc");
    expect(qtcPaths.cwdSessionsDir()).toBe("/cwd/.qtc/sessions");
    expect(qtcPaths.cwdHistoryFile()).toBe("/cwd/.qtc/HISTORY.md");
    expect(qtcPaths.cwdLogsDir()).toBe("/cwd/.qtc/logs");
    expect(qtcPaths.cwdLogFile()).toBe("/cwd/.qtc/logs/agent-workflow.log");
  });

  it("uses different namespace correctly", () => {
    const ps = new PathsService(normalizeNamespace("agent-workflow"), "/home/u", "/cwd");
    expect(ps.userRoot()).toBe("/home/u/.agent-workflow");
    expect(ps.cwdSessionsDir()).toBe("/cwd/.agent-workflow/sessions");
  });

  it("blockMarkers returns parametric markers", () => {
    expect(qtcPaths.blockMarkers()).toEqual({
      start: "<!-- QTC-PROJECT-START -->",
      end: "<!-- QTC-PROJECT-END -->",
    });
    const ps = new PathsService(normalizeNamespace("agent-workflow"), "/h", "/c");
    expect(ps.blockMarkers()).toEqual({
      start: "<!-- AGENT-WORKFLOW-PROJECT-START -->",
      end: "<!-- AGENT-WORKFLOW-PROJECT-END -->",
    });
  });

  it("namespace getter returns the underlying value", () => {
    expect(qtcPaths.namespace).toBe("qtc");
  });

  it("resolves user plugin version file per flow", () => {
    expect(qtcPaths.userPluginVersionFile("dev")).toBe("/home/u/.qtc/dev/.plugin-version");
    expect(qtcPaths.userPluginVersionFile("design")).toBe("/home/u/.qtc/design/.plugin-version");
  });

  it("resolves user core-lib version marker", () => {
    expect(qtcPaths.userCoreLibMarker()).toBe("/home/u/.qtc/lib/.qtc-core-version");
    const ps = new PathsService(normalizeNamespace("agent-workflow"), "/home/u", "/cwd");
    expect(ps.userCoreLibMarker()).toBe("/home/u/.agent-workflow/lib/.agent-workflow-core-version");
  });
});
